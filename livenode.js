var u2 = require("uglify-js");
var WS = require("ws");
var sys = require("util");

var Module = module.constructor; // inception

var NODEVARS = {
    "exports"    : true,
    "require"    : true,
    "module"     : true,
    "__filename" : true,
    "__dirname"  : true,
    "undefined"  : true,
    "NaN"        : true,
    "Infinity"   : true,
    "arguments"  : true
};

function setup(port) {
    if (!port) port = 8010;

    new WS.Server({ port: port })
        .on("connection", WS_Connection.handler);

    var eval_in_module = u2.parse(function eval_in_module($__STAT) {
        var $__X = module.$__REWRITE_GLOBALS($__STAT, $__CONTEXT);
        $__X.result = eval($__X.code);
        return $__X;
    }.toString()).print_to_string({ beautify: true });

    // install custom code wrapper that does the rewriting
    Module.wrap = function(code) {
        var code ="(function (exports, require, module, __filename, __dirname) { " +
            //"console.log(__filename); " +
            "var $__CONTEXT = module.$__CONTEXT = Object.create(null); " +
            rewrite_globals(code).code +
            "module.$__EVAL = " + eval_in_module + ";\n" +
            "\n});";
        // sys.error("****************************************************************************")
        // sys.error(code);
        return code;
    };
};

exports.setup = setup;

var WS_Connection = (function(){
    var clients = [];
    var has_trap = false;
    function get_module(filename) {
        var module = Module._cache[filename];
        if (!module) {
            throw new Error("Module " + filename + " not loaded");
        }
        return module;
    }
    var commands = {
        eval: function(filename, code) {
            return get_module(filename).$__EVAL(code);
        },
        eval_at_pos: function(filename, code, pos) {
            var info = get_info(code, pos);
            var stat = info.path[1] || info.prev_stat;
            var result = get_module(filename).$__EVAL(stat);
            result.begin = stat.start.pos + 1;
            result.end = stat.end.endpos + 1;
            return result;
        },
        rewrite_code: function(filename, code) {
            var mod = get_module(filename);
            return rewrite_globals(code, mod.$__CONTEXT).code;
        }
    };
    function execute(ws, x) {
        var id = x[0];
        var cmd = x[1];
        var args = x.slice(2);
        var handler = commands[cmd];
        try {
            var result = handler.apply(ws, args);
            ws.send(JSON.stringify([ id, cmd, result ], null, 4));
        } catch(ex) {
            if (ex instanceof Error) {
                ex = {
                    name    : ex.name,
                    message : ex.message
                };
            }
            ws.send(JSON.stringify([ id, "error", ex ], null, 4));
        }
    };
    return {
        handler: function(ws) {
            sys.error("Livenode client connected");
            clients.push(ws);
            ws.on("message", function(msg){
                var data = JSON.parse(msg);
                execute(ws, data);
            });
            ws.on("close", function(){
                clients.splice(clients.indexOf(ws), 1);
            });
            ws.send(JSON.stringify("OH HI"));

            if (!has_trap) {
                process.on("uncaughtException", function(err){
                    console.log(err);
                    if (err instanceof Error) {
                        console.log(err.stack);
                        err = err.toString();
                    }
                    clients.forEach(function(socket){
                        socket.send(JSON.stringify([ 0, "error", err ]));
                    });
                });
                has_trap = true;
            }
        }
    };
})();

function get_info(code, pos) {
    code = code.replace(/^#!/, "//");
    var ast = u2.parse(code);
    var exit = {};
    var best_node;
    var prev_stat;
    var path = [];
    try {
        var tw = new u2.TreeWalker(function(node, descend){
            if (node.start.pos > pos)
                throw exit;
            if (node.start.pos <= pos && node.end.endpos >= pos) {
                best_node = node;
                path.push(node);
            }
            if (node instanceof u2.AST_Statement
                && tw.parent() instanceof u2.AST_Toplevel) {
                prev_stat = node;
            }
        });
        ast.walk(tw);
    } catch(ex) {
        if (ex !== exit) throw ex;
    }
    return {
        path: path,
        node: best_node,
        prev_stat: prev_stat
    };
};

function rewrite_globals(code, ctx) {
    var ast;
    if (code instanceof u2.AST_Node) {
        ast = new u2.AST_Toplevel({
            body: [ code ]
        });
    } else {
        ast = u2.parse(code);
    }
    ast.figure_out_scope({ screw_ie: true });
    var hoisted = [];
    var warnings = [];
    function in_context(sym) {
        if (ctx) {
            return sym.name in ctx;
        } else {
            return sym.global() && !sym.undeclared();
        }
    };
    var tt = new u2.TreeTransformer(function before(node, descend){
        if (node instanceof u2.AST_Defun && node.name.global()) {
            descend(node, this);
            hoisted.push(node);
            return u2.MAP.skip;
        }
        if (node === ast) {
            // toplevel node, we should apply function hoisting
            descend(node, this);
            hoisted = hoisted.map(function(defun){
                return new u2.AST_SimpleStatement({
                    body: new u2.AST_Assign({
                        operator: "=",
                        left: new u2.AST_Dot({
                            expression: new u2.AST_SymbolRef({ name: "$__CONTEXT" }),
                            property: defun.name.name
                        }),
                        right: new u2.AST_Function(defun)
                    })
                });
            });
            node.body = hoisted.concat(node.body);
            return node;
        }
        if (node instanceof u2.AST_SymbolRef && in_context(node)) {
            return new u2.AST_Dot({
                expression: new u2.AST_SymbolRef({ name: "$__CONTEXT" }),
                property: node.name
            });
        }
        if (node instanceof u2.AST_SymbolRef && node.undeclared()) {
            if (!global[node.name] && !NODEVARS[node.name]) {
                warnings.push({
                    message: "Undeclared variable: " + node.name,
                    begin: node.start.pos + 1,
                    end: node.end.endpos + 1
                });
            }
        }
        if (node instanceof u2.AST_ForIn
            && node.init instanceof u2.AST_Definitions
            && node.name.global())
        {
            descend(node, this);
            node.init = node.init.body.left;
            node.name = null;
            return node;
        }
        if (node instanceof u2.AST_Definitions && this.find_parent(u2.AST_Scope) === ast) {
            descend(node, this);
            var p = this.parent();
            var body = u2.AST_Seq.from_array(node.definitions.map(function(def){
                return new u2.AST_Assign({
                    operator: "=",
                    left: new u2.AST_Dot({
                        expression: new u2.AST_SymbolRef({ name: "$__CONTEXT" }),
                        property: def.name.name
                    }),
                    right: def.value || new u2.AST_Undefined()
                });
            }));
            if (!(p instanceof u2.AST_For && p.init === node))
                body = new u2.AST_SimpleStatement({ body: body });
            return body;
        }
        if (node instanceof u2.AST_Assign
            && node.operator == "="
            && node.left instanceof u2.AST_Dot
            && node.left.expression instanceof u2.AST_SymbolRef
            && node.left.expression.name == "exports"
            && !in_context(node.left.expression)
            && node.right instanceof u2.AST_SymbolRef)
        {
            descend(node, this);

            // this is the ugliest.
            // we convert exports.foo = bar into:
            //
            // exports.__defineGetter__("foo", function(){ return bar }),
            // exports.__defineSetter__("foo", function(v){
            //   exports.__defineGetter__("foo", function(){ return v });
            // })
            //
            // this way we emulate the functionality of exports.bar
            // while allowing it to refer to "global" (module)
            // variables that might be changed later, i.e. bar would
            // turn to $__CONTEXT.bar.

            var prop = node.left.property instanceof u2.AST_Node
                ? node.left.property
                : new u2.AST_String({ value: node.left.property });

            var exp = new u2.AST_Seq({
                car: new u2.AST_Call({
                    expression: new u2.AST_Dot({
                        expression: node.left.expression,
                        property: "__defineGetter__"
                    }),
                    args: [
                        prop,
                        new u2.AST_Lambda({
                            argnames: [],
                            body: [
                                new u2.AST_Return({ value: node.right })
                            ]
                        })
                    ]
                }),
                cdr: new u2.AST_Call({
                    expression: new u2.AST_Dot({
                        expression: node.left.expression,
                        property: "__defineSetter__"
                    }),
                    args: [
                        prop,
                        new u2.AST_Lambda({
                            argnames: [ new u2.AST_SymbolFunarg({ name: "v" }) ],
                            body: [
                                new u2.AST_SimpleStatement({
                                    body: new u2.AST_Call({
                                        expression: new u2.AST_Dot({
                                            expression: node.left.expression,
                                            property: "__defineGetter__"
                                        }),
                                        args: [
                                            prop,
                                            new u2.AST_Lambda({
                                                argnames: [],
                                                body: [
                                                    new u2.AST_Return({
                                                        value: new u2.AST_SymbolRef({ name: "v" })
                                                    })
                                                ]
                                            })
                                        ]
                                    })
                                })
                            ]
                        })
                    ]
                })
            }); // lisp has been good to me  ;^(

            if (this.parent() instanceof u2.AST_SimpleStatement)
                return exp;

            return new u2.AST_Seq({
                car: exp,
                cdr: new u2.AST_Dot(node.left)
            });
        }
    });
    ast = ast.transform(tt);
    code = ast.print_to_string({ beautify: true });
    return {
        code: code,
        warn: warnings
    };
};

Module.prototype.$__REWRITE_GLOBALS = rewrite_globals;
