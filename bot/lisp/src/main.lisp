;;;; stdio protocol loop (spec/stdio-protocol.md): one JSON line in, one JSON line out.

(in-package :swu)

(defun reply (out obj)
  (write-string (json-string obj) out)
  (write-char #\Newline out)
  (force-output out))

(defun safe-index (actions)
  "Fallback when the policy fails: a Done or Pass button, else the first action."
  (or (position-if (lambda (a) (or (done-button-p a) (member (jget a "arg") '("pass" "done") :test #'equal))) actions)
      0))

(defun answer (msg)
  (let ((type (jget msg "t")))
    (cond
      ((equal type "hello")
       (new-game (jnum msg "seed"))
       (trace-line "hello ~a seat ~a" (jget msg "bot") (jget msg "you"))
       (list :obj (cons "t" "ready") (cons "v" 1) (cons "name" "lisp")))
      ((equal type "decide")
       (multiple-value-bind (i dist)
           (handler-case (choose msg)
             (error (e)
               (format *error-output* "lisp bot: ~a (seq ~a); using a safe default~%" e (jget msg "seq"))
               (values (safe-index (jget msg "actions")) nil)))
         (trace-line "~a ~a | ~a -> ~a" (jget msg "seq") (jget msg "prompt" "signature")
                     (jget msg "prompt" "title") (jget (nth i (jget msg "actions")) "label"))
         (if dist
             (list :obj (cons "t" "act") (cons "i" i)
                   (cons "distribution" (mapcar (lambda (d) (list :obj (cons "id" (car d)) (cons "amount" (cdr d)))) dist)))
             (list :obj (cons "t" "act") (cons "i" i)))))
      (t (list :obj (cons "t" "error") (cons "error" (format nil "unknown message ~a" type)))))))

(defun main ()
  (let ((in (sb-sys:make-fd-stream 0 :input t :external-format :utf-8 :buffering :full))
        (out (sb-sys:make-fd-stream 1 :output t :external-format :utf-8 :buffering :full))
        (log (sb-ext:posix-getenv "SWU_LISP_TRACE")))
    (when (zerop (hash-table-count *cards-by-name*))
      (format *error-output* "lisp bot: ~d cards loaded from ~a~%" (load-cards) (card-json-dir)))
    (let ((*trace* (and log (plusp (length log))
                        (open log :direction :output :if-exists :append :if-does-not-exist :create))))
      (loop for line = (read-line in nil nil)
            while line
            when (plusp (length (string-trim " " line)))
              do (reply out (handler-case (answer (parse-json line))
                              (error (e) (list :obj (cons "t" "error") (cons "error" (princ-to-string e))))))))
    (sb-ext:exit :code 0 :abort t)))
