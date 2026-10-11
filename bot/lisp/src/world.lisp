;;;; Board model: the observed state as structs, a combat simulator and an evaluation.
;;;;
;;;; The bot cannot roll the engine back, so it keeps its own small model of the board: units with power,
;;;; HP, damage, shields, readiness and the keywords that change combat (Sentinel, Saboteur, Overwhelm, Raid,
;;;; Restore). Moves are tried on copies of the model and scored with EVALUATE from the bot's seat.

(in-package :swu)

(defstruct (unit (:copier copy-unit))
  (id "" :type string)
  (name "" :type string)
  (card nil)
  (power 0 :type fixnum)
  (hp 0 :type fixnum)
  (dmg 0 :type fixnum)
  (ready nil)
  (sentinel nil)
  (shields 0 :type fixnum)
  (arena :ground)
  (leader nil))

(defstruct (side (:copier nil))
  (seat "")
  (base-id "")
  (base-card nil)
  (base-hp 30 :type fixnum)
  (base-dmg 0 :type fixnum)
  (units '())
  (leader-id nil)
  (leader-card nil)
  (leader-deployed nil)
  (leader-exhausted nil)
  (ready-res 0 :type fixnum)
  (total-res 0 :type fixnum)
  (hand '())                            ; list of (id . card-or-nil)
  (hand-count 0 :type fixnum)
  (resources '())                       ; own resource cards: (id . card-or-nil)
  (discard '())                         ; card-or-nil
  (deck 0 :type fixnum))

(defstruct (world (:copier nil))
  (round 0)
  (phase "action")
  (initiative nil)
  (me nil)
  (op nil))

(defun copy-side* (s)
  (let ((c (make-side)))
    (setf (side-seat c) (side-seat s)
          (side-base-id c) (side-base-id s)
          (side-base-card c) (side-base-card s)
          (side-base-hp c) (side-base-hp s)
          (side-base-dmg c) (side-base-dmg s)
          (side-units c) (mapcar #'copy-unit (side-units s))
          (side-leader-id c) (side-leader-id s)
          (side-leader-card c) (side-leader-card s)
          (side-leader-deployed c) (side-leader-deployed s)
          (side-leader-exhausted c) (side-leader-exhausted s)
          (side-ready-res c) (side-ready-res s)
          (side-total-res c) (side-total-res s)
          (side-hand c) (side-hand s)
          (side-hand-count c) (side-hand-count s)
          (side-resources c) (side-resources s)
          (side-discard c) (side-discard s)
          (side-deck c) (side-deck s))
    c))

(defun copy-world* (w)
  (make-world :round (world-round w) :phase (world-phase w) :initiative (world-initiative w)
              :me (copy-side* (world-me w)) :op (copy-side* (world-op w))))

;;; ------------------------------------------------------------------ reading the observation

(defun ref-card (ref)
  (find-card :set (jget ref "s") :title (jget ref "n")))

(defun parse-unit (ref arena)
  (let ((shields (count-if (lambda (u) (equal (jget u "n") "Shield")) (jget ref "u"))))
    (make-unit :id (or (jget ref "id") "")
               :name (or (jget ref "n") "")
               :card (ref-card ref)
               :power (max 0 (jnum ref "p"))
               :hp (jnum ref "h")
               :dmg (jnum ref "d")
               :ready (/= 1 (jnum ref "x"))
               :sentinel (= 1 (jnum ref "sn"))
               :shields shields
               :arena arena)))

(defun parse-side (p seat)
  (let* ((leader (jget p "leader"))
         (side (make-side
                :seat seat
                :base-id (or (jget p "base" "id") "")
                :base-card (ref-card (jget p "base"))
                :base-hp (let ((hp (jnum p "base" "hp"))) (if (plusp hp) hp 30))
                :base-dmg (jnum p "base" "d")
                :units (append (mapcar (lambda (r) (parse-unit r :ground)) (jget p "ground"))
                               (mapcar (lambda (r) (parse-unit r :space)) (jget p "space")))
                :leader-id (and leader (jget leader "id"))
                :leader-card (and leader (ref-card leader))
                :leader-deployed (and leader (= 1 (jnum leader "dep")))
                :leader-exhausted (and leader (= 1 (jnum leader "x")))
                :ready-res (jnum p "res" "ready")
                :total-res (jnum p "res" "total")
                :hand (mapcar (lambda (r) (cons (jget r "id") (ref-card r))) (jget p "hand"))
                :hand-count (jnum p "handCount")
                :resources (mapcar (lambda (r) (cons (jget r "id") (ref-card r))) (jget p "resources"))
                :discard (mapcar #'ref-card (jget p "discard"))
                :deck (jnum p "deck"))))
    ;; a deployed leader is listed as a unit with the leader's title
    (when (side-leader-deployed side)
      (let ((lc (side-leader-card side)))
        (dolist (u (side-units side))
          (when (and lc (string= (unit-name u) (card-title lc)))
            (setf (unit-leader u) t)))))
    side))

(defun other-seat (seat)
  (if (equal seat "p1") "p2" "p1"))

(defun parse-world (state you)
  (make-world :round (jnum state "round")
              :phase (or (jget state "phase") "action")
              :initiative (jget state "initiative")
              :me (parse-side (jget state "players" you) you)
              :op (parse-side (jget state "players" (other-seat you)) (other-seat you))))

;;; ------------------------------------------------------------------ queries

(defun hp-left (u) (- (unit-hp u) (unit-dmg u)))
(defun base-left (side) (- (side-base-hp side) (side-base-dmg side)))

(defun find-unit (w id)
  "The unit with uuid ID and the side that controls it."
  (dolist (s (list (world-me w) (world-op w)) (values nil nil))
    (let ((u (find id (side-units s) :key #'unit-id :test #'equal)))
      (when u (return (values u s))))))

(defun base-owner (w id)
  (cond ((equal id (side-base-id (world-me w))) (world-me w))
        ((equal id (side-base-id (world-op w))) (world-op w))))

(defun enemy-of (w side)
  (if (eq side (world-me w)) (world-op w) (world-me w)))

(defun unit-kw (u keyword) (card-has (unit-card u) keyword))
(defun unit-raid (u) (if (unit-card u) (card-raid (unit-card u)) 0))
(defun unit-restore (u) (if (unit-card u) (card-restore (unit-card u)) 0))

(defun attack-power (u)
  (+ (unit-power u) (unit-raid u)))

(defun legal-targets (w side u)
  "Units U (controlled by SIDE) may attack, as a list of units, plus :BASE when the base is open."
  (let* ((enemy (enemy-of w side))
         (same (remove-if-not (lambda (e) (eq (unit-arena e) (unit-arena u))) (side-units enemy)))
         (sentinels (remove-if-not #'unit-sentinel same)))
    (if (and sentinels (not (unit-kw u :saboteur)))
        sentinels
        (cons :base same))))

;;; ------------------------------------------------------------------ effects

(defun remove-unit (w u)
  (multiple-value-bind (found side) (find-unit w (unit-id u))
    (when found
      (setf (side-units side) (remove found (side-units side))))))

(defun damage-unit (w u n)
  "Deal N damage to U (a shield absorbs it). Returns the excess beyond lethal, or NIL if it survived."
  (cond ((<= n 0) nil)
        ((plusp (unit-shields u)) (decf (unit-shields u)) nil)
        (t (incf (unit-dmg u) n)
           (if (<= (hp-left u) 0)
               (prog1 (- (unit-dmg u) (unit-hp u))
                 (remove-unit w u))
               nil))))

(defun damage-base (side n)
  (setf (side-base-dmg side) (min (side-base-hp side) (+ (side-base-dmg side) (max 0 n)))))

(defun heal-base (side n)
  (setf (side-base-dmg side) (max 0 (- (side-base-dmg side) (max 0 n)))))

(defun simulate-attack (w attacker-id target)
  "Copy of W after the unit ATTACKER-ID attacks TARGET (a unit id or :BASE)."
  (let ((w (copy-world* w)))
    (multiple-value-bind (a side) (find-unit w attacker-id)
      (unless a (return-from simulate-attack w))
      (let ((enemy (enemy-of w side))
            (power (attack-power a)))
        (setf (unit-ready a) nil)
        (heal-base side (unit-restore a))
        (if (eq target :base)
            (damage-base enemy power)
            (let ((d (find-unit w target)))
              (when d
                (when (unit-kw a :saboteur) (setf (unit-shields d) 0))
                (let ((back (unit-power d))
                      (excess (damage-unit w d power)))
                  (when (and excess (unit-kw a :overwhelm))
                    (damage-base enemy excess))
                  (damage-unit w a back)))))))
    w))

(defun add-unit (w side card id &key ready)
  "Put CARD into play for SIDE as a new unit (exhausted unless READY)."
  (let ((u (make-unit :id id :name (card-title card) :card card
                      :power (card-power card) :hp (max 1 (card-hp card))
                      :ready ready :sentinel (card-has card :sentinel)
                      :shields (if (card-has card :shielded) 1 0)
                      :arena (or (card-arena card) :ground))))
    (push u (side-units side))
    (when (eq side (world-me w)) (decf (side-ready-res side) (card-cost card)))
    u))

;;; ------------------------------------------------------------------ evaluation

(defparameter *power-weight* 1.5)
(defparameter *hp-weight* 0.7)
(defparameter *ready-weight* 0.4)

(defun unit-value (u)
  (+ (* *power-weight* (unit-power u))
     (* *hp-weight* (max 0 (hp-left u)))
     (* 1.5 (unit-shields u))
     (if (unit-sentinel u) 0.5 0)
     (* 0.5 (unit-raid u))
     (if (unit-kw u :overwhelm) 0.5 0)
     (if (unit-leader u) -1.0 0)))

(defun hp-point-weight (k)
  "How much the K-th remaining point of base HP is worth: low points matter more."
  (cond ((> k 15) 0.8)
        ((> k 10) 1.0)
        (t (+ 1.0 (* 0.15 (- 10 k))))))

(defun base-value (side)
  (let ((left (base-left side)))
    (if (<= left 0)
        -1000.0
        (loop for k from 1 to left sum (hp-point-weight k)))))

(defun total-power (side)
  (loop for u in (side-units side) sum (attack-power u)))

(defun side-value (side &key (ready-term t))
  (+ (loop for u in (side-units side)
           sum (+ (unit-value u)
                  (if (and ready-term (unit-ready u)) (* *ready-weight* (unit-power u)) 0)))
     (base-value side)))

(defun evaluate (w)
  "Score of W from the bot's seat: material, base HP (low HP weighs more) and next-round lethal threats."
  (let* ((me (world-me w)) (op (world-op w))
         (score (- (side-value me) (side-value op))))
    (when (and (<= (base-left op) 0)) (return-from evaluate 1000.0))
    (when (<= (base-left me) 0) (return-from evaluate -1000.0))
    (when (>= (total-power op) (base-left me)) (decf score 6))
    (when (>= (total-power me) (base-left op)) (incf score 4))
    score))

;;; ------------------------------------------------------------------ one-ply search inside the model

(defun attack-options (w side)
  "Every (attacker-id . target) open to SIDE's ready units; target is a unit id or :BASE."
  (loop for u in (side-units side)
        when (and (unit-ready u) (plusp (attack-power u)))
          append (loop for tgt in (legal-targets w side u)
                       collect (cons (unit-id u) (if (eq tgt :base) :base (unit-id tgt))))))

(defun opponent-reply (w)
  "W after the opponent's best single attack in the model (or W itself if no attack helps them)."
  (let ((best w) (best-score (evaluate w)))
    (loop for (a . tgt) in (attack-options w (world-op w))
          do (let* ((w2 (simulate-attack w a tgt))
                    (s (evaluate w2)))
               (when (< s best-score)
                 (setf best w2 best-score s))))
    best))

(defun score-after (w)
  "Evaluation of W once the opponent has answered with their best attack."
  (evaluate (opponent-reply w)))

(defun best-attack (w u)
  "Best target for own unit U: (values target score) where score is SCORE-AFTER of the attack."
  (let ((best nil) (best-score most-negative-double-float))
    (dolist (tgt (legal-targets w (world-me w) u))
      (let* ((id (if (eq tgt :base) :base (unit-id tgt)))
             (s (score-after (simulate-attack w (unit-id u) id))))
        (when (> s best-score)
          (setf best id best-score s))))
    (values best best-score)))
