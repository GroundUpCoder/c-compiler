#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

// ---- Types ----

enum { T_NUM, T_SYM, T_CONS, T_NIL, T_FN, T_LAMBDA };

__struct Val { int tag; __eqref data; };
__struct Cons { __struct Val *car; __struct Val *cdr; };
__struct Env { __struct Val *key; __struct Val *val; __struct Env *parent; };
__struct Lambda { __struct Val *params; __struct Val *body; __struct Env *env; };

// ---- Constructors ----

__struct Val *make_num(int n) {
    return __new(__struct Val, T_NUM, n);
}

__struct Val *make_sym(__array(unsigned char) name) {
    return __new(__struct Val, T_SYM, name);
}

__struct Val *make_cons(__struct Val *car, __struct Val *cdr) {
    return __new(__struct Val, T_CONS, __new(__struct Cons, car, cdr));
}

__struct Val *NIL;
__struct Val *SYM_T;

int is_nil(__struct Val *v) { return v == NIL; }

__struct Cons *as_cons(__struct Val *v) {
    return __cast(__struct Cons *, v->data);
}

__struct Val *car(__struct Val *v) { return as_cons(v)->car; }
__struct Val *cdr(__struct Val *v) { return as_cons(v)->cdr; }
int as_num(__struct Val *v) { return __cast(int, v->data); }

__array(unsigned char) as_sym(__struct Val *v) {
    return __cast(__array(unsigned char), v->data);
}

// ---- Symbol helpers ----

__struct Val *sym(char *s) {
    auto len = (int)strlen(s);
    auto name = __array_new(unsigned char, len);
    for (auto i = 0; i < len; i++) name[i] = s[i];
    return make_sym(name);
}

int sym_eq(__array(unsigned char) a, __array(unsigned char) b) {
    if (__array_len(a) != __array_len(b)) return 0;
    for (auto i = 0; i < __array_len(a); i++)
        if (a[i] != b[i]) return 0;
    return 1;
}

int sym_is(__struct Val *v, char *s) {
    if (v->tag != T_SYM) return 0;
    auto name = as_sym(v);
    auto len = (int)strlen(s);
    if (__array_len(name) != len) return 0;
    for (auto i = 0; i < len; i++)
        if (name[i] != s[i]) return 0;
    return 1;
}

void print_sym(__array(unsigned char) name) {
    for (auto i = 0; i < __array_len(name); i++)
        putchar(name[i]);
}

// ---- Parser ----

char *input;
int pos;

void skip_ws() {
    while (input[pos] && isspace(input[pos])) pos++;
}

__struct Val *parse_expr();

__struct Val *parse_atom() {
    skip_ws();
    auto c = input[pos];

    if (isdigit(c) || (c == '-' && isdigit(input[pos + 1]))) {
        auto sign = 1;
        if (c == '-') { sign = -1; pos++; }
        auto n = 0;
        while (isdigit(input[pos]))
            n = n * 10 + (input[pos++] - '0');
        return make_num(sign * n);
    }

    auto start = pos;
    while (input[pos] && !isspace(input[pos]) && input[pos] != '(' && input[pos] != ')')
        pos++;
    auto len = pos - start;
    auto name = __array_new(unsigned char, len);
    for (auto i = 0; i < len; i++)
        name[i] = input[start + i];
    return make_sym(name);
}

__struct Val *parse_list() {
    skip_ws();
    if (input[pos] == ')') { pos++; return NIL; }
    auto first = parse_expr();
    auto rest = parse_list();
    return make_cons(first, rest);
}

__struct Val *parse_expr() {
    skip_ws();
    if (input[pos] == '\'') {
        pos++;
        return make_cons(sym("quote"), make_cons(parse_expr(), NIL));
    }
    if (input[pos] == '(') { pos++; return parse_list(); }
    return parse_atom();
}

// ---- Printer ----

void print_val(__struct Val *v) {
    if (is_nil(v)) { printf("nil"); return; }
    switch (v->tag) {
        case T_NUM: printf("%d", as_num(v)); break;
        case T_SYM: print_sym(as_sym(v)); break;
        case T_FN:  printf("<builtin>"); break;
        case T_LAMBDA: printf("<lambda>"); break;
        case T_CONS: {
            printf("(");
            auto cur = v;
            while (!is_nil(cur) && cur->tag == T_CONS) {
                if (cur != v) printf(" ");
                print_val(car(cur));
                cur = cdr(cur);
            }
            if (!is_nil(cur)) { printf(" . "); print_val(cur); }
            printf(")");
            break;
        }
    }
}

// ---- Environment ----

__struct Env *global_env;

__struct Env *env_set(__struct Env *env, __struct Val *key, __struct Val *val) {
    return __new(__struct Env, key, val, env);
}

__struct Val *env_get(__struct Env *env, __struct Val *key) {
    for (auto e = env; e; e = e->parent) {
        if (e->key && sym_eq(as_sym(e->key), as_sym(key)))
            return e->val;
    }
    // fall back to global env
    if (env != global_env) {
        for (auto e = global_env; e; e = e->parent) {
            if (e->key && sym_eq(as_sym(e->key), as_sym(key)))
                return e->val;
        }
    }
    printf("error: undefined symbol '");
    print_sym(as_sym(key));
    printf("'\n");
    return NIL;
}

// ---- Eval ----

__struct Val *eval(__struct Val *expr, __struct Env *env);

__struct Val *eval_list(__struct Val *list, __struct Env *env) {
    if (is_nil(list)) return NIL;
    return make_cons(eval(car(list), env), eval_list(cdr(list), env));
}

__struct Env *bind_params(__struct Val *params, __struct Val *args, __struct Env *env) {
    if (is_nil(params)) return env;
    return bind_params(cdr(params), cdr(args),
                       env_set(env, car(params), car(args)));
}

int list_len(__struct Val *v) {
    auto n = 0;
    while (!is_nil(v)) { n++; v = cdr(v); }
    return n;
}

__struct Val *eval(__struct Val *expr, __struct Env *env) {
    if (is_nil(expr)) return NIL;
    if (expr->tag == T_NUM) return expr;

    // symbol: "nil" resolves to NIL, otherwise env lookup
    if (expr->tag == T_SYM) {
        if (sym_is(expr, "nil")) return NIL;
        return env_get(env, expr);
    }

    if (expr->tag != T_CONS) return NIL;

    auto head = car(expr);
    auto args = cdr(expr);

    // special forms
    if (head->tag == T_SYM) {
        if (sym_is(head, "quote")) return car(args);

        if (sym_is(head, "if")) {
            auto cond = eval(car(args), env);
            if (!is_nil(cond) && !(cond->tag == T_NUM && as_num(cond) == 0))
                return eval(car(cdr(args)), env);
            return eval(car(cdr(cdr(args))), env);
        }

        if (sym_is(head, "define")) {
            auto val = eval(car(cdr(args)), env);
            global_env = env_set(global_env, car(args), val);
            return val;
        }

        if (sym_is(head, "lambda")) {
            auto lam = __new(__struct Lambda, car(args), car(cdr(args)), env);
            return __new(__struct Val, T_LAMBDA, lam);
        }
    }

    // function call
    auto fn = eval(head, env);
    auto evaled = eval_list(args, env);

    if (fn->tag == T_FN) {
        auto id = as_num(fn);
        auto a1 = is_nil(evaled) ? NIL : car(evaled);
        auto a2 = is_nil(evaled) || is_nil(cdr(evaled)) ? NIL : car(cdr(evaled));

        switch (id) {
            case 0: return make_num(as_num(a1) + as_num(a2));
            case 1: return make_num(as_num(a1) - as_num(a2));
            case 2: return make_num(as_num(a1) * as_num(a2));
            case 3: return make_num(as_num(a1) / as_num(a2));
            case 4: return as_num(a1) == as_num(a2) ? SYM_T : NIL;
            case 5: return as_num(a1) < as_num(a2) ? SYM_T : NIL;
            case 6: return make_cons(a1, a2);
            case 7: return car(a1);
            case 8: return cdr(a1);
            case 9: return is_nil(a1) ? SYM_T : NIL;
            case 10: print_val(a1); printf("\n"); return a1;
            case 11: return make_num(list_len(a1));
        }
        return NIL;
    }

    if (fn->tag == T_LAMBDA) {
        auto lam = __cast(__struct Lambda *, fn->data);
        auto new_env = bind_params(lam->params, evaled, lam->env);
        return eval(lam->body, new_env);
    }

    printf("error: not callable: ");
    print_val(fn);
    printf("\n");
    return NIL;
}

// ---- Builtins ----

__struct Val *make_fn(int id) {
    return __new(__struct Val, T_FN, id);
}

void init_global_env() {
    global_env = __new(__struct Env, 0, 0, 0);
    global_env = env_set(global_env, sym("+"), make_fn(0));
    global_env = env_set(global_env, sym("-"), make_fn(1));
    global_env = env_set(global_env, sym("*"), make_fn(2));
    global_env = env_set(global_env, sym("/"), make_fn(3));
    global_env = env_set(global_env, sym("="), make_fn(4));
    global_env = env_set(global_env, sym("<"), make_fn(5));
    global_env = env_set(global_env, sym("cons"), make_fn(6));
    global_env = env_set(global_env, sym("car"), make_fn(7));
    global_env = env_set(global_env, sym("cdr"), make_fn(8));
    global_env = env_set(global_env, sym("nil?"), make_fn(9));
    global_env = env_set(global_env, sym("print"), make_fn(10));
    global_env = env_set(global_env, sym("length"), make_fn(11));
    global_env = env_set(global_env, sym("t"), SYM_T);
}

void run(char *code) {
    input = code;
    pos = 0;
    auto expr = parse_expr();
    auto result = eval(expr, global_env);
    printf("=> ");
    print_val(result);
    printf("\n");
}

int main() {
    NIL = __new(__struct Val, T_NIL, 0);
    SYM_T = sym("t");
    init_global_env();

    printf("--- arithmetic ---\n");
    run("(+ 1 2)");
    run("(* (+ 2 3) (- 10 4))");

    printf("\n--- lists ---\n");
    run("(cons 1 (cons 2 (cons 3 nil)))");
    run("(car (cons 10 20))");
    run("(cdr (cons 10 20))");
    run("(length (cons 1 (cons 2 (cons 3 nil))))");

    printf("\n--- lambda + define ---\n");
    run("(define square (lambda (x) (* x x)))");
    run("(square 7)");
    run("(square 12)");

    printf("\n--- higher-order: map ---\n");
    run("(define map (lambda (f lst) (if (nil? lst) nil (cons (f (car lst)) (map f (cdr lst))))))");
    run("(map square (cons 1 (cons 2 (cons 3 (cons 4 (cons 5 nil))))))");

    printf("\n--- recursion ---\n");
    run("(define fact (lambda (n) (if (= n 0) 1 (* n (fact (- n 1))))))");
    run("(fact 10)");

    run("(define fib (lambda (n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2))))))");
    run("(fib 15)");

    printf("\n--- closures ---\n");
    run("(define make-adder (lambda (n) (lambda (x) (+ n x))))");
    run("(define add5 (make-adder 5))");
    run("(add5 10)");
    run("(add5 100)");

    printf("\n--- quote ---\n");
    run("'(1 2 3)");
    run("(car '(a b c))");

    return 0;
}
