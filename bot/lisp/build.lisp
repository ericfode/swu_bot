;;;; Build the bot as one executable with the card data inside:
;;;;   sbcl --non-interactive --load bot/lisp/build.lisp      (from the repo root)
;;;; Writes bot/lisp/swu-lisp. Card JSON comes from $SWU_CARD_JSON or forceteki/test/json.

(defparameter *here* (directory-namestring (or *load-truename* *default-pathname-defaults*)))
(ensure-directories-exist (merge-pathnames "fasl/" *here*))
(dolist (f '("package" "json" "cards" "intent" "world" "policy" "main"))
  (load (compile-file (merge-pathnames (format nil "src/~a.lisp" f) *here*)
                      :output-file (merge-pathnames (format nil "fasl/~a.fasl" f) *here*))))
(format t "~&cards: ~d~%" (swu:load-cards))
(sb-ext:save-lisp-and-die (merge-pathnames "swu-lisp" *here*) :executable t :toplevel #'swu:main)
