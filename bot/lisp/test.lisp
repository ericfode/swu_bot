;;;; Unit tests on mock boards (no engine, no card files):  sbcl --script bot/lisp/test.lisp

(load (merge-pathnames "load.lisp" (directory-namestring *load-truename*)))
(in-package :swu)

(defvar *failures* 0)
(defvar *count* 0)

(defmacro check (name form)
  `(progn
     (incf *count*)
     (unless (ignore-errors ,form)
       (incf *failures*)
       (format t "FAIL ~a~%" ,name))))

(defun add-test-card (json)
  (let ((c (card-from-json (parse-json json))))
    (setf (gethash (card-name c) *cards-by-name*) c
          (gethash (card-title c) *cards-by-title*) c)
    c))

(add-test-card "{\"internalName\":\"wampa\",\"title\":\"Wampa\",\"cost\":4,\"power\":4,\"hp\":5,\"aspects\":[\"aggression\"],\"types\":[\"unit\"],\"keywords\":[],\"arena\":\"ground\"}")
(add-test-card "{\"internalName\":\"cheap-guy\",\"title\":\"Cheap Guy\",\"cost\":1,\"power\":1,\"hp\":2,\"aspects\":[\"villainy\"],\"types\":[\"unit\"],\"keywords\":[],\"arena\":\"ground\"}")
(add-test-card "{\"internalName\":\"takedown\",\"title\":\"Takedown\",\"cost\":4,\"text\":\"Defeat a unit with 5 or less remaining HP.\",\"aspects\":[],\"types\":[\"event\"],\"keywords\":[]}")
(add-test-card "{\"internalName\":\"vader\",\"title\":\"Darth Vader\",\"cost\":7,\"power\":5,\"hp\":7,\"aspects\":[\"aggression\",\"villainy\"],\"types\":[\"leader\"],\"keywords\":[],\"arena\":\"ground\"}")
(add-test-card "{\"internalName\":\"brute\",\"title\":\"Brute\",\"cost\":5,\"power\":4,\"hp\":4,\"aspects\":[],\"types\":[\"unit\"],\"keywords\":[\"overwhelm\"],\"text\":\"Overwhelm\",\"arena\":\"ground\"}")

(defun state-json (&key (my-ground "[]") (op-ground "[]") (op-base-d 0) (my-base-d 0) (ready 4) (total 4) (hand "[]"))
  (format nil "{\"round\":3,\"phase\":\"action\",\"initiative\":\"p2\",\"players\":{
     \"p1\":{\"base\":{\"id\":\"b1\",\"n\":\"Base\",\"hp\":30,\"d\":~d},\"leader\":{\"id\":\"l1\",\"n\":\"Darth Vader\",\"dep\":0,\"x\":0},
            \"res\":{\"ready\":~d,\"total\":~d},\"handCount\":1,\"hand\":~a,\"ground\":~a,\"space\":[],\"discard\":[]},
     \"p2\":{\"base\":{\"id\":\"b2\",\"n\":\"Base\",\"hp\":30,\"d\":~d},\"leader\":null,\"res\":{\"ready\":0,\"total\":4},
            \"handCount\":3,\"ground\":~a,\"space\":[],\"discard\":[]}}}"
          my-base-d ready total hand my-ground op-base-d op-ground))

(defun decide (prompt state actions)
  (new-game 7)
  (choose (parse-json (format nil "{\"t\":\"decide\",\"seq\":1,\"you\":\"p1\",\"prompt\":~a,\"state\":~a,\"actions\":~a}"
                              prompt state actions))))

(defparameter +window+ "{\"type\":\"actionWindow\",\"signature\":\"actionWindow|-\",\"title\":\"Choose an action\",\"promptTitle\":\"Action Window\",\"selectCardMode\":null,\"selected\":[],\"actionWindow\":true}")
(defparameter +attack+ "{\"type\":null,\"signature\":\"-|single\",\"title\":\"Choose a target for attack\",\"promptTitle\":\"Rebel\",\"selectCardMode\":\"single\",\"selected\":[],\"actionWindow\":false}")

;;; JSON
(check "json round trip"
       (let ((j (parse-json "{\"a\":[1,2.5,\"x\\\"y\\u00e9\"],\"b\":true,\"c\":null,\"d\":{}}")))
         (and (equal (jget j "a" 0) 1) (= (jget j "a" 1) 2.5d0) (equal (jget j "a" 2) (format nil "x\"y~a" (code-char 233)))
              (eq (jget j "b") t) (null (jget j "c"))
              (equal (json-string (list :obj (cons "t" "act") (cons "i" 3))) "{\"t\":\"act\",\"i\":3}"))))

;;; text patterns
(check "tokenize signs" (equal (tokenize "Give a unit –2/+0 for this phase") '("give" "a" "unit" -2 "/" 0 "for" "this" "phase")))
(check "damage intent" (equal (read-intent "Deal 3 damage to a unit and draw a card" *target-intents*) '(:damage 3)))
(check "buff intent" (equal (read-intent "Give a unit +2/+2 for this phase" *target-intents*) '(:buff 2 2)))
(check "earliest verb wins" (equal (read-intent "Defeat a friendly upgrade on a unit. If you do, give a Shield token to that unit" *target-intents*) '(:defeat)))
(check "attack target intent" (equal (read-intent "Choose a target for attack" *target-intents*) '(:attack-target)))
(check "player intent" (eq (car (read-intent "Choose a player. That player discards a card" *player-intents*)) :opponent))
(check "wanted between" (equal (multiple-value-list (wanted-range "Select between 0 and 1 cards to resource")) '(0 1)))
(check "wanted fixed" (equal (multiple-value-list (wanted-range "Select 2 cards to resource")) '(2 2)))
(check "wanted up to" (equal (multiple-value-list (wanted-range "Choose up to 4 cards")) '(0 4)))

;;; combat model
(let ((w (parse-world (parse-json (state-json :my-ground "[{\"id\":\"u1\",\"n\":\"Brute\",\"p\":4,\"h\":4,\"d\":0}]"
                                              :op-ground "[{\"id\":\"e1\",\"n\":\"Guy\",\"p\":1,\"h\":2,\"d\":0}]"))
                      "p1")))
  (check "overwhelm spills to base"
         (let ((w2 (simulate-attack w "u1" "e1")))
           (and (null (find-unit w2 "e1")) (= (side-base-dmg (world-op w2)) 2) (= (unit-dmg (find-unit w2 "u1")) 1)
                (not (unit-ready (find-unit w2 "u1"))))))
  (check "model copies do not share units"
         (progn (simulate-attack w "u1" :base) (unit-ready (find-unit w "u1")))))

(let ((w (parse-world (parse-json (state-json :my-ground "[{\"id\":\"u1\",\"n\":\"Rebel\",\"p\":3,\"h\":3,\"d\":0}]"
                                              :op-ground "[{\"id\":\"e1\",\"n\":\"Wall\",\"p\":1,\"h\":5,\"d\":0,\"sn\":1}]"))
                      "p1")))
  (check "sentinel blocks the base" (equal (mapcar #'unit-id (legal-targets w (world-me w) (find-unit w "u1"))) '("e1"))))

;;; knapsack
(check "spend uses the budget" (equal (sort (best-spend '((a 1 2.0) (b 4 6.0) (c 5 6.5)) 5) #'string< :key #'symbol-name) '(a b)))

;;; action window and targets
(check "plays the big unit and holds removal with no target"
       (= 2 (decide +window+ (state-json :hand "[{\"id\":\"h1\",\"n\":\"Cheap Guy\"},{\"id\":\"h2\",\"n\":\"Wampa\"},{\"id\":\"h3\",\"n\":\"Takedown\"}]")
                    "[{\"i\":0,\"kind\":\"button\",\"label\":\"Pass\",\"arg\":\"pass\"},
                      {\"i\":1,\"kind\":\"card\",\"label\":\"cheap-guy\",\"card\":{\"id\":\"h1\",\"n\":\"Cheap Guy\",\"zone\":\"hand\",\"ctl\":\"p1\"}},
                      {\"i\":2,\"kind\":\"card\",\"label\":\"wampa\",\"card\":{\"id\":\"h2\",\"n\":\"Wampa\",\"zone\":\"hand\",\"ctl\":\"p1\"}},
                      {\"i\":3,\"kind\":\"card\",\"label\":\"takedown\",\"card\":{\"id\":\"h3\",\"n\":\"Takedown\",\"zone\":\"hand\",\"ctl\":\"p1\"}}]")))

(check "attacks for lethal"
       (= 2 (decide +window+ (state-json :my-ground "[{\"id\":\"u1\",\"n\":\"Rebel\",\"p\":3,\"h\":3,\"d\":0}]" :op-base-d 27
                                         :hand "[{\"id\":\"h2\",\"n\":\"Wampa\"}]")
                    "[{\"i\":0,\"kind\":\"button\",\"label\":\"Pass\",\"arg\":\"pass\"},
                      {\"i\":1,\"kind\":\"card\",\"label\":\"wampa\",\"card\":{\"id\":\"h2\",\"n\":\"Wampa\",\"zone\":\"hand\",\"ctl\":\"p1\"}},
                      {\"i\":2,\"kind\":\"card\",\"label\":\"rebel\",\"card\":{\"id\":\"u1\",\"n\":\"Rebel\",\"zone\":\"groundArena\",\"ctl\":\"p1\"}}]")))

(check "claims the initiative when nothing helps"
       (= 1 (decide +window+ (state-json :ready 0)
                    "[{\"i\":0,\"kind\":\"button\",\"label\":\"Pass\",\"arg\":\"pass\"},{\"i\":1,\"kind\":\"button\",\"label\":\"Claim Initiative\",\"arg\":\"claimInitiative\"}]")))

(defparameter +targets+
  "[{\"i\":0,\"kind\":\"button\",\"label\":\"Cancel\",\"arg\":\"cancel\"},
    {\"i\":1,\"kind\":\"card\",\"label\":\"base\",\"card\":{\"id\":\"b2\",\"zone\":\"base\",\"ctl\":\"p2\"}},
    {\"i\":2,\"kind\":\"card\",\"label\":\"x\",\"card\":{\"id\":\"e1\",\"zone\":\"groundArena\",\"ctl\":\"p2\"}}]")

(check "trades up into a ready 2/2"
       (= 2 (decide +attack+ (state-json :my-ground "[{\"id\":\"u1\",\"n\":\"Rebel\",\"p\":3,\"h\":4,\"d\":0}]"
                                         :op-ground "[{\"id\":\"e1\",\"n\":\"Guy\",\"p\":2,\"h\":2,\"d\":0}]")
                    +targets+)))
(check "goes face instead of suiciding into a 6/7"
       (= 1 (decide +attack+ (state-json :my-ground "[{\"id\":\"u1\",\"n\":\"Rebel\",\"p\":3,\"h\":4,\"d\":0}]"
                                         :op-ground "[{\"id\":\"e1\",\"n\":\"Guy\",\"p\":6,\"h\":7,\"d\":0}]")
                    +targets+)))

(check "damage event goes for the kill"
       (= 1 (decide "{\"type\":null,\"signature\":\"-|single\",\"title\":\"Deal 3 damage to a unit\",\"promptTitle\":\"Zap\",\"selectCardMode\":\"single\",\"selected\":[],\"actionWindow\":false}"
                    (state-json :op-ground "[{\"id\":\"e1\",\"n\":\"Big\",\"p\":6,\"h\":7,\"d\":0},{\"id\":\"e2\",\"n\":\"Mid\",\"p\":3,\"h\":3,\"d\":0}]")
                    "[{\"i\":0,\"kind\":\"card\",\"label\":\"big\",\"card\":{\"id\":\"e1\",\"zone\":\"groundArena\",\"ctl\":\"p2\"}},
                      {\"i\":1,\"kind\":\"card\",\"label\":\"mid\",\"card\":{\"id\":\"e2\",\"zone\":\"groundArena\",\"ctl\":\"p2\"}}]")))

(check "cancels a play that has no effect"
       (= 1 (decide "{\"type\":null,\"signature\":\"-|-\",\"title\":\"Playing Zap will have no effect. Are you sure you want to play it?\",\"promptTitle\":\"Framework effect\",\"selectCardMode\":null,\"selected\":[],\"actionWindow\":false}"
                    (state-json) "[{\"i\":0,\"kind\":\"button\",\"label\":\"Play anyway\",\"arg\":0},{\"i\":1,\"kind\":\"button\",\"label\":\"Cancel\",\"arg\":1}]")))

(check "resources the far-off card"
       (= 1 (decide "{\"type\":\"resource\",\"signature\":\"resource|multiple\",\"title\":\"Select 1 cards to resource\",\"promptTitle\":\"Resource Step\",\"selectCardMode\":\"multiple\",\"selected\":[],\"actionWindow\":false}"
                    (state-json :total 2 :hand "[{\"id\":\"h1\",\"n\":\"Cheap Guy\"},{\"id\":\"h2\",\"n\":\"Takedown\"}]")
                    "[{\"i\":0,\"kind\":\"card\",\"label\":\"cheap-guy\",\"card\":{\"id\":\"h1\",\"zone\":\"hand\",\"ctl\":\"p1\"}},
                      {\"i\":1,\"kind\":\"card\",\"label\":\"takedown\",\"card\":{\"id\":\"h2\",\"zone\":\"hand\",\"ctl\":\"p1\"}}]")))

;;; multi-select loop guard: a click that did not register is not repeated
(check "presses Done when a multi-select click does not register"
       (let ((prompt "{\"type\":null,\"signature\":\"-|multiple\",\"title\":\"Choose units to deal 1 damage to\",\"promptTitle\":\"Zap\",\"selectCardMode\":\"multiple\",\"selected\":[\"e9\",\"e8\"],\"actionWindow\":false}")
             (state (state-json :op-ground "[{\"id\":\"e1\",\"n\":\"Guy\",\"p\":2,\"h\":2,\"d\":0}]"))
             (actions "[{\"i\":0,\"kind\":\"button\",\"label\":\"Done\",\"arg\":\"done\"},{\"i\":1,\"kind\":\"button\",\"label\":\"Cancel\",\"arg\":\"cancel\"},
                       {\"i\":2,\"kind\":\"card\",\"label\":\"guy\",\"card\":{\"id\":\"e1\",\"zone\":\"groundArena\",\"ctl\":\"p2\"}}]"))
         (new-game 7)
         (flet ((ask () (choose (parse-json (format nil "{\"t\":\"decide\",\"seq\":1,\"you\":\"p1\",\"prompt\":~a,\"state\":~a,\"actions\":~a}" prompt state actions)))))
           (and (= 2 (ask)) (= 0 (ask))))))

;;; distribute
(let ((w (parse-world (parse-json (state-json :op-ground "[{\"id\":\"e1\",\"n\":\"A\",\"p\":2,\"h\":2,\"d\":0},{\"id\":\"e2\",\"n\":\"B\",\"p\":5,\"h\":6,\"d\":0}]")) "p1")))
  (check "split kills then goes face"
         (equal (split-distribution w (parse-json "{\"type\":\"distributeDamage\",\"amount\":5,\"targets\":[{\"id\":\"e1\",\"cap\":null},{\"id\":\"e2\",\"cap\":null},{\"id\":\"b2\",\"cap\":null}]}"))
                '(("e1" . 2) ("b2" . 3))))
  (check "own indirect damage lands on the own base"
         (equal (split-distribution w (parse-json "{\"type\":\"distributeIndirectDamage\",\"amount\":3,\"targets\":[{\"id\":\"b1\",\"cap\":null}]}"))
                '(("b1" . 3)))))

(format t "~d/~d checks passed~%" (- *count* *failures*) *count*)
(sb-ext:exit :code (if (zerop *failures*) 0 1))
