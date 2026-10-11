;;;; Reading prompt and card text with s-expression patterns.
;;;;
;;;; Text becomes a token list: lowercase words, signed integers ("+2" -> 2, "–2" -> -2) and "/".
;;;; A pattern is a string of tokens where ?x binds one number, _ matches any one token and * any run.
;;;; DEFINTENTS builds an ordered rule table; READ-INTENT picks the rule that matches EARLIEST in the text
;;;; (the main verb of a sentence usually comes first), so "Deal 1 damage to a unit and draw a card" is damage.

(in-package :swu)

(defun sign-char-p (ch)
  (member ch '(#\+ #\- #.(code-char #x2013) #.(code-char #x2212))))

(defun tokenize (text)
  (let ((tokens '()) (i 0) (n (length text)))
    (loop while (< i n)
          do (let ((ch (char text i)))
               (cond
                 ;; signed or plain integer
                 ((or (digit-char-p ch)
                      (and (sign-char-p ch) (< (1+ i) n) (digit-char-p (char text (1+ i)))))
                  (let ((sign (if (member ch '(#\- #.(code-char #x2013) #.(code-char #x2212))) -1 1))
                        (j (if (digit-char-p ch) i (1+ i))))
                    (let ((k j))
                      (loop while (and (< k n) (digit-char-p (char text k))) do (incf k))
                      (push (* sign (parse-integer text :start j :end k)) tokens)
                      (setf i k))))
                 ((alpha-char-p ch)
                  (let ((k i))
                    (loop while (and (< k n) (or (alpha-char-p (char text k)) (member (char text k) '(#\' #.(code-char #x2019)))))
                          do (incf k))
                    (push (string-downcase (remove-if-not #'alpha-char-p (subseq text i k))) tokens)
                    (setf i k)))
                 ((char= ch #\/) (push "/" tokens) (incf i))
                 (t (incf i)))))
    (nreverse tokens)))

(defun compile-pattern (string)
  "\"deal ?n damage *\" -> (\"deal\" (:num . ?n) \"damage\" :star)"
  (loop for word in (let ((parts '()) (start 0))
                      (loop for k = (position #\Space string :start start)
                            do (push (subseq string start k) parts)
                               (if k (setf start (1+ k)) (return)))
                      (nreverse (remove "" parts :test #'string=)))
        collect (cond ((string= word "*") :star)
                      ((string= word "_") :any)
                      ((char= (char word 0) #\?) (cons :num (intern (string-upcase word) :swu)))
                      (t word))))

(defun match-here (pat toks bindings)
  "Match PAT against the front of TOKS. Returns (values matched-p bindings)."
  (cond ((null pat) (values t bindings))
        ((eq (car pat) :star)
         (loop for rest = toks then (cdr rest)
               do (multiple-value-bind (ok b) (match-here (cdr pat) rest bindings)
                    (when ok (return-from match-here (values t b))))
               while rest)
         (values nil nil))
        ((null toks) (values nil nil))
        ((eq (car pat) :any) (match-here (cdr pat) (cdr toks) bindings))
        ((and (consp (car pat)) (eq (caar pat) :num))
         (if (integerp (car toks))
             (match-here (cdr pat) (cdr toks) (acons (cdar pat) (car toks) bindings))
             (values nil nil)))
        ((equal (car pat) (car toks)) (match-here (cdr pat) (cdr toks) bindings))
        (t (values nil nil))))

(defun match-anywhere (pat toks)
  "Earliest position where PAT matches inside TOKS: (values position bindings), or NIL."
  (loop for rest on toks
        for k from 0
        do (multiple-value-bind (ok b) (match-here pat rest '())
             (when ok (return-from match-anywhere (values k b)))))
  nil)

(defun fill-template (template bindings)
  (cond ((and (symbolp template) (assoc template bindings)) (cdr (assoc template bindings)))
        ((consp template) (cons (fill-template (car template) bindings) (fill-template (cdr template) bindings)))
        (t template)))

(defmacro defintents (name &body rules)
  "Each rule is (\"pattern\" template). The template may use the pattern's ?variables."
  `(defparameter ,name
     (list ,@(loop for (pattern template) in rules
                   collect `(cons (compile-pattern ,pattern) ',template)))))

(defun read-intent (text table &optional (default '(:neutral)))
  "The template of the rule in TABLE that matches earliest in TEXT, with its bindings filled in."
  (let ((toks (if (listp text) text (tokenize text)))
        (best nil) (best-pos nil))
    (dolist (rule table)
      (multiple-value-bind (pos b) (match-anywhere (car rule) toks)
        (when (and pos (or (null best-pos) (< pos best-pos)))
          (setf best-pos pos
                best (fill-template (cdr rule) b)))))
    (let ((form (or best default)))
      (if (listp form) form (list form)))))

;;; What a targeting prompt does to the card picked. Read from the prompt title.
(defintents *target-intents*
  ("choose a target for attack" (:attack-target))
  ("attack with" (:attacker))
  ("deal ?n damage" (:damage ?n))
  ("defeat" (:defeat))
  ("captures" (:capture))
  ("capture" (:capture))
  ("return * to * hand" (:bounce))
  ("take control" (:steal))
  ("takes control" (:steal))
  ("exhaust" (:exhaust))
  ("ready" (:ready))
  ("heal ?n" (:heal ?n))
  ("shield token" (:shield))
  ("shield tokens" (:shield))
  ("experience token" (:buff 1 1))
  ("experience tokens" (:buff 1 1))
  ("advantage token" (:buff 1 0))
  ("weakness token" (:buff -1 -1))
  ("?p / ?h" (:buff ?p ?h))
  ("can't attack" (:neutralize))
  ("can't deal" (:neutralize))
  ("loses all" (:neutralize))
  ("lose all" (:neutralize))
  ("gains sentinel" (:sentinel))
  ("gain sentinel" (:sentinel))
  ("discard" (:discard))
  ("discards" (:discard))
  ("attach" (:attach))
  ("play" (:play))
  ("draw" (:draw))
  ("exploit" (:sacrifice)))

;;; What an event card does when played, for valuing it in the action window. Read from the card text.
(defintents *event-intents*
  ("deal ?n damage to each" (:sweep ?n))
  ("deal ?n damage to a unit" (:damage ?n))
  ("deal ?n damage to an enemy unit" (:damage ?n))
  ("deal ?n damage to a ground unit" (:damage ?n))
  ("deal ?n damage to a space unit" (:damage ?n))
  ("deal ?n damage to a base" (:face ?n))
  ("deal ?n damage" (:damage ?n))
  ("defeat a" (:defeat))
  ("defeat an" (:defeat))
  ("defeat each" (:wipe))
  ("capture" (:defeat))
  ("captures" (:defeat))
  ("return * unit * to * hand" (:bounce))
  ("take control" (:steal))
  ("exhaust" (:exhaust))
  ("?p / ?h" (:buff ?p ?h))
  ("shield token" (:shield))
  ("experience token" (:buff 1 1))
  ("attack with" (:attack))
  ("heal ?n" (:heal ?n))
  ("draw ?n cards" (:draw ?n))
  ("draw a card" (:draw 1))
  ("draw" (:draw 1))
  ("create" (:create))
  ("search" (:search))
  ("play" (:cheat)))

;;; Which player a "choose a player" style button should name.
(defintents *player-intents*
  ("discard" (:opponent))
  ("discards" (:opponent))
  ("damage" (:opponent))
  ("defeat" (:opponent))
  ("exhaust" (:opponent))
  ("mill" (:opponent))
  ("draw" (:self))
  ("draws" (:self))
  ("ready" (:self))
  ("heal" (:self))
  ("create" (:self))
  ("initiative" (:self)))
