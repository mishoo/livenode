Livenode -- Live-code your NodeJS application
=============================================

Livenode is a small tool that allows me to evaluate arbitrary
statements in a live NodeJS program, without restarting the server.
This way I can introduce new functions/variables, or redefine existing
ones, and immediately test without losing any context.

See my [blog post](http://lisperator.net/livenode-live-code-your-nodejs-application/)
and [screencast](http://vimeo.com/60636079).

I've been using it for a week and am quite satisfied with it, but it's
essentially a quick hack and bugs are likely.


Install
-------

Just git clone the repository for now and symlink `bin/livenode`
somewhere into your `$PATH`.


Use with Emacs
--------------

This is only tested with Emacs 24.

You need the WebSocket library: [https://github.com/ahyatt/emacs-websocket](https://github.com/ahyatt/emacs-websocket).

Place `livenode.el` somewhere in your Emacs load path, then add
`(require 'livenode)` to your `.emacs`.  To start your NodeJS server
with Livenode, just use `livenode path/to/your/app.js`.  Then you can
connect Emacs to the server with `M-x livenode` and you can use the
following:

- `C-M-x` -- evaluate the statement at point
- `C-c C-r` -- evaluate the region
- `M-x livenode-gencode-region` -- do code rewriting on region


Other editors
-------------

If your favorite editor is programmable, chances are it will be
trivial to add support for it.  You need a JSON library and a
WebSocket client library.  Patches are welcome.


Editor API
----------

Communication between editor and server happens over a WebSocket
connection.

### Protocol

Messages that travel over this websocket are JSON-encoded arrays
containing two or more elements:

    REQUEST . . . . . [ ID, "COMMAND", ARG* ]    // editor → server
    RESPONSE  . . . . [ ID, "COMMAND", RESULT ]  // server → editor
    NOTIFICATION  . . [ 0, "error", ERROR ]      // server → editor

The first element is a request ID.  When replying to some particular
request, the server will include its ID so you can match the result on
the editor side (this is necessary since the protocol is fully
asynchronous and there's no classic notion of "response to some
request" as in HTTP).

The client (editor) should be prepared to receive anytime
notifications (those will have the ID == 0).  The only notification
supported for now is "error" (this string will be the second element
of the array) -- the server will send this in the case of an unhandled
exception (those normally bring down the server, but Livenode catches
them and forwards to the editor).

When there is an immediate error handling a particular request, the
response will contain the string "error" in the second element (rather
than the command name) and the error instead of the result.  Note that
this is different from an unhandled exception.

### API

The following commands are supported at this time:

- `"eval" (filename, code)` -- evaluate `code` in the context of the
  module loaded from `filename`.  `filename` must be the absolute,
  fully-resolved (no symlinks) path name of the module.

- `"eval_at_pos" (filename, code, pos)` -- evaluate the statement at a
  given position (`pos`) in the context of the module identified by
  `filename`.  Note that `code` should be the whole code in the
  editor, for this case, and `pos` is the cursor position (1-based).
  I decided to do it this way to lift the burden of parsing and
  figuring out the statement from the editor—since we already have a
  proper parser on the server.

- `"rewrite_code" (filename, code)` -- apply code rewriting on the
  given `code` assuming the context of the module identified by
  `filename`.

Both "eval" and "eval_at_pos" return an object that looks like this:

    { code: code, // the rewritten code that has been evaluated
      warn: [ WARNING* ], // an array of warnings
      result: ... }

Additionally, "eval_at_pos" will also include in this object two
integers, `begin` and `end`, which tell us the position of the
statement that has been evaluated (I'm using this in Emacs to flash
the statement after evaluation).

The warnings currently reported are only for undeclared variables.  A
warning looks like this:

    { message: "i.e. Undeclared variable...",
      begin: POSITION,
      end: POSITION }

Again, `begin` and `end` are positions that the editor can use to
highlight the code that triggered the warning (i.e. the undeclared
variable, for now).

Other kinds of warnings might be added in the future.
