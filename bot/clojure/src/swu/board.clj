(ns swu.board
  "A small model of the board, built from the protocol's state snapshot.

  The bot cannot roll the real engine back, so it keeps its own simplified copy of the board as plain data and
  plays candidate moves on that copy: attacks (with combat math), unit and upgrade plays, leader deploys, and a
  rough reading of event text. Every move is a pure function board -> board, and `search` runs a small alpha-beta
  minimax over attacks by both seats on top of that. Card abilities it does not model are scored by cost."
  (:require [clojure.string :as str]
            [swu.cards :as cards]))

;; ---------------------------------------------------------------------------------------------------------------
;; Building the model

(defn other [seat] (if (= seat :p1) :p2 :p1))

(defn- token-count [unit token-name]
  (count (filter #(and (= 1 (:t %)) (= token-name (:n %))) (:u unit))))

(defn unit-from [db seat arena u]
  (let [c (cards/lookup db u)]
    {:id        (:id u)
     :title     (:n u)
     :seat      seat
     :arena     arena
     :p         (max 0 (long (or (:p u) 0)))
     :h         (long (or (:h u) 0))
     :d         (long (or (:d u) 0))
     :ready     (not= 1 (:x u))
     :sentinel  (= 1 (:sn u))
     :shields   (token-count u "Shield")
     :raid      (:raid c 0)
     :restore   (:restore c 0)
     :overwhelm (cards/kw? c "overwhelm")
     :saboteur  (cards/kw? c "saboteur")
     :grit      (cards/kw? c "grit")
     :card      c}))

(defn side-from [db seat p]
  {:base-id   (get-in p [:base :id])
   :base-hp   (long (or (get-in p [:base :hp]) 30))
   :base-d    (long (or (get-in p [:base :d]) 0))
   :leader    (:leader p)
   :ready-res (long (or (get-in p [:res :ready]) 0))
   :total-res (long (or (get-in p [:res :total]) 0))
   :hand      (long (or (:handCount p) (count (:hand p)) 0))
   :deck      (long (or (:deck p) 0))
   :misc      0.0
   :units     (into (mapv #(unit-from db seat :ground %) (:ground p))
                    (mapv #(unit-from db seat :space %) (:space p)))})

(defn from-state [db state me]
  (let [players (:players state)]
    {:me     me
     :phase  (:phase state)
     :sides  {:p1 (side-from db :p1 (:p1 players))
              :p2 (side-from db :p2 (:p2 players))}
     :passes 0}))

;; ---------------------------------------------------------------------------------------------------------------
;; Reading it

(defn remaining [u] (- (:h u) (:d u)))
(defn base-left [m seat] (let [s (get-in m [:sides seat])] (- (:base-hp s) (:base-d s))))
(defn units [m seat] (get-in m [:sides seat :units]))
(defn unit [m id]
  (some (fn [seat] (some #(when (= id (:id %)) %) (units m seat))) [:p1 :p2]))

(defn attack-power [u] (+ (:p u) (:raid u)))

(defn unit-value
  "What a unit on the board is worth, in rough 'cost' units."
  [u]
  (+ (* 1.0 (:p u))
     (* 0.75 (max 0 (remaining u)))
     (* 1.6 (:shields u))
     (if (:sentinel u) 1.0 0.0)
     (if (:overwhelm u) 0.4 0.0)
     (if (:saboteur u) 0.4 0.0)
     (* 0.35 (:raid u))
     (* 0.4 (:restore u))
     (if (:ready u) (* 0.1 (:p u)) 0.0)))

(defn- base-score
  "Base health is worth more the closer it is to zero."
  [left]
  (- left (/ 30.0 (+ left 4))))

(def win 10000.0)

(defn evaluate
  "Board value for seat `me`: units, base race, cards in hand, and modelled extras."
  ([m] (evaluate m (:me m)))
  ([m me]
   (let [op     (other me)
         my-l   (base-left m me)
         op-l   (base-left m op)]
     (cond
       (<= op-l 0) win
       (<= my-l 0) (- win)
       :else
       (let [my-s   (get-in m [:sides me])
             op-s   (get-in m [:sides op])
             mat    (- (reduce + 0.0 (map unit-value (:units my-s)))
                       (reduce + 0.0 (map unit-value (:units op-s))))
             my-pow (reduce + 0 (map attack-power (:units my-s)))
             op-pow (reduce + 0 (map attack-power (:units op-s)))
             race   (+ (* 0.8 (- (base-score my-l) (base-score op-l)))
                       (if (>= my-pow op-l) 5.0 0.0)
                       (if (>= op-pow my-l) -8.0 0.0))]
         (+ mat race
            (* 1.0 (- (:hand my-s) (:hand op-s)))
            (- (:misc my-s) (:misc op-s))))))))

;; ---------------------------------------------------------------------------------------------------------------
;; Moves on the model (pure functions)

(defn- update-unit [m id f & args]
  (update m :sides
          (fn [sides]
            (reduce-kv (fn [acc seat side]
                         (assoc acc seat (update side :units (fn [us] (mapv #(if (= id (:id %)) (apply f % args) %) us)))))
                       {} sides))))

(defn put-unit
  "Replaces the unit with the same id."
  [m u]
  (update-unit m (:id u) (constantly u)))

(defn- remove-dead [m]
  (update m :sides
          (fn [sides]
            (reduce-kv (fn [acc seat side]
                         (assoc acc seat (update side :units (fn [us] (filterv #(pos? (remaining %)) us)))))
                       {} sides))))

(defn- damage-unit
  "Deals n damage to a unit; a shield prevents it and is used up."
  [u n]
  (cond
    (<= n 0) u
    (pos? (:shields u)) (update u :shields dec)
    :else (cond-> (update u :d + n)
            (:grit u) (update :p + n))))

(defn hurt-base [m seat n] (update-in m [:sides seat :base-d] #(max 0 (+ % n))))
(defn heal-base [m seat n] (update-in m [:sides seat :base-d] #(max 0 (- % n))))
(defn add-misc [m seat v] (update-in m [:sides seat :misc] + v))

(defn attack-targets
  "Legal targets for unit `a`: enemy units in its arena (only sentinels if one is there, unless it has Saboteur)
  and the enemy base."
  [m a]
  (let [enemies (filterv #(= (:arena a) (:arena %)) (units m (other (:seat a))))
        guards  (filterv :sentinel enemies)]
    (if (and (seq guards) (not (:saboteur a)))
      (mapv :id guards)
      (conj (mapv :id enemies) :base))))

(defn attack
  "Unit `atk-id` attacks `target` (a unit id or :base). Combat damage is dealt at the same time both ways."
  [m atk-id target]
  (let [a    (unit m atk-id)
        seat (:seat a)
        foe  (other seat)
        pow  (attack-power a)
        m    (cond-> (update-unit m atk-id assoc :ready false)
               (pos? (:restore a)) (heal-base seat (:restore a)))]
    (if (= target :base)
      (hurt-base m foe pow)
      (let [t      (unit m target)
            t      (if (:saboteur a) (assoc t :shields 0) t)
            shield (pos? (:shields t))
            excess (if (and (:overwhelm a) (not shield)) (max 0 (- pow (remaining t))) 0)
            back   (:p t)]
        (-> m
            (update-unit target (fn [_] (damage-unit t pow)))
            (update-unit atk-id damage-unit back)
            (hurt-base foe excess)
            remove-dead)))))

(defn attacks
  "Every attack open to `seat`: [attacker-id target] pairs."
  [m seat]
  (for [a (units m seat)
        :when (and (:ready a) (pos? (attack-power a)))
        t (attack-targets m a)]
    [(:id a) t]))

;; ---------------------------------------------------------------------------------------------------------------
;; Search: alpha-beta over attacks and passes. Card plays by the opponent are unknown, so they are not modelled.

(defn search
  "Value of `m` for (:me m) with `seat` to move and `depth` plies left. Two passes in a row end the line."
  [m seat depth alpha beta]
  (let [v (evaluate m)]
    (if (or (zero? depth) (>= (Math/abs v) win) (>= (:passes m) 2))
      v
      (let [maxing (= seat (:me m))
            nxt    (other seat)
            kids   (cons (update m :passes inc)
                         (map (fn [[a t]] (assoc (attack m a t) :passes 0)) (attacks m seat)))]
        (loop [[k & more] kids alpha alpha beta beta best (if maxing (- Double/MAX_VALUE) Double/MAX_VALUE)]
          (if (nil? k)
            best
            (let [s    (search k nxt (dec depth) alpha beta)
                  best (if maxing (max best s) (min best s))
                  alpha (if maxing (max alpha s) alpha)
                  beta  (if maxing beta (min beta s))]
              (if (>= alpha beta)
                best
                (recur more alpha beta best)))))))))

(defn reply-value
  "Value of a board after one of our moves: the opponent answers first."
  [m depth]
  (search (assoc m :passes 0) (other (:me m)) depth (- Double/MAX_VALUE) Double/MAX_VALUE))

;; ---------------------------------------------------------------------------------------------------------------
;; Card plays on the model

(defn- best-by [f xs] (when (seq xs) (apply max-key f xs)))

(defn- word->n [w]
  (case w ("a" "an" "one") 1 "two" 2 "three" 3 "four" 4 "five" 5 (or (some-> w parse-long) 1)))

(defn- with-best
  "Applies (f m id) for the candidate id that leaves the best board for seat me; nil without candidates."
  [m ids f]
  (best-by #(evaluate %) (map #(f m %) ids)))

(defn- limit-ok?
  "Checks simple numeric limits in event text: 'with 3 or less remaining hp', 'costs 3 or less', '3 or less power'."
  [text u]
  (let [hp   (some-> (re-find #"(\d+) or less remaining hp" text) second parse-long)
        pow  (some-> (re-find #"(\d+) or less power" text) second parse-long)
        cost (some-> (re-find #"costs? (\d+) or less" text) second parse-long)]
    (and (or (nil? hp) (<= (remaining u) hp))
         (or (nil? pow) (<= (:p u) pow))
         (or (nil? cost) (<= (get-in u [:card :cost] 0) cost)))))

(defn- arena-ok? [text u]
  (cond
    (re-find #"ground unit" text) (= :ground (:arena u))
    (re-find #"space unit" text) (= :space (:arena u))
    :else true))

(defn- removal-targets [m me text]
  (->> (units m (other me))
       (filter #(and (arena-ok? text %) (limit-ok? text %)
                     (not (and (re-find #"non-leader" text) (get-in % [:card :types "leader"])))))
       (map :id)))

(defn- remove-unit [m id] (update-in m [:sides (:seat (unit m id)) :units] (fn [us] (filterv #(not= id (:id %)) us))))

(defn event-effect
  "Rough effect of an event (or a When Played ability) from its text. Returns [board' parsed?]; nil when the card
  needs a target and there is none."
  [m me text]
  (let [op  (other me)
        dmg (re-find #"deal (\d+) damage to (a|an|another|each|up to \w+)? ?(enemy |friendly |non-leader |ground |space )*(unit|base)" text)
        each-enemy (re-find #"deal (\d+) damage to each enemy (ground |space )?unit" text)
        defeat (re-find #"(defeat|capture) (a|an|another) [^.]*?unit" text)
        bounce (re-find #"return (a|an|another) [^.]*?unit[^.]*hand" text)
        exhaust (re-find #"exhaust (a|an|another|up to \w+) [^.]*?unit" text)
        heal (re-find #"heal (\d+) damage" text)
        draw (re-find #"draw (a|an|one|two|three|\d+) cards?" text)
        shield (re-find #"give (a|an) [^.]*?shield token" text)
        exp (re-find #"give (a|an|two|\d+)? ?[^.]*?experience tokens?" text)
        create (re-find #"create (a|an|one|two|three|\d+) [^.]*?tokens?" text)
        mine (map :id (units m me))
        theirs (map :id (units m op))]
    (cond
      each-enemy
      (let [n (parse-long (second each-enemy))]
        [(reduce (fn [acc id] (if (unit acc id) (remove-dead (update-unit acc id damage-unit n)) acc)) m theirs) true])

      (and dmg (= "unit" (nth dmg 4)) (not (re-find #"friendly" (or (nth dmg 3) ""))))
      (when (seq theirs)
        (let [n (parse-long (second dmg))]
          [(with-best m (filter #(arena-ok? text (unit m %)) theirs)
             (fn [acc id] (remove-dead (update-unit acc id damage-unit n)))) true]))

      (and dmg (= "base" (nth dmg 4)))
      [(hurt-base m op (parse-long (second dmg))) true]

      defeat
      (let [ids (removal-targets m me text)]
        (when (seq ids) [(with-best m ids remove-unit) true]))

      bounce
      (let [ids (removal-targets m me text)]
        (when (seq ids) [(update-in (with-best m ids remove-unit) [:sides op :hand] inc) true]))

      :else
      (let [m (cond-> m
                (and exhaust (seq theirs))
                (as-> x (with-best x theirs (fn [acc id] (update-unit acc id assoc :ready false))))
                heal
                (as-> x (let [n (parse-long (second heal))]
                          (best-by evaluate (cons (heal-base x me n)
                                                  (map #(update-unit x % update :d (fn [d] (max 0 (- d n)))) mine)))))
                draw
                (update-in [:sides me :hand] + (word->n (second draw)))
                (and shield (seq mine))
                (as-> x (with-best x mine (fn [acc id] (update-unit acc id update :shields inc))))
                (and exp (seq mine))
                (as-> x (let [n (word->n (or (second exp) "a"))]
                          (with-best x mine (fn [acc id] (update-unit acc id #(-> % (update :p + n) (update :h + n)))))))
                create
                (add-misc me (* 2.0 (word->n (second create)))))]
        [m (boolean (or exhaust heal draw shield exp create))]))))

(defn- new-unit [card seat id]
  {:id id :title (:title card) :seat seat :arena (if (= "space" (:arena card)) :space :ground)
   :p (:power card) :h (:hp card) :d 0 :ready false
   :sentinel (cards/kw? card "sentinel") :shields (if (cards/kw? card "shielded") 1 0)
   :raid (:raid card) :restore (:restore card) :overwhelm (cards/kw? card "overwhelm")
   :saboteur (cards/kw? card "saboteur") :grit (cards/kw? card "grit") :card card})

(defn play-card
  "Board after `me` plays `card` (hand or Smuggle) paying `eff-cost`. nil if the play cannot do anything useful
  (an upgrade with no unit, removal with no target)."
  [m me card card-id eff-cost]
  (let [m (-> m
              (update-in [:sides me :ready-res] #(max 0 (- % eff-cost)))
              (update-in [:sides me :hand] #(max 0 (dec %))))
        text (:text card)]
    (cond
      (cards/is? card "unit")
      (let [u     (new-unit card me (str "new:" card-id))
            stat  (+ (:power card) (:hp card))
            extra (* 0.5 (max 0 (- (inc (* 2 (:cost card))) stat)))
            m     (-> (update-in m [:sides me :units] conj u) (add-misc me extra))
            [m _] (or (when (re-find #"when played" text) (event-effect m me text)) [m false])]
        (if (cards/kw? card "ambush")
          ;; Ambush: it may attack an enemy unit right away
          (let [ready (update-unit m (:id u) assoc :ready true)
                best  (best-by evaluate (cons m (for [t (attack-targets ready (unit ready (:id u)))
                                                      :when (not= t :base)]
                                                  (attack ready (:id u) t))))]
            best)
          m))

      (cards/is? card "upgrade")
      (let [up    (or (:upower card) 0)
            uh    (or (:uhp card) 0)
            bad?  (or (neg? up) (neg? uh) (re-find #"bounty" text))
            seat  (if bad? (other me) me)
            ids   (map :id (units m seat))
            extra (* 0.3 (:cost card))]
        (when (seq ids)
          (add-misc (with-best m ids (fn [acc id] (update-unit acc id #(-> % (update :p (fn [p] (max 0 (+ p up))))
                                                                              (update :h + uh)))))
                    me extra)))

      :else
      (when-let [[m' parsed] (event-effect m me text)]
        (if parsed m' (add-misc m' me (* 0.9 (:cost card))))))))

(defn deploy-leader
  "Board after deploying the leader: it arrives as a ready unit."
  [m me card]
  (let [u (assoc (new-unit card me (str "leader:" (:title card))) :ready true
                 :arena (if (= "space" (:arena card)) :space :ground))]
    (-> (update-in m [:sides me :units] conj u)
        (assoc-in [:sides me :leader :dep] 1))))
