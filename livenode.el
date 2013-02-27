;;; -*- lexical-binding: t -*-

(require 'websocket)
(require 'json)
(require 'cl)

(defvar *livenode-socket* nil)
(defvar *livenode-pending-handlers*
  '((0 . %livenode-notification-handler)))
(defvar *livenode-request-id* 0)

(defface livenode-highlight-okay
  '((((background dark))
     :background "dark olive green")
    (((background light))
     :background "chartreuse"))
  "[Livenode] Face for highlighting code with no warnings"
  :group 'livenode)

(defface livenode-highlight-warn
  '((((background dark))
     :background "orange red")
    (((background light))
     :background "gold"))
  "[Livenode] Face for highlighting code with warnings"
  :group 'livenode)

(defun %livenode-notification-handler (cmd &rest args)
  (cond
   ((string= cmd "error")
    (message "UNHANDLED EXCEPTION: %s" (car args)))))

(defun livenode-connect (host port)
  (setq *livenode-socket*
        (websocket-open
         (format "ws://%s:%d/" host port)
         :on-message (lambda (ws frame)
                       (%livenode-handle-message ws (websocket-frame-payload frame)))
         :on-close (lambda (ws)
                     (%livenode-handle-close ws)))))

(defun livenode-disconnect ()
  (when *livenode-socket*
    (websocket-close *livenode-socket*)
    (setq *livenode-socket* nil)
    (livenode 0)))

(defun %livenode-handle-message (socket msg)
  (let ((data (let ((json-array-type 'list))
                (json-read-from-string msg))))
    (cond
     ((and (stringp data)
           (string= data "OH HI"))
      (message "Livenode connected"))
     (t
      (destructuring-bind (id cmd result) data
        (let ((handler (cdr (assq id *livenode-pending-handlers*))))
          (when handler
            (funcall handler cmd result)))
        (unless (zerop id)
          (assq-delete-all id *livenode-pending-handlers*)))))))

(defun %livenode-handle-close (socket)
  (message "Livenode disconnected")
  (setq *livenode-socket* nil)
  (livenode 0))

(defun livenode-call (cmd args &optional handler)
  "Send a command to the Livenode server.  Arguments are:
  - cmd (string) -- the command name
  - args (list) -- a list of arguments to pass to the function
  - handler (function) -- optionally a handler that will receive the returned value"
  (%livenode-want-socket)
  (incf *livenode-request-id*)
  (when handler
    (push (cons *livenode-request-id* handler)
          *livenode-pending-handlers*))
  (websocket-send-text *livenode-socket*
                       (json-encode `(,*livenode-request-id*
                                      ,cmd
                                      ,@args))))

(defun livenode-eval-region (begin end)
  "Evaluate the code within the region."
  (interactive "r")
  (let ((filename (file-truename (buffer-file-name)))
        (code (buffer-substring-no-properties begin end)))
    (livenode-call "eval" (list filename code)
                   (lambda (cmd msg)
                     (message "%s" msg)))))

(defun livenode-gencode-region (begin end)
  "Evaluate the code within the region."
  (interactive "r")
  (let ((filename (file-truename (buffer-file-name)))
        (code (buffer-substring-no-properties begin end)))
    (livenode-call "rewrite_code" (list filename code)
                   (lambda (cmd msg)
                     (message "%s" msg)))))

(defun %livenode-want-socket ()
  (unless *livenode-socket*
    (error "Not connected")))

(defun %livenode-delete-overlay (ov &rest args)
  (delete-overlay ov))

(defun %livenode-delete-overlays ()
  (remove-overlays (point-min) (point-max) 'livenode t))

(put '%livenode-overlay 'modification-hooks (list '%livenode-delete-overlay))
(put '%livenode-overlay 'insert-in-front-hooks (list '%livenode-delete-overlay))
(put '%livenode-overlay 'insert-behind-hooks (list '%livenode-delete-overlay))
(put '%livenode-overlay 'livenode t)
(put '%livenode-overlay 'face 'livenode-highlight-warn)
(put '%livenode-overlay 'evaporate t)

(defun livenode-eval-statement (pos)
  "Evaluate the toplevel statement that contains the given position."
  (interactive "d")
  (let ((filename (file-truename (buffer-file-name)))
        (code (buffer-substring-no-properties (point-min) (point-max))))
    (%livenode-delete-overlays)
    (livenode-call "eval_at_pos" (list filename code (point))
                   (lambda (cmd ret)
                     (cond
                      ((string= cmd "error") (message "ERROR: %s" ret))
                      (t
                       (let* ((begin (cdr (assq 'begin ret)))
                              (end (cdr (assq 'end ret)))
                              (result (cdr (assq 'result ret)))
                              (warnings (cdr (assq 'warn ret)))
                              (hl (and begin end (make-overlay begin end))))
                         (when hl
                           (overlay-put hl 'face (if warnings
                                                     'livenode-highlight-warn
                                                   'livenode-highlight-okay))
                           (run-with-timer 0.5 nil
                                           (lambda (hl)
                                             (delete-overlay hl)) hl))
                         (message "%s" result)
                         (dolist (w warnings)
                           (let* ((message (cdr (assq 'message w)))
                                  (begin (cdr (assq 'begin w)))
                                  (end (cdr (assq 'end w)))
                                  (hl (and begin end (make-overlay begin end))))
                             (when hl
                               (overlay-put hl 'category '%livenode-overlay)
                               (overlay-put hl 'help-echo message)))))))))))

(define-minor-mode %livenode-mode
  "Internal minor mode used by `livenode'."
  :init-value nil
  :lighter " Live"
  :global nil
  :keymap `(
            (,(kbd "C-M-x") . livenode-eval-statement)
            (,(kbd "C-c C-r") . livenode-eval-region)
            ))

(defun %livenode-mode-maybe ()
  (%livenode-mode (if livenode 1 0)))

(define-minor-mode livenode
  "Minor mode providing C-M-x to inject code into a living NodeJS process"
  nil "" nil
  :global t

  (cond (livenode
         (let ((host (read-string "Host (localhost): " nil nil "localhost"))
               (port (read-number "Port: " 8010)))
           (livenode-connect host port)))
        (t
         (livenode-disconnect)))
  (dolist (buf (buffer-list))
    (with-current-buffer buf
      (when (eq 'js-mode major-mode)
        (%livenode-mode-maybe)))))

(add-hook 'js-mode-hook '%livenode-mode-maybe)

(provide 'livenode)
