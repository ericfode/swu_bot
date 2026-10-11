;;;; The policy: one decision per `decide` message.
;;;;
;;;; Action window: every legal move is tried in the board model and scored after the opponent's best attack
;;;; reply; hand cards go through a knapsack so the ready resources buy the most value. Other prompts read the
;;;; prompt title with the intent patterns and try the effect on each candidate card in the model.

(in-package :swu)

;;; ------------------------------------------------------------------ per-game memory

(defvar *rng* (sb-ext:seed-random-state 0))
(defvar *round* -1)
(defvar *plan* nil "What the last action-window pick meant: (:attack unit target), (:deploy), (:ability), (:play id).")
(defvar *last-window-key* nil)
(defvar *last-unit* nil "Id of the own unit picked last (the attacker when a target prompt follows).")
(defvar *blocked* (make-hash-table :test 'equal) "Window picks that led to a Cancel this round.")
(defvar *repeats* (make-hash-table :test 'equal))
(defvar *trace* nil "Stream for decision logs, or NIL.")

(defun new-game (seed)
  (setf *rng* (sb-ext:seed-random-state (mod seed (expt 2 32)))
        *round* -1 *plan* nil *last-window-key* nil *last-unit* nil)
  (clrhash *blocked*)
  (clrhash *repeats*))

(defun trace-line (fmt &rest args)
  (when *trace*
    (apply #'format *trace* fmt args)
    (terpri *trace*)
    (force-output *trace*)))

;;; ------------------------------------------------------------------ small helpers

(defun lower (s) (if s (string-downcase s) ""))
(defun has (text word) (search word text))

(defun action-card (a) (jget a "card"))
(defun action-kind (a) (jget a "kind"))
(defun action-label (a) (or (jget a "label") ""))
(defun action-key (a)
  (format nil "~a:~a:~a" (action-kind a) (action-label a) (or (jget a "card" "id") "")))

(defun mine-p (w ref) (equal (jget ref "ctl") (side-seat (world-me w))))

(defun card-of-action (a)
  (find-card :name (action-label a) :set (jget a "card" "s") :title (jget a "card" "n")))

(defun my-aspects (w)
  (let ((me (world-me w)))
    (append (and (side-leader-card me) (card-aspects (side-leader-card me)))
            (and (side-base-card me) (card-aspects (side-base-card me))))))

(defun aspect-penalty (card aspects)
  "Extra cost: 2 for each aspect icon of CARD that the leader and base do not provide."
  (let ((pool (copy-list aspects)) (missing 0))
    (dolist (a (card-aspects card))
      (if (member a pool)
          (setf pool (remove a pool :count 1))
          (incf missing)))
    (* 2 missing)))

(defun effective-cost (w card)
  (+ (card-cost card) (aspect-penalty card (my-aspects w))))

(defun wanted-range (text)
  "How many cards a select prompt wants: (values min max). \"between 1 and 2\", \"up to 3\", \"select 2\"."
  (let ((toks (tokenize text)))
    (multiple-value-bind (pos b) (match-anywhere (compile-pattern "between ?a and ?b") toks)
      (when pos (return-from wanted-range (values (cdr (assoc '?a b)) (cdr (assoc '?b b))))))
    (multiple-value-bind (pos b) (match-anywhere (compile-pattern "up to ?n") toks)
      (when pos (return-from wanted-range (values 0 (cdr (assoc '?n b))))))
    (when (match-anywhere (compile-pattern "any number") toks)
      (return-from wanted-range (values 0 99)))
    (dolist (verb '("select ?n" "choose ?n" "exploit ?n"))
      (multiple-value-bind (pos b) (match-anywhere (compile-pattern verb) toks)
        (when pos (return-from wanted-range (values (cdr (assoc '?n b)) (cdr (assoc '?n b)))))))
    (values 1 99)))

(defun done-button-p (a)
  (and (equal (action-kind a) "button")
       (let ((l (lower (action-label a))))
         (or (equal (jget a "arg") "done")
             (member l '("done" "confirm" "confirm resources" "choose nothing" "take nothing" "skip resourcing")
                     :test #'string=)))))

(defun cancel-button-p (a)
  (and (equal (action-kind a) "button")
       (let ((l (lower (action-label a))))
         (or (string= l "cancel") (string= l "pass") (equal (jget a "arg") "passAbility")))))

;;; ------------------------------------------------------------------ how much a card is worth

(defun removal-intent-p (intent)
  (member (car intent) '(:damage :defeat :defeat-max :bounce :steal :sweep :wipe :capture)))

(defun keep-value (w card)
  "How much the bot wants CARD in hand rather than as a resource (higher = keep)."
  (if (null card)
      0.0
      (let* ((e (effective-cost w card))
             (total (side-total-res (world-me w)))
             (k 0.0))
        (when (card-is card :unit) (incf k 2.0))
        (when (and (card-is card :event) (removal-intent-p (read-intent (card-text card) *event-intents*)))
          (incf k 1.0))
        (cond ((<= e (1+ total)) (incf k 2.0))
              ((<= e (+ total 3)) (incf k 1.0))
              ((> e (+ total 4)) (decf k 2.0)))
        (decf k (* 0.6 (aspect-penalty card (my-aspects w))))
        (+ k (* 0.1 (card-cost card))))))

(defun enemy-units (w) (side-units (world-op w)))
(defun my-units (w) (side-units (world-me w)))

(defun best-over (units fn)
  "Max of FN over UNITS, or NIL when there are none."
  (when units (reduce #'max (mapcar fn units))))

(defun delta (w fn)
  "Evaluation change when FN (which edits a copy of W) is applied."
  (let ((w2 (copy-world* w)))
    (funcall fn w2)
    (- (evaluate w2) (evaluate w))))

(defun unit-effect (w2 u intent &key source)
  "Apply INTENT to the copy of unit U that lives in W2."
  (let ((u (find-unit w2 (unit-id u))))
    (when u
      (destructuring-bind (kind &optional a b) intent
        (case kind
          (:damage (damage-unit w2 u (or a 1)))
          ((:defeat :capture :sacrifice) (remove-unit w2 u))
          (:defeat-max (when (<= (hp-left u) (or a 99)) (remove-unit w2 u)))
          (:bounce (remove-unit w2 u))
          (:steal (multiple-value-bind (x side) (find-unit w2 (unit-id u))
                    (declare (ignore x))
                    (setf (side-units side) (remove u (side-units side)))
                    (push u (side-units (enemy-of w2 side)))
                    (setf (unit-ready u) nil)))
          (:exhaust (setf (unit-ready u) nil))
          (:ready (setf (unit-ready u) t))
          (:heal (setf (unit-dmg u) (max 0 (- (unit-dmg u) (or a 2)))))
          (:shield (incf (unit-shields u)))
          (:buff (incf (unit-power u) (or a 0))
           (setf (unit-power u) (max 0 (unit-power u)))
           (incf (unit-hp u) (or b 0))
           (when (<= (hp-left u) 0) (remove-unit w2 u)))
          (:neutralize (setf (unit-power u) 0 (unit-ready u) nil))
          (:sentinel (setf (unit-sentinel u) t))
          (:attach (let ((p (if source (card-upgrade-power source) 0))
                         (h (if source (card-upgrade-hp source) 0)))
                     (unit-effect w2 u (list :buff p h)))))))))

(defun intent-delta (w u intent &key source)
  (let ((d (delta w (lambda (w2) (unit-effect w2 u intent :source source)))))
    ;; bounced units come back; leaders return to their base
    (when (and (member (car intent) '(:bounce)) (unit-card u)) (setf d (* d 0.6)))
    (when (and (member (car intent) '(:defeat :capture :bounce :steal)) (unit-leader u)) (setf d (* d 0.7)))
    d))

(defun play-value (w card id)
  "Estimated gain of playing CARD now, in evaluation points. Negative = better held."
  (cond
    ((null card) 2.0)
    ((card-is card :unit)
     (let* ((base (score-after w))
            (w2 (copy-world* w))
            (u (add-unit w2 (world-me w2) card (or id "new") :ready nil)))
       ;; Ambush: it may attack an enemy unit at once
       (when (and (card-has card :ambush) (plusp (unit-power u)))
         (let ((targets (remove :base (legal-targets w2 (world-me w2) u)))
               (stay (score-after w2)))
           (when targets
             (setf (unit-ready u) t)
             (let* ((options (mapcar (lambda (tg) (simulate-attack w2 (unit-id u) (unit-id tg))) targets))
                    (best (reduce (lambda (x y) (if (> (score-after y) (score-after x)) y x)) options)))
               (if (> (score-after best) stay)
                   (setf w2 best)
                   (setf (unit-ready u) nil))))))
       (let ((d (- (score-after w2) base))
             (text (card-text card)))
         (if (plusp (length text))
             (max d (* 1.8 (card-cost card)) (+ d 1.0 (* 0.3 (card-cost card))))
             d))))
    ((card-is card :upgrade)
     (let* ((p (card-upgrade-power card)) (h (card-upgrade-hp card))
            (hostile (or (minusp p) (minusp h) (has (lower (card-text card)) "bounty")))
            (pool (if hostile (enemy-units w) (my-units w))))
       (if (null pool)
           -1.0
           (+ 1.0 (best-over pool (lambda (u) (+ (intent-delta w u (list :buff p h))
                                                  (if (and (not hostile) (unit-ready u)) (* *ready-weight* (max 0 p)) 0))))))))
    ((card-is card :event) (event-value w card))
    (t 1.0)))

(defun event-value (w card)
  (let* ((text (card-text card))
         (ltext (lower text))
         (intent (read-intent text *event-intents*))
         (cost (card-cost card))
         (generic (+ 0.5 (* 0.8 cost))))
    (destructuring-bind (kind &optional a b) intent
      (declare (ignorable b))
      (case kind
        ((:damage :defeat :bounce :steal)
         (let ((cap (multiple-value-bind (pos bind) (match-anywhere (compile-pattern "with ?n or less remaining hp") (tokenize text))
                      (and pos (cdr (assoc '?n bind))))))
           (or (best-over (remove-if (lambda (u) (and cap (> (hp-left u) cap)))
                                     (if (and (eq kind :bounce) (has ltext "non-leader"))
                                         (remove-if #'unit-leader (enemy-units w))
                                         (enemy-units w)))
                          (lambda (u) (intent-delta w u intent)))
               (if (and (eq kind :damage) (has ltext "base")) (* 0.8 (or a 1)) -1.0))))
        (:exhaust (or (best-over (remove-if-not #'unit-ready (enemy-units w))
                                 (lambda (u) (* *ready-weight* 2 (unit-power u))))
                      -0.5))
        (:buff (if (my-units w)
                   (* 0.6 (best-over (my-units w) (lambda (u) (+ (intent-delta w u intent)
                                                                  (if (unit-ready u) (max 0 (or a 0)) 0)))))
                   -1.0))
        (:shield (if (my-units w) 2.0 -1.0))
        (:attack (if (some #'unit-ready (my-units w)) (+ generic 1.0) -1.0))
        (:heal (let ((dmg (side-base-dmg (world-me w))))
                 (if (plusp dmg) (* 1.2 (min dmg (or a 2))) -0.5)))
        (:draw (* 1.8 (or a 1)))
        (:face (* 1.2 (or a 1)))
        (:sweep (delta w (lambda (w2)
                           (dolist (u (append (side-units (world-op w2))
                                              (unless (has ltext "each enemy") (side-units (world-me w2)))))
                             (damage-unit w2 u (or a 1))))))
        (:wipe (delta w (lambda (w2)
                          (setf (side-units (world-op w2)) nil)
                          (unless (has ltext "each enemy") (setf (side-units (world-me w2)) nil)))))
        (t generic)))))

;;; ------------------------------------------------------------------ the knapsack over hand cards

(defun best-spend (items budget)
  "ITEMS: list of (key cost value). The keys of the subset with the most value that fits BUDGET."
  (let* ((items (subseq (sort (copy-list items) #'> :key #'third) 0 (min 12 (length items))))
         (n (length items))
         (best-mask 0) (best-value 0.0) (best-cost -1))
    (dotimes (mask (ash 1 n))
      (let ((cost 0) (value 0.0))
        (loop for item in items for k from 0
              when (logbitp k mask) do (incf cost (second item)) (incf value (third item)))
        (when (and (<= cost budget)
                   (or (> value best-value) (and (= value best-value) (> cost best-cost))))
          (setf best-mask mask best-value value best-cost cost))))
    (loop for item in items for k from 0 when (logbitp k best-mask) collect (first item))))

;;; ------------------------------------------------------------------ action window

(defun leader-deploy-gain (w base)
  (let* ((me (world-me w)) (lc (side-leader-card me)))
    (when (and lc (not (side-leader-deployed me)) (>= (side-total-res me) (card-cost lc)))
      (let ((w2 (copy-world* w)))
        (let ((u (add-unit w2 (world-me w2) lc "leader" :ready t)))
          (setf (unit-leader u) t))
        (incf (side-ready-res (world-me w2)) (card-cost lc)) ; deploying is free
        (+ 1.0 (- (score-after w2) base))))))

(defun window-choice (w actions)
  "Index into ACTIONS for the top-level action window."
  (let* ((me (world-me w))
         (base (score-after w))
         (cands '())                    ; (gain index plan why)
         (items '()))
    ;; values of the cards we could pay for, then the knapsack
    (let ((vals (make-hash-table :test 'equal)))
      (loop for a in actions for i from 0
            for ref = (action-card a)
            when (and ref (mine-p w ref) (member (jget ref "zone") '("hand" "resource" "discard") :test #'equal))
              do (let* ((card (card-of-action a))
                        (v (play-value w card (jget ref "id")))
                        (cost (if card (+ (effective-cost w card) (if (equal (jget ref "zone") "resource") 2 0)) 0)))
                   (setf (gethash i vals) v)
                   (when (> v 0.2) (push (list i cost v) items))))
      (let ((plan (best-spend items (side-ready-res me))))
        (loop for a in actions for i from 0
              for ref = (action-card a)
              for kind = (action-kind a)
              for key = (action-key a)
              do (let ((cand
                         (cond
                           ((equal kind "button") nil)
                           ((null ref) (list 0.0 i nil "other"))
                           ((gethash i vals)
                            (let ((v (gethash i vals)))
                              (list (if (member i plan) v (- v 4.0)) i (list :play (jget ref "id")) "play")))
                           ;; own unit in an arena: attack (ready) or an action ability (exhausted)
                           ((and (mine-p w ref) (find-unit w (jget ref "id")))
                            (let ((u (find-unit w (jget ref "id"))))
                              (cond ((and (unit-ready u) (plusp (attack-power u)))
                                     (multiple-value-bind (tgt s) (best-attack w u)
                                       (list (- s base) i (list :attack (unit-id u) tgt) "attack")))
                                    ;; a ready 0-power unit would only attack for nothing
                                    ((unit-ready u) (list 0.1 i (list :ability (unit-id u)) "unit ability"))
                                    (t (list 0.8 i (list :ability (unit-id u)) "unit ability")))))
                           ((and (mine-p w ref) (equal (jget ref "id") (side-leader-id me)))
                            (let ((g (leader-deploy-gain w base)))
                              (if g
                                  (list g i (list :deploy) "deploy leader")
                                  (list (if (plusp (side-ready-res me)) 1.2 0.6) i (list :ability) "leader ability"))))
                           ((and (mine-p w ref) (equal (jget ref "id") (side-base-id me)))
                            (list 1.0 i (list :ability) "base ability"))
                           (t (list 0.2 i nil "other")))))
                   (when cand
                     (when (gethash key *blocked*) (decf (first cand) 50.0))
                     (when (>= (gethash (list *round* key) *repeats* 0) 3) (decf (first cand) 50.0))
                     (push cand cands))))))
    (let ((best (reduce (lambda (x y) (if (> (first y) (first x)) y x)) cands :initial-value (list 0.25 nil nil "pass"))))
      (if (second best)
          (progn
            (setf *plan* (third best))
            (trace-line "  window: ~a ~a gain ~,2f" (fourth best) (action-label (nth (second best) actions)) (first best))
            (second best))
          ;; nothing worth doing: take the initiative if it is not ours, else pass
          (let ((claim (position "claimInitiative" actions :key (lambda (a) (jget a "arg")) :test #'equal))
                (pass (position "pass" actions :key (lambda (a) (jget a "arg")) :test #'equal)))
            (setf *plan* nil)
            (trace-line "  window: nothing worth ~,2f, ~a" (first best) (if (and claim (not (equal (world-initiative w) (side-seat me)))) "claim" "pass"))
            (cond ((and claim (not (equal (world-initiative w) (side-seat me)))) claim)
                  (pass pass)
                  (claim claim)
                  (t 0)))))))

;;; ------------------------------------------------------------------ attack targets

(defun find-attacker (w prompt)
  (let ((named (jget prompt "promptTitle"))
        (planned (and (eq (first *plan*) :attack) (second *plan*))))
    (or (and planned (find-unit w planned))
        (and *last-unit* (let ((u (find-unit w *last-unit*)))
                           (and u (eq (nth-value 1 (find-unit w *last-unit*)) (world-me w))
                                (or (null named) (string= named (unit-name u))) u)))
        (and named (find named (my-units w) :key #'unit-name :test #'string=)))))

(defun attack-target-score (w attacker a)
  (let* ((ref (action-card a)) (id (jget ref "id")))
    (cond ((null attacker)
           ;; unknown attacker: face first, else the weakest enemy unit
           (if (eq (base-owner w id) (world-op w)) 5.0
               (let ((u (find-unit w id))) (if u (- 3.0 (* 0.3 (hp-left u))) 0.0))))
          ((base-owner w id)
           (if (eq (base-owner w id) (world-op w))
               (score-after (simulate-attack w (unit-id attacker) :base))
               -1000.0))
          ((find-unit w id)
           (if (eq (nth-value 1 (find-unit w id)) (world-op w))
               (score-after (simulate-attack w (unit-id attacker) id))
               -1000.0))
          (t -500.0))))

;;; ------------------------------------------------------------------ other prompts

(defun hostile-intent-p (intent)
  (member (car intent) '(:damage :defeat :defeat-max :capture :bounce :steal :exhaust :neutralize)))

(defun hand-zone-p (zone) (member zone '("hand" "discard" "deck" "resource") :test #'equal))

(defun target-score (w a intent source)
  "Score of picking card action A for a prompt whose effect is INTENT (source card SOURCE)."
  (let* ((ref (action-card a))
         (id (jget ref "id"))
         (zone (jget ref "zone"))
         (mine (mine-p w ref))
         (card (card-of-action a)))
    (multiple-value-bind (u side) (find-unit w id)
      (cond
        ;; units in play: try the effect in the model
        (u
         (case (car intent)
           (:attacker (if (and (eq side (world-me w)) (unit-ready u))
                          (- (nth-value 1 (best-attack w u)) (score-after w))
                          -5.0))
           ((:neutral :draw :play :discard)
            (if (eq side (world-me w)) (* 0.1 (unit-value u)) 0.0))
           (:attach
            (let* ((src source)
                   (bad (and src (or (minusp (card-upgrade-power src)) (minusp (card-upgrade-hp src))
                                     (has (lower (card-text src)) "bounty")))))
              (+ (intent-delta w u intent :source src)
                 (cond (bad (if (eq side (world-op w)) 1.0 -1.0))
                       ((eq side (world-me w)) (+ 1.0 (* 0.1 (unit-value u)) (if (unit-ready u) 0.5 0)))
                       (t -2.0)))))
           (t (+ (intent-delta w u intent :source source)
                 ;; temporary buffs matter most on a unit that can still attack
                 (if (and (eq (car intent) :buff) (eq side (world-me w)) (unit-ready u)) (* 0.5 (max 0 (or (second intent) 0))) 0)))))
        ;; bases
        ((base-owner w id)
         (let ((owner (base-owner w id)))
           (case (car intent)
             (:damage (delta w (lambda (w2) (damage-base (if (eq owner (world-me w)) (world-me w2) (world-op w2)) (or (second intent) 1)))))
             (:heal (delta w (lambda (w2) (heal-base (if (eq owner (world-me w)) (world-me w2) (world-op w2)) (or (second intent) 1)))))
             (t (if (eq (hostile-intent-p intent) (eq owner (world-op w))) 1.0 -1.0)))))
        ;; cards in hand, discard, deck or resources
        ((or (hand-zone-p zone) card)
         (let ((v (+ (keep-value w card) (if card (* 0.3 (card-cost card)) 0))))
           (cond ((member (car intent) '(:discard :defeat :sacrifice :bounce :capture))
                  (if mine (- v) v))
                 (t (if mine v (* 0.5 v))))))
        (t 0.0)))))

(defun button-score (w a title)
  (declare (ignore w))
  (let ((l (lower (action-label a)))
        (plan (first *plan*)))
    (cond
      ((and (has title "no effect") (has title "are you sure")) (if (string= l "cancel") 5.0 -5.0))
      ((has l "(no effect)") -4.0)
      ;; menus after clicking a unit or the leader in the action window
      ((and (eq plan :attack) (string= l "attack")) 6.0)
      ((and (eq plan :deploy) (has l "deploy")) 6.0)
      ((and (eq plan :ability) (has l "deploy")) -1.0)
      ((string= l "yourself") (if (has title "initiative") 6.0
                                  (if (eq (car (read-intent title *player-intents* '(:self))) :self) 3.0 -1.0)))
      ((string= l "you") (if (eq (car (read-intent title *player-intents* '(:self))) :self) 3.0 -1.0))
      ((or (string= l "opponent") (has l "opponent"))
       (if (has l "to opponent") 3.5
           (if (eq (car (read-intent (concatenate 'string title " " l) *player-intents* '(:self))) :opponent) 3.0 -1.0)))
      ((has l "to yourself") -2.0)
      ((has l "your deck") 0.5)
      ((has l "without exploit") 3.0)
      ((has l "trigger exploit") 1.0)
      ((has l "without credit") 1.5)
      ((has l "credit") 2.5)
      ((or (string= l "trigger") (has l "use it anyway") (has l "play anyway")) 2.0)
      ((or (string= l "attack") (has l "deploy") (has l "give") (has l "create") (has l "draw") (has l "heal")) 2.0)
      ((or (has l "done") (has l "confirm")) 1.0)
      ((or (string= l "cancel") (has l "pass") (has l "skip") (has l "nothing") (string= l "no") (has l "decline")) -1.0)
      ((eq plan :ability) 1.5)
      (t 0.5))))

(defun option-score (w a)
  (let ((l (action-label a)))
    (cond ((and (plusp (length l)) (char= (char l 0) #\#))
           (or (ignore-errors (parse-integer l :start 1)) 0))
          ;; "name a card": a card the opponent has shown
          ((or (find l (side-discard (world-op w)) :key (lambda (c) (and c (card-title c))) :test #'equal)
               (find l (side-units (world-op w)) :key #'unit-name :test #'equal))
           1.0)
          (t 0.0))))

(defun display-score (w a title)
  (let* ((card (find-card :name (action-label a)))
         (v (+ (keep-value w card) (if card (* 0.3 (card-cost card)) 0))))
    (if (or (has title "discard") (has title "bottom")) (- v) v)))

(defun per-card-score (w a)
  (let* ((label (action-label a))
         (k (position #\: label))
         (button (lower (if k (subseq label 0 k) label)))
         (card (find-card :name (if k (subseq label (1+ k)) "")))
         (v (+ (keep-value w card) (if card (* 0.3 (card-cost card)) 0))))
    (if (or (has button "discard") (has button "bottom") (has button "defeat")) (- v) v)))

;;; ------------------------------------------------------------------ resources and mulligan

(defun want-resource-p (w)
  (let* ((me (world-me w)) (total (side-total-res me))
         (hand (remove nil (mapcar #'cdr (side-hand me)))))
    (cond ((< total 6) t)
          ((>= total 10) nil)
          ((>= (length (side-hand me)) 4) t)
          (t (some (lambda (c) (> (effective-cost w c) total)) hand)))))

(defun resource-choice (w prompt actions)
  (multiple-value-bind (lo hi) (wanted-range (or (jget prompt "title") ""))
    (let* ((selected (length (jget prompt "selected")))
           (done (position-if #'done-button-p actions))
           (cards (loop for a in actions for i from 0
                        when (equal (action-kind a) "card") collect i)))
      (cond ((and done (or (>= selected hi) (null cards))) done)
            ((and done (>= selected lo) (not (want-resource-p w))) done)
            (cards (let ((best nil) (best-k nil))
                     (dolist (i cards)
                       (let ((k (keep-value w (card-of-action (nth i actions)))))
                         (when (or (null best-k) (< k best-k)) (setf best i best-k k))))
                     best))
            (done done)
            (t 0)))))

(defun mulligan-choice (w actions)
  (let* ((hand (remove nil (mapcar #'cdr (side-hand (world-me w)))))
         (cheap-units (count-if (lambda (c) (and (card-is c :unit) (<= (effective-cost w c) 3))) hand))
         (playable (count-if (lambda (c) (<= (effective-cost w c) 4)) hand))
         (keep (or (null hand) (and (>= cheap-units 1) (>= playable 3)))))
    (or (position (if keep "Keep" "Mulligan") actions :key #'action-label :test #'string-equal) 0)))

;;; ------------------------------------------------------------------ distribute

(defun split-distribution (w d)
  "Chosen split for a distribute action: list of (id . amount), or NIL to let the adapter pick."
  (let* ((type (lower (jget d "type")))
         (amount (jnum d "amount"))
         (max-targets (let ((m (jget d "maxTargets"))) (if (and (integerp m) (plusp m)) m 99)))
         (targets (mapcar (lambda (tg) (list (jget tg "id") (let ((c (jget tg "cap"))) (if (integerp c) c 999)) 0))
                          (jget d "targets")))
         (left amount))
    (labels ((used () (count-if (lambda (tg) (plusp (third tg))) targets))
             (give (tg want)
               (when (and (plusp left) (or (plusp (third tg)) (< (used) max-targets)))
                 (let ((n (min want left (- (second tg) (third tg)))))
                   (when (plusp n)
                     (incf (third tg) n)
                     (decf left n)))))
             (unit-of (tg) (find-unit w (first tg)))
             (enemy-unit-p (tg) (let ((u (unit-of tg))) (and u (eq (nth-value 1 (find-unit w (first tg))) (world-op w)))))
             (my-unit-p (tg) (let ((u (unit-of tg))) (and u (eq (nth-value 1 (find-unit w (first tg))) (world-me w)))))
             (op-base-p (tg) (eq (base-owner w (first tg)) (world-op w)))
             (my-base-p (tg) (eq (base-owner w (first tg)) (world-me w))))
      (cond
        ((has type "heal")
         (let ((order (sort (copy-list targets) #'>
                            :key (lambda (tg) (cond ((my-unit-p tg) (unit-dmg (unit-of tg)))
                                                    ((my-base-p tg) (side-base-dmg (world-me w)))
                                                    (t -1))))))
           (dolist (tg order)
             (give tg (cond ((my-unit-p tg) (unit-dmg (unit-of tg)))
                            ((my-base-p tg) (side-base-dmg (world-me w)))
                            (t 0))))
           (dolist (tg order) (when (or (my-unit-p tg) (my-base-p tg)) (give tg 999)))))
        ((has type "token")
         (let ((order (sort (copy-list targets) #'>
                            :key (lambda (tg) (if (my-unit-p tg) (unit-value (unit-of tg)) -1)))))
           (dolist (tg order) (when (my-unit-p tg) (give tg 1)))
           (dolist (tg order) (when (my-unit-p tg) (give tg 999)))))
        (t
         ;; damage: lethal on the enemy base, then kills (most value per point), shields, the enemy base
         (let ((ob (find-if #'op-base-p targets)))
           (when (and ob (>= amount (base-left (world-op w))))
             (give ob 999)))
         (let ((kills (sort (remove-if-not (lambda (tg) (and (enemy-unit-p tg) (zerop (unit-shields (unit-of tg)))))
                                           targets)
                            #'> :key (lambda (tg) (/ (unit-value (unit-of tg)) (max 1 (hp-left (unit-of tg))))))))
           (dolist (tg kills)
             (let ((need (max 1 (hp-left (unit-of tg)))))
               (when (and (<= need left) (<= need (second tg))) (give tg need)))))
         (dolist (tg targets)
           (when (and (enemy-unit-p tg) (plusp (unit-shields (unit-of tg))) (zerop (third tg))) (give tg 1)))
         (dolist (tg targets) (when (op-base-p tg) (give tg 999)))
         (dolist (tg targets) (when (enemy-unit-p tg) (give tg 999)))
         (dolist (tg targets) (when (my-base-p tg) (give tg 999)))
         (dolist (tg (sort (remove-if-not #'my-unit-p (copy-list targets)) #'< :key (lambda (tg) (unit-value (unit-of tg)))))
           (give tg (max 0 (1- (hp-left (unit-of tg))))))))
      (dolist (tg targets) (give tg 999))
      (let ((picked (remove-if-not (lambda (tg) (plusp (third tg))) targets)))
        (cond ((and (plusp left) (not (jget d "canDistributeLess"))) nil)
              ((and (null picked) (not (jget d "canChooseNoTargets"))) nil)
              (t (mapcar (lambda (tg) (cons (first tg) (third tg))) picked)))))))

;;; ------------------------------------------------------------------ dispatch

(defun pick-best (scored)
  "SCORED: list of (score . index). Highest score; earlier index wins ties."
  (cdr (reduce (lambda (x y) (if (> (car y) (car x)) y x)) scored)))

(defun generic-choice (w prompt actions)
  (let* ((title (lower (jget prompt "title")))
         (source (find-card :title (jget prompt "promptTitle")))
         (intent (read-intent title *target-intents*))
         (multiple (equal (jget prompt "selectCardMode") "multiple"))
         (selected (length (jget prompt "selected")))
         (sig (format nil "~a|~a|~d" (jget prompt "signature") title selected))
         (scored
           (loop for a in actions for i from 0
                 collect (cons (let ((s (let ((kind (action-kind a)))
                                          (cond ((equal kind "button") (button-score w a title))
                                                ((equal kind "card") (target-score w a intent source))
                                                ((equal kind "option") (option-score w a))
                                                ((equal kind "displayCard") (display-score w a title))
                                                ((equal kind "perCardButton") (per-card-score w a))
                                                (t 0.0)))))
                                 (if (>= (gethash (list *round* sig (action-key a)) *repeats* 0) 8) (- s 100.0) s))
                               i))))
    (when multiple
      (multiple-value-bind (lo hi) (wanted-range (concatenate 'string title " " (lower (jget prompt "promptTitle"))))
        (let ((done (position-if #'done-button-p actions))
              (cards (remove-if-not (lambda (x) (equal (action-kind (nth (cdr x) actions)) "card")) scored)))
          (when done
            (cond ((or (>= selected hi) (null cards))
                   (return-from generic-choice done))
                  ((and (>= selected lo) (<= (car (reduce (lambda (x y) (if (> (car y) (car x)) y x)) cards)) 0))
                   (return-from generic-choice done))
                  (t (return-from generic-choice (pick-best cards))))))))
    ;; optional single picks: decline when every card only hurts us
    (let* ((cards (remove-if-not (lambda (x) (equal (action-kind (nth (cdr x) actions)) "card")) scored))
           (decline (position-if (lambda (a) (or (equal (jget a "arg") "passAbility")
                                                 (string-equal (action-label a) "choose nothing")))
                                 actions)))
      (when (and cards decline (< (car (reduce (lambda (x y) (if (> (car y) (car x)) y x)) cards)) -1.0))
        (return-from generic-choice decline)))
    (let ((choice (pick-best scored)))
      (setf (gethash (list *round* sig (action-key (nth choice actions))) *repeats*)
            (1+ (gethash (list *round* sig (action-key (nth choice actions))) *repeats* 0)))
      choice)))

(defun choose (msg)
  "Answer one decide message: (values index distribution)."
  (let* ((you (jget msg "you"))
         (prompt (jget msg "prompt"))
         (actions (jget msg "actions"))
         (w (parse-world (jget msg "state") you))
         (title (lower (jget prompt "title")))
         (type (jget prompt "type")))
    (when (/= (world-round w) *round*)
      (setf *round* (world-round w))
      (clrhash *blocked*))
    (let ((dist (position "distribute" actions :key #'action-kind :test #'equal)))
      (when dist
        (return-from choose (values dist (split-distribution w (jget (nth dist actions) "distribute"))))))
    (let ((i (cond
               ((equal type "initiative")
                (or (position "Yourself" actions :key #'action-label :test #'string-equal) 0))
               ((has title "mulligan") (mulligan-choice w actions))
               ((equal type "resource") (resource-choice w prompt actions))
               ((jget prompt "actionWindow")
                (let ((i (window-choice w actions)))
                  (let ((key (action-key (nth i actions))))
                    (setf *last-window-key* key)
                    (incf (gethash (list *round* key) *repeats* 0)))
                  i))
               ((has title "choose a target for attack")
                (let* ((attacker (find-attacker w prompt))
                       (scored (loop for a in actions for i from 0
                                     collect (cons (if (equal (action-kind a) "card")
                                                       (attack-target-score w attacker a)
                                                       (if (cancel-button-p a) (- (score-after w) 4.0) -2000.0))
                                                   i))))
                  (pick-best scored)))
               (t (generic-choice w prompt actions)))))
      (let ((a (nth i actions)))
        ;; remember own units picked (attackers) and cancels (so the window does not retry the same pick)
        (let ((ref (action-card a)))
          (when (and ref (mine-p w ref) (find-unit w (jget ref "id")))
            (setf *last-unit* (jget ref "id"))))
        (when (and (not (jget prompt "actionWindow")) (equal (action-kind a) "button")
                   (string-equal (action-label a) "cancel") *last-window-key*)
          (setf (gethash *last-window-key* *blocked*) t)))
      (values i nil))))
