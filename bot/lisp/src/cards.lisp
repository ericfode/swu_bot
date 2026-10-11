;;;; Card database: costs, stats, aspects and keywords from the engine's card JSON.
;;;;
;;;; The protocol sends card titles, set codes and internal names, not costs, so the bot reads
;;;; forceteki/test/json/Card/*.json (or $SWU_CARD_JSON/Card). build.lisp loads it once and saves it in the image.

(in-package :swu)

(defstruct card
  (name "" :type string)                ; internal name, e.g. "luke-skywalker#faithful-friend"
  (title "" :type string)
  (cost 0 :type fixnum)
  (power 0 :type fixnum)
  (hp 0 :type fixnum)
  (aspects '() :type list)              ; keywords, e.g. (:heroism :vigilance)
  (types '() :type list)                ; (:unit) (:event) (:upgrade) (:leader) (:base) (:token)
  (keywords '() :type list)             ; (:sentinel :overwhelm ...)
  (arena nil)                           ; :ground / :space / nil
  (text "" :type string)
  (upgrade-power 0 :type fixnum)
  (upgrade-hp 0 :type fixnum)
  (raid 0 :type fixnum)                 ; Raid N: extra power when attacking
  (restore 0 :type fixnum))             ; Restore N: heal own base when attacking

(defvar *cards-by-name* (make-hash-table :test 'equal))
(defvar *cards-by-set* (make-hash-table :test 'equal))
(defvar *cards-by-title* (make-hash-table :test 'equal))

(defun kw (string)
  (intern (string-upcase (substitute #\- #\Space string)) :keyword))

(defun keyword-amount (text word)
  "\"Raid 2\" -> 2 when TEXT starts a line or sentence with WORD followed by a number."
  (let ((k (search word text :test #'char-equal)))
    (if k
        (or (ignore-errors (parse-integer text :start (+ k (length word) 1) :junk-allowed t)) 0)
        0)))

(defun set-code (set number)
  (format nil "~a_~3,'0d" set number))

(defun card-from-json (j)
  (let ((text (or (jget j "text") "")))
    (make-card :name (or (jget j "internalName") "")
               :title (or (jget j "title") "")
               :cost (or (jget j "cost") 0)
               :power (or (jget j "power") 0)
               :hp (or (jget j "hp") 0)
               :aspects (mapcar #'kw (jget j "aspects"))
               :types (mapcar #'kw (jget j "types"))
               :keywords (mapcar #'kw (jget j "keywords"))
               :arena (let ((a (jget j "arena"))) (and a (kw a)))
               :text text
               :upgrade-power (or (jget j "upgradePower") 0)
               :upgrade-hp (or (jget j "upgradeHp") 0)
               :raid (keyword-amount text "Raid")
               :restore (keyword-amount text "Restore"))))

(defun read-file-string (path)
  (with-open-file (in path :external-format :utf-8)
    (let* ((s (make-string (file-length in)))
           (n (read-sequence s in)))
      (subseq s 0 n))))

(defun card-json-dir ()
  (let ((env (sb-ext:posix-getenv "SWU_CARD_JSON")))
    (if (and env (plusp (length env)))
        (concatenate 'string (string-right-trim "/" env) "/")
        "forceteki/test/json/")))

(defun load-cards (&optional (dir (card-json-dir)))
  "Fill the card tables from DIR/Card/*.json. Returns the number of cards read."
  (clrhash *cards-by-name*) (clrhash *cards-by-set*) (clrhash *cards-by-title*)
  (let ((count 0))
    (dolist (path (directory (concatenate 'string dir "Card/*.json")))
      (let ((j (ignore-errors (parse-json (read-file-string path)))))
        (when (consp j) (setf j (car j)))
        (when (hash-table-p j)
          (let ((c (card-from-json j)))
            (incf count)
            (setf (gethash (card-name c) *cards-by-name*) c)
            (unless (gethash (card-title c) *cards-by-title*)
              (setf (gethash (card-title c) *cards-by-title*) c))
            (dolist (sc (or (jget j "setCodes") (list (jget j "setId"))))
              (when (and (jget sc "set") (jget sc "number"))
                (setf (gethash (set-code (jget sc "set") (jget sc "number")) *cards-by-set*) c)))))))
    count))

(defun find-card (&key name set title)
  "Look a card up by internal name, then set code, then title."
  (or (and name (gethash name *cards-by-name*))
      (and set (gethash set *cards-by-set*))
      (and title (gethash title *cards-by-title*))))

(defun card-is (card type)
  (and card (member type (card-types card))))

(defun card-has (card keyword)
  (and card (member keyword (card-keywords card))))
