;;;; Load the sources into a running Lisp (REPL or --script use, no build step).
(defparameter *swu-here* (directory-namestring (or *load-truename* *default-pathname-defaults*)))
(dolist (f '("package" "json" "cards" "intent" "world" "policy" "main"))
  (load (merge-pathnames (format nil "src/~a.lisp" f) *swu-here*)))
