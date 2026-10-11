(ns swu.policy
  "Picks an action for every kind of prompt.

  Action windows: every legal action is played on the board model (swu.board), the opponent answers with its best
  attacks in a short alpha-beta search, and the move with the best result wins. Hand cards are first filtered by a
  knapsack over this round's ready resources, so a cheap card does not block a better pair. Other prompts (targets,
  resources, splits, menus) use small rules over the same model. A loop guard never repeats a choice that led
  straight back to the same observation."
  (:require [clojure.string :as str]
            [swu.board :as b]
            [swu.cards :as cards]))

(def ^:dynamic *depth*
  "Plies searched after our own move (the opponent moves first)."
  (or (some-> (System/getenv "SWU_CLJ_DEPTH") parse-long) 3))

;; ---------------------------------------------------------------------------------------------------------------
;; Context

(defn new-game [db hello]
  {:db db :me (keyword (:you hello)) :guard {} :plan nil :round nil :cancelled #{}})

(defn- akey [a] [(:kind a) (:label a) (:cardUuid a) (:arg a)])

(defn- lower [s] (str/lower-case (or s "")))

(defn context [bot msg actions]
  (let [db     (:db bot)
        me     (:me bot)
        op     (b/other me)
        state  (:state msg)
        my     (get-in state [:players me])
        prompt (:prompt msg)
        aspects (vec (mapcat #(:aspects (cards/lookup db %)) [(:leader my) (:base my)]))]
    {:db db :me me :op op :state state :my my :theirs (get-in state [:players op])
     :prompt prompt :title (lower (:title prompt)) :source (lower (:promptTitle prompt))
     :source-card (get-in db [:by-title (:promptTitle prompt)])
     :actions actions :model (b/from-state db state me) :aspects aspects :plan (:plan bot) :seq (:seq msg)
     :cancelled (:cancelled bot)}))

(defn- card-of [ctx a] (cards/lookup (:db ctx) (assoc (:card a) :label (:label a))))
(defn- mine? [ctx a] (= (name (:me ctx)) (get-in a [:card :ctl])))
(defn- zone [a] (get-in a [:card :zone]))
(defn- buttons [ctx] (filter #(= "button" (:kind %)) (:actions ctx)))
(defn- button [ctx arg-or-label]
  (some #(when (or (= arg-or-label (:arg %)) (= arg-or-label (:label %))) %) (buttons ctx)))
(defn- card-actions [ctx] (filter #(= "card" (:kind %)) (:actions ctx)))
(defn- has-any? [text words] (some #(str/includes? text %) words))

(defn- eff-cost
  "Cost with the aspect penalty; Smuggle cost when played from resources."
  [ctx card from-resource?]
  (let [base (if from-resource?
               (or (some-> (re-find #"smuggle \[(\d+)" (:text card)) second parse-long) (+ 2 (:cost card)))
               (:cost card))]
    (+ base (cards/aspect-penalty card (:aspects ctx)))))

(defn keep-score
  "How much we want to keep a hand card rather than resource or discard it (higher = keep)."
  [ctx card]
  (if-not card
    0.0
    (let [pen   (cards/aspect-penalty card (:aspects ctx))
          eff   (+ (:cost card) pen)
          total (get-in ctx [:my :res :total] 0)]
      (+ (if (cards/is? card "unit") 1.5 0.5)
         (if (<= eff (+ total 2)) 1.5 0.0)
         (if (> eff (+ total 4)) -1.5 0.0)
         (- pen)
         (* -0.15 (:cost card))))))

;; ---------------------------------------------------------------------------------------------------------------
;; Action window

(defn- after [m] (b/reply-value m *depth*))

(defn- attack-candidate [ctx a u]
  (let [m (:model ctx)
        options (for [t (b/attack-targets m u)]
                  {:target t :value (after (assoc (b/attack m (:id u) t) :passes 0))})]
    (when (seq options)
      (let [best (apply max-key :value options)]
        {:action a :kind :attack :value (+ 0.05 (:value best))
         :plan {:attack {:attacker (:id u) :target (:target best)}}}))))

(defn- window-candidate* [ctx a]
  (let [m    (:model ctx)
        me   (:me ctx)
        c    (:card a)
        id   (:id c)
        my-side (get-in m [:sides me])]
    (case (:kind a)
      "button"
      (case (:arg a)
        "pass" {:action a :kind :pass :value (after (assoc m :passes 1))}
        "claimInitiative" {:action a :kind :claim}
        {:action a :kind :other :value (- (after (assoc m :passes 0)) 0.2)})

      "card"
      (let [z (zone a)]
        (cond
          (and (mine? ctx a) (#{"hand" "resource"} z))
          (when-let [card (card-of ctx a)]
            (let [cost (eff-cost ctx card (= "resource" z))]
              (when-let [m' (b/play-card m me card id cost)]
                {:action a :kind :play :card card :cost cost :board m'})))

          (and (mine? ctx a) (#{"groundArena" "spaceArena"} z))
          (let [u (b/unit m id)]
            (cond
              (and u (:ready u) (pos? (b/attack-power u))) (attack-candidate ctx a u)
              :else {:action a :kind :ability :value (- (after (b/add-misc (assoc m :passes 0) me 0.8)) 0.1)}))

          (= id (get-in ctx [:my :leader :id]))
          (let [lc    (cards/lookup (:db ctx) (get-in ctx [:my :leader]))
                ready (not= 1 (get-in ctx [:my :leader :x]))]
            (if (and lc ready (zero? (get-in ctx [:my :leader :dep] 0)) (>= (:total-res my-side) (:cost lc)))
              {:action a :kind :deploy :value (+ 0.2 (after (assoc (b/deploy-leader m me lc) :passes 0)))
               :plan {:leader :deploy}}
              {:action a :kind :ability :value (- (after (b/add-misc (assoc m :passes 0) me 1.0)) 0.1)
               :plan {:leader :ability}}))

          :else
          {:action a :kind :ability :value (- (after (b/add-misc (assoc m :passes 0) me 0.6)) 0.15)}))

      nil)))

(defn- window-candidate
  "A scored option for one action-window action, or nil. Cards whose prompt we cancelled this round are skipped."
  [ctx a]
  (let [id (get-in a [:card :id])]
    (when-not (and id (contains? (:cancelled ctx) id))
      (when-let [c (window-candidate* ctx a)]
        (cond-> c id (update :plan assoc :clicked id))))))

(defn- knapsack
  "Ids of the hand plays to make this round: the set with the largest total gain whose costs fit the budget."
  [plays budget]
  (let [plays (vec (take 12 (sort-by (comp - :gain) (filter #(pos? (:gain %)) plays))))
        n     (count plays)]
    (loop [mask 1 best-v 0.0 best-mask 0]
      (if (>= mask (bit-shift-left 1 n))
        (set (for [k (range n) :when (bit-test best-mask k)] (get-in plays [k :action :cardUuid])))
        (let [[cost v] (reduce (fn [[c v] k] (if (bit-test mask k) [(+ c (:cost (plays k))) (+ v (:gain (plays k)))] [c v]))
                               [0 0.0] (range n))]
          (if (and (<= cost budget) (> v best-v))
            (recur (inc mask) v mask)
            (recur (inc mask) best-v best-mask)))))))

(defn- idle?
  "Nothing left to do this round: no ready unit that can attack and no card we could play."
  [ctx]
  (let [m (:model ctx)]
    (and (empty? (b/attacks m (:me ctx)))
         (not-any? #(and (mine? ctx %) (#{"hand" "resource"} (zone %))) (card-actions ctx)))))

(defn window-choice [ctx]
  (let [m      (:model ctx)
        cands  (keep #(window-candidate ctx %) (:actions ctx))
        base-v (b/evaluate m)
        plays  (map #(assoc % :gain (- (b/evaluate (:board %)) base-v)) (filter #(= :play (:kind %)) cands))
        chosen (knapsack plays (get-in m [:sides (:me ctx) :ready-res]))
        plays  (if (seq chosen) (filter #(chosen (get-in % [:action :cardUuid])) plays) plays)
        scored (concat (map #(assoc % :value (+ 0.1 (after (assoc (:board %) :passes 0)))) plays)
                       (filter :value (remove #(#{:play :claim} (:kind %)) cands)))
        best   (when (seq scored) (apply max-key :value scored))
        claim  (some #(when (= :claim (:kind %)) %) cands)]
    (cond
      (and claim (or (nil? best) (= :pass (:kind best))) (idle? ctx)) claim
      best best
      :else {:action (or (button ctx "pass") (first (:actions ctx)))})))

;; ---------------------------------------------------------------------------------------------------------------
;; Targets

(defn- intent
  "What a targeting prompt does to the card picked, from its title and the source card's text."
  [ctx]
  (let [t   (:title ctx)
        src (get-in ctx [:source-card :text] "")
        dmg (some-> (or (re-find #"deal (\d+) damage" t) (re-find #"(\d+) damage" t)) second parse-long)]
    (cond
      dmg [:damage dmg]
      (has-any? t ["attach"]) (if (some-> (:source-card ctx) :upower neg?) [:remove] [:help])
      (has-any? t ["defeat" "capture" "return" "bounce" "take control" "discard"]) [:remove]
      (re-find #"-\d+/-\d+" t) [:remove]
      (str/includes? t "exhaust") [:exhaust]
      (str/includes? t "heal") [:heal]
      (has-any? t ["shield" "experience" "ready" "give" "+"]) [:help]
      (str/includes? t "damage") [:damage 2]
      (has-any? src ["defeat" "capture"]) [:remove]
      (str/includes? src "heal") [:heal]
      :else [:neutral])))

(defn- unit-target-score [ctx [kind n] u enemy?]
  (let [v (b/unit-value u)
        sign (if enemy? 1.0 -1.0)]
    (case kind
      :damage (let [kills (and (zero? (:shields u)) (>= n (b/remaining u)))]
                (* sign (if kills (+ v 2.0) (if (pos? (:shields u)) 1.0 (* 0.4 n)))))
      :remove (* sign (+ v 1.0))
      :exhaust (* sign (if (:ready u) (+ 0.5 (* 0.8 (:p u))) 0.2))
      :heal (* (- sign) (+ 0.1 (* 0.8 (min (:d u) 3))))
      :help (* (- sign) (+ (* 0.3 v) (* 0.3 (:p u)) (if (:ready u) 1.0 0.0)))
      (if enemy?
        (if (str/includes? (:title ctx) "friendly") -0.5 (* 0.2 v))
        (if (str/includes? (:title ctx) "enemy") -0.5 0.1)))))

(defn target-score
  "Score of picking card action `a` in a targeting prompt (higher = better)."
  [ctx a]
  (let [[kind n :as it] (intent ctx)
        c      (:card a)
        id     (:id c)
        m      (:model ctx)
        enemy? (not (mine? ctx a))
        z      (zone a)]
    (cond
      (= id (get-in ctx [:theirs :base :id]))
      (case kind :damage (if (>= n (b/base-left m (:op ctx))) 1000.0 (* 0.9 n)) :remove 0.0 0.1)

      (= id (get-in ctx [:my :base :id]))
      (case kind :damage (- n) :heal (* 0.8 (min n (get-in ctx [:my :base :d] 0))) 0.0)

      (b/unit m id)
      (unit-target-score ctx it (b/unit m id) enemy?)

      :else
      (let [card (card-of ctx a)
            k    (keep-score ctx card)]
        (cond
          (and (not enemy?) (or (= kind :remove) (str/includes? (:title ctx) "resource"))) (- k)
          enemy? (+ 1.0 (:cost card 0))
          :else (+ k (* 0.3 (:cost card 0))))))))

(def ^:private skip-labels #{"Pass" "Done" "Skip" "Cancel" "Pass attack" "Choose nothing" "Skip Resourcing" "No"})

(defn- skip-button [ctx]
  (or (some #(when (and (skip-labels (:label %)) (not= "Choose nothing" (:label %))) %) (buttons ctx))
      (button ctx "Choose nothing")))

(defn- attack-target-choice
  "Target prompt right after we clicked an attacker: take the planned target if it is offered, else re-plan."
  [ctx]
  (let [{:keys [attacker target]} (get-in ctx [:plan :attack])
        m       (:model ctx)
        op-base (get-in ctx [:theirs :base :id])
        as-target #(if (= % op-base) :base %)
        enemy?  #(let [id (get-in % [:card :id])]
                   (or (= op-base id) (some-> (b/unit m id) :seat (= (:op ctx)))))
        offered (filter enemy? (card-actions ctx))
        planned (some #(when (= target (as-target (get-in % [:card :id]))) %) offered)]
    (cond
      planned {:action planned}
      (and (b/unit m attacker) (seq offered))
      {:action (apply max-key #(after (assoc (b/attack m attacker (as-target (get-in % [:card :id]))) :passes 0))
                      offered)})))

(defn- attack-with-choice
  "'Attack with a unit ...' prompts (events and abilities that start an attack): pick the attacker and its target
  on the model, and remember the target for the prompt that follows."
  [ctx]
  (let [m       (:model ctx)
        t       (:title ctx)
        no-base (re-find #"can.t attack bases" t)
        bonus   (or (some-> (re-find #"\+(\d+)/\+\d+" t) second parse-long) 0)
        opts    (for [a (card-actions ctx)
                      :let [u (b/unit m (get-in a [:card :id]))]
                      :when (and u (= (:me ctx) (:seat u)))
                      :let [u  (-> u (assoc :ready true) (update :p + bonus))
                            m' (b/put-unit m u)]
                      target (cond->> (b/attack-targets m' u) no-base (remove #{:base}))]
                  {:action a :target target :value (after (assoc (b/attack m' (:id u) target) :passes 0))})
        stay    (after (assoc m :passes 0))
        skip    (skip-button ctx)]
    (when (seq opts)
      (let [best (apply max-key :value opts)]
        (if (and skip (< (:value best) stay))
          {:action skip}
          {:action (:action best)
           :plan {:attack {:attacker (get-in best [:action :card :id]) :target (:target best)}}})))))

(defn single-target-choice [ctx]
  (or (when (re-find #"^attack with" (:title ctx)) (attack-with-choice ctx))
      (when (get-in ctx [:plan :attack]) (attack-target-choice ctx))
      (let [cs     (card-actions ctx)
            scored (map #(vector (target-score ctx %) %) cs)
            [s a]  (apply max-key first scored)
            skip   (skip-button ctx)]
        {:action (if (and skip (neg? s)) skip a)})))

(defn wanted
  "How many cards a select prompt wants, from its title ('Select 2 cards', 'choose up to 3', 'between 1 and 2')."
  [title]
  (or (some-> (re-find #"between \d+ and (\d+)" title) second parse-long)
      (some-> (re-find #"up to (\d+)" title) second parse-long)
      (some-> (re-find #"(?:select|choose) (\d+)" title) second parse-long)
      (when (str/includes? title "any number") 99)
      1))

(declare resource-now?)

(defn multi-target-choice [ctx]
  (let [n        (wanted (:title ctx))
        selected (count (get-in ctx [:prompt :selected]))
        done     (or (button ctx "done") (some #(when (= "Done" (:label %)) %) (buttons ctx)))
        resource? (= "resource" (get-in ctx [:prompt :type]))
        score    (if resource? #(- (keep-score ctx (card-of ctx %))) #(target-score ctx %))
        scored   (map #(vector (score %) %) (card-actions ctx))
        exact?   (or resource? (not (str/includes? (:title ctx) "up to")))]
    (cond
      (and done (>= selected n)) {:action done}
      (empty? scored) {:action (or done (first (:actions ctx)))}
      (and resource? done (zero? selected) (re-find #"between 0" (:title ctx))
           (not (resource-now? ctx (apply max (map first scored)))))
      {:action done}
      :else (let [[s a] (apply max-key first scored)]
              (if (and done (not exact?) (neg? s)) {:action done} {:action a})))))

;; ---------------------------------------------------------------------------------------------------------------
;; Resources, mulligan, menus

(defn- resource-now?
  "Regroup phase: resource a card while we are short of resources, or when the hand has a card we will not use.
  `score` is minus the keep score of the card we would give up."
  [ctx score]
  (let [total (get-in ctx [:my :res :total] 0)
        hand  (count (get-in ctx [:my :hand]))]
    (or (< total 6)
        (and (< total 9) (>= hand 2))
        (and (< total 12) (>= hand 4) (pos? score)))))

(defn- regroup-resource-choice
  "Single 'Select 1 card to resource' prompt: resource the least useful card when resource-now? says so."
  [ctx]
  (let [cs    (card-actions ctx)
        skip  (button ctx "done")
        [k a] (when (seq cs) (apply min-key first (map #(vector (keep-score ctx (card-of ctx %)) %) cs)))]
    (if (and a (or (nil? skip) (resource-now? ctx (- k))))
      {:action a}
      {:action (or skip a (first (:actions ctx)))})))

(defn- mulligan-choice [ctx]
  (let [cheap (count (filter #(when-let [c (cards/lookup (:db ctx) %)]
                                (<= (+ (:cost c) (cards/aspect-penalty c (:aspects ctx))) 3))
                             (get-in ctx [:my :hand])))]
    {:action (or (button ctx (if (>= cheap 2) "keep" "mulligan")) (first (:actions ctx)))}))

(defn- button-score
  "Menu buttons that name a player: harmful effects go to the opponent, helpful ones to us."
  [title lbl]
  (let [text  (str title " " lbl)
        harm? (has-any? text ["damage" "discard" "defeat" "lose" "exhaust" "capture"])
        good? (has-any? lbl ["draw" "heal" "create" "give" "search" "play" "deploy" "attack" "ready"])
        them? (has-any? lbl ["opponent" "enemy"])
        us?   (has-any? lbl ["yourself" "your " "friendly"])]
    (+ (cond (and harm? them?) 3 (and harm? us?) -3 (and good? us?) 2 (and good? them?) -2 :else 0)
       (if good? 1 0)
       (if (str/includes? lbl "(no effect)") -5 0))))

(defn- button-choice [ctx]
  (let [bs    (buttons ctx)
        t     (:title ctx)
        plan  (:plan ctx)
        label #(lower (:label %))
        find  (fn [pred] (some #(when (pred %) %) bs))
        skip? #(or (skip-labels (:label %)) (has-any? (label %) ["cancel" "choose nothing"]))]
    {:action
     (or (when (or (str/includes? t "no effect") (button ctx "Use it anyway")) (button ctx "Cancel"))
         (when (str/includes? t "initiative") (button ctx "Yourself"))
         (when (:attack plan) (find #(= "attack" (label %))))
         (when (= :deploy (:leader plan)) (find #(str/includes? (label %) "deploy")))
         (when (and (button ctx "Yourself") (button ctx "Opponent"))
           (button ctx (if (has-any? t ["damage" "discard" "defeat" "lose" "exhaust"]) "Opponent" "Yourself")))
         (button ctx "trigger")
         (let [opts (remove skip? bs)]
           (when (seq opts) (apply max-key #(button-score t (label %)) (reverse opts))))
         (button ctx "done")
         (skip-button ctx)
         (first (:actions ctx)))}))

(defn- display-choice
  "Search / look-at prompts: take the most valuable card (the least valuable when it is going away)."
  [ctx kind]
  (let [as    (filter #(= kind (:kind %)) (:actions ctx))
        away? (has-any? (:title ctx) ["discard" "bottom" "defeat"])
        value (fn [a]
                (let [nm   (if (= kind "perCardButton") (second (str/split (:label a) #":" 2)) (:label a))
                      card (get-in ctx [:db :by-name nm])
                      v    (+ (:cost card 0) (if (cards/is? card "unit") 1.0 0.0))
                      verb (lower (first (str/split (:label a) #":" 2)))]
                  (if (= kind "perCardButton")
                    (cond (has-any? verb ["discard" "bottom" "defeat"]) (- v)
                          (str/includes? verb "play") (+ v 1.0)
                          :else v)
                    (if away? (- v) v))))]
    {:action (apply max-key value as)}))

(defn- option-choice [ctx]
  (let [os  (filter #(= "option" (:kind %)) (:actions ctx))
        num (filter #(re-matches #"#\d+" (:label %)) os)]
    (if (seq num)
      {:action (apply max-key #(parse-long (subs (:label %) 1)) num)}
      (let [theirs (set (map :n (get-in ctx [:theirs :discard])))]
        {:action (or (some #(when (theirs (:label %)) %) os) (first os))}))))

;; ---------------------------------------------------------------------------------------------------------------
;; Distribute

(defn distribution
  "A legal split for a distribute action: damage kills the most valuable enemy units it can, the rest goes to the
  enemy base, and only what must land on our side goes there (base first). Healing goes to our most damaged
  cards, tokens to our best units. nil lets the adapter pick a random legal split."
  [ctx {:keys [type amount canDistributeLess canChooseNoTargets maxTargets targets]}]
  (let [m       (:model ctx)
        me      (:me ctx)
        my-base (get-in ctx [:my :base :id])
        ts      (for [{:keys [id cap]} targets
                      :let [u (b/unit m id)]]
                  {:id id :cap (or cap 1000) :unit u
                   :mine (if u (= me (:seat u)) (= id my-base))})
        damage? (#{"distributeDamage" "distributeIndirectDamage"} type)
        heal?   (= "distributeHealing" type)
        need    (fn [{u :unit}] (if (pos? (:shields u)) 1 (b/remaining u)))
        value   (fn [{u :unit}] (b/unit-value u))
        enemy-units (filter #(and (:unit %) (not (:mine %))) ts)
        my-units    (filter #(and (:unit %) (:mine %)) ts)
        order   (cond
                  damage? (concat (sort-by #(- (/ (value %) (max 1 (need %)))) (filter #(<= (need %) amount) enemy-units))
                                  (remove #(or (:unit %) (:mine %)) ts)
                                  (sort-by #(- (value %)) enemy-units)
                                  (filter #(and (:mine %) (not (:unit %))) ts)
                                  (sort-by #(- (b/remaining (:unit %))) my-units))
                  heal?   (concat (sort-by #(- (value %)) (filter #(pos? (:d (:unit %))) my-units))
                                  (filter #(and (:mine %) (not (:unit %))) ts)
                                  ts)
                  :else   (concat (sort-by #(- (+ (:p (:unit %)) (if (:ready (:unit %)) 2 0))) my-units)
                                  (filter :mine ts)
                                  ts))
        order   (cond->> (distinct order) maxTargets (take maxTargets))
        want    (cond
                  damage? (fn [t] (cond (:mine t) 0 (:unit t) (need t) :else 1000))
                  heal?   (fn [t] (cond (not (:mine t)) 0 (:unit t) (:d (:unit t)) :else 1000))
                  :else   (constantly 1000))
        spill?  (fn [t] (not (and canDistributeLess (or (and damage? (:mine t)) (and heal? (not (:mine t)))))))
        give    (fn [[left acc] limit]
                  (reduce (fn [[left acc] t]
                            (let [have (get acc (:id t) 0)
                                  n    (max 0 (min left (- (:cap t) have) (- (limit t) have)))]
                              (if (pos? n) [(- left n) (assoc acc (:id t) (+ have n))] [left acc])))
                          [left acc] order))
        [left acc] (-> [amount {}]
                       (give want)
                       (give (fn [t] (if (spill? t) 1000 0))))
        split   (vec (for [t order :let [n (get acc (:id t) 0)] :when (pos? n)] {:id (:id t) :amount n}))]
    (cond
      (and (pos? left) (not canDistributeLess)) nil
      (and (empty? split) (not canChooseNoTargets)) nil
      :else split)))

;; ---------------------------------------------------------------------------------------------------------------
;; Dispatch

(defn choose [ctx]
  (let [kinds (set (map :kind (:actions ctx)))
        p     (:prompt ctx)]
    (cond
      (:actionWindow p) (window-choice ctx)
      (kinds "distribute") (let [a (some #(when (= "distribute" (:kind %)) %) (:actions ctx))]
                             {:action a :distribution (distribution ctx (:distribute a))})
      (= "initiative" (:type p)) (button-choice ctx)
      (str/includes? (:title ctx) "mulligan") (mulligan-choice ctx)
      (and (= "resource" (:type p)) (not= "multiple" (:selectCardMode p))) (regroup-resource-choice ctx)
      (and (= "multiple" (:selectCardMode p)) (kinds "card")) (multi-target-choice ctx)
      (kinds "card") (single-target-choice ctx)
      (kinds "perCardButton") (display-choice ctx "perCardButton")
      (kinds "displayCard") (display-choice ctx "displayCard")
      (kinds "option") (option-choice ctx)
      :else (button-choice ctx))))

(defn- log [& xs] (binding [*out* *err*] (apply println "[clj]" xs)))

(defn decide
  "Returns [bot' reply] for one decide message."
  [bot msg]
  (let [actions (:actions msg)
        okey    (hash [(:state msg) (dissoc (:prompt msg) :signature) (mapv akey actions)])
        tried   (get-in bot [:guard okey] #{})
        fresh   (vec (remove #(tried (akey %)) actions))
        pool    (if (seq fresh) fresh actions)
        round   (get-in msg [:state :round])
        bot     (if (= round (:round bot)) bot (assoc bot :round round :cancelled #{}))
        plan    (let [p (:plan bot)] (when (and p (<= (- (:seq msg 0) (:seq p 0)) 3)) p))
        ctx     (context (assoc bot :plan plan) msg pool)
        picked  (try (choose ctx)
                     (catch Throwable e
                       (log "fallback after" (str e))
                       {:action (or (some #(when (= "pass" (:arg %)) %) pool) (first pool))}))
        action  (or (:action picked) (first pool))
        reply   (cond-> {:t "act" :i (:i action)}
                  (seq (:distribution picked)) (assoc :distribution (:distribution picked)))
        plan'   (cond (:plan picked) (assoc (:plan picked) :seq (:seq msg 0))
                      (:actionWindow (:prompt msg)) nil
                      :else plan)
        backed  (and (:clicked plan) (= "button" (:kind action))
                     (re-find #"(?i)^(cancel|pass|done|choose nothing)" (str (:label action))))]
    [(-> bot
         (cond-> backed (update :cancelled conj (:clicked plan)))
         (assoc :plan (if backed nil plan'))
         (update-in [:guard okey] (fnil conj #{}) (akey action)))
     reply]))
