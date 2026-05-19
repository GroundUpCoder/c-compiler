#!/usr/bin/env node
"use strict";

const AST = (() => {

  class Program {
    constructor(loc, functions) {
      this.loc = loc;
      this.functions = functions;
    }
  }

  class Function {
    constructor(loc, returnType, name, parameters, body) {
      this.loc = loc;
      this.returnType = returnType;
      this.name = name;
      this.parameters = parameters; // Variable[]
      this.body = body; // single Block
    }
  }

  class Block {
    constructor(loc, statements) {
      this.loc = loc;
      this.statements = statements;
    }
  }

  class Literal {
    constructor(loc, type, value) {
      this.loc = loc;
      this.type = type;   // 'i32', 'i64', 'f32', 'f64'
      this.value = value; // number (for i32/f32/f64) or BigInt (for i64)
    }
  }

  class Variable {
    constructor(loc, type, name) {
      this.loc = loc;
      this.type = type; // 'i32', 'i64', 'f32', 'f64'
      this.name = name;
    }
  }

  class Declare {
    constructor(loc, variable, initializer) {
      this.loc = loc;
      this.variable = variable; // Variable
      this.initializer = initializer; // Expression or null
    }
  }

  class Assign {
    constructor(loc, variable, value) {
      this.loc = loc;
      this.variable = variable; // Variable
      this.value = value; // Expression
    }
  }

  // Supported binops:
  //   +, -, *, /, % (integer and float)
  //   ==, !=, <, <=, >, >= (integer and float comparisons)
  class Binary {
    constructor(loc, op, left, right) {
      this.loc = loc;
      this.op = op; // e.g. '+', '-', '*', '/', '==', '<', etc.
      this.left = left;   // Expression
      this.right = right; // Expression
    }
  }

  class Unary {
    constructor(loc, op, operand) {
      this.loc = loc;
      this.op = op; // e.g. '-', '!'
      this.operand = operand; // Expression
    }
  }

  // c ? t : e — both arms must produce the same type; result is that type.
  // Short-circuit: only one of t/e is evaluated.
  class Ternary {
    constructor(loc, cond, thenExpr, elseExpr) {
      this.loc = loc;
      this.cond = cond;          // Expression
      this.thenExpr = thenExpr;  // Expression
      this.elseExpr = elseExpr;  // Expression
    }
  }

  // Function call expression. `callee` is a direct reference to the
  // target AST.Function — resolved by the parser against its prototype
  // table at parse time, so all type info (return type, parameter types)
  // is reachable via the callee.
  class Call {
    constructor(loc, callee, args) {
      this.loc = loc;
      this.callee = callee;      // AST.Function
      this.args = args;          // Expression[]
    }
  }

  // A statement that evaluates an expression and discards the result.
  // Used for calls that are invoked for their side effects only
  // (e.g. `f(x);`). All other expressions are value-only and the parser
  // never wraps them as statements.
  class ExpressionStatement {
    constructor(loc, expr) {
      this.loc = loc;
      this.expr = expr;
    }
  }

  // Block-bodied switch — cases are inline marker statements within the body
  // (like Label), not separate Blocks. This makes fallthrough natural and lets
  // case labels appear inside nested control flow (e.g. Duff's device).
  class Switch {
    constructor(loc, value, body) {
      this.loc = loc;
      this.value = value; // Expression
      this.body = body;   // Block (may contain Case markers anywhere)
    }
  }

  // Inline marker: `case N:` or `default:`. value === null means default.
  // Lowered like a Label — each Case marker becomes a BasicBlock target,
  // and the enclosing Switch emits a dispatch table to those blocks.
  class Case {
    constructor(loc, value) {
      this.loc = loc;
      this.value = value; // number | null  (null = default)
    }
  }

  class If {
    constructor(loc, cond, thenBlock, elseBlock) {
      this.loc = loc;
      this.cond = cond; // Expression
      this.thenBlock = thenBlock; // Block
      this.elseBlock = elseBlock; // Block or null
    }
  }

  class While {
    constructor(loc, cond, body) {
      this.loc = loc;
      this.cond = cond; // Expression
      this.body = body; // Block
    }
  }

  class Break {
    constructor(loc) {
      this.loc = loc;
    }
  }

  // Just a marker: `name:` in source. Goto targets resolve by walking the
  // enclosing block. A later lifting pass turns flat labels + gotos into
  // structured control flow before emitWasm.
  class Label {
    constructor(loc, name) {
      this.loc = loc;
      this.name = name; // string (label name)
    }
  }

  class Goto {
    constructor(loc, target) {
      this.loc = loc;
      this.target = target; // string (label name)
    }
  }

  class Return {
    constructor(loc, value) {
      this.loc = loc;
      this.value = value; // Expression (no void in this language)
    }
  }

  const TYPE = (() => {
    // `&&` and `||` are also "i32-result" ops (like comparisons): they
    // produce a normalized 0 or 1 i32, regardless of operand types.
    const I32_RESULT = new Set(['==', '!=', '<', '<=', '>', '>=', '&&', '||']);

    const of = (e) => {
      if (e instanceof AST.Literal) return e.type;
      if (e instanceof AST.Variable) return e.type;
      if (e instanceof AST.Binary) return I32_RESULT.has(e.op) ? 'i32' : of(e.left);
      if (e instanceof AST.Unary) return e.op === '!' ? 'i32' : of(e.operand);
      if (e instanceof AST.Ternary) return of(e.thenExpr);
      if (e instanceof AST.Call) return e.callee.returnType;
      throw new Error('AST.TYPE.of: ' + e.constructor.name);
    };

    return { of };
  })();

  // ─────────────────────── AST pretty-printer ─────────────────────────
  //
  // Renders an AST.Program back to c1 source text. Used by the Lifted tab
  // to display intoAST's output as readable source (which the user can
  // paste back into the editor for re-compilation).
  const printSource = (program) => {
    const PREC = {
      '||': 1, '&&': 2,
      '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
      '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
    };

    const printExpr = (e, parentPrec = 0) => {
      if (e instanceof Literal) {
        if (e.type === 'i64') return e.value.toString() + 'L';
        if (e.type === 'f32') return Number(e.value).toString() + 'f';
        if (e.type === 'f64') {
          const s = Number(e.value).toString();
          return s.includes('.') || s.includes('e') ? s : s + '.0';
        }
        return e.value.toString();
      }
      if (e instanceof Variable) return e.name;
      if (e instanceof Unary) {
        const inner = printExpr(e.operand, 7);
        return `${e.op}${inner}`;
      }
      if (e instanceof Binary) {
        const p = PREC[e.op] ?? 0;
        const s = `${printExpr(e.left, p)} ${e.op} ${printExpr(e.right, p + 1)}`;
        return p < parentPrec ? `(${s})` : s;
      }
      if (e instanceof Ternary) {
        // `?:` is right-associative with the lowest precedence.
        const s = `${printExpr(e.cond, 1)} ? ${printExpr(e.thenExpr, 0)} : ${printExpr(e.elseExpr, 0)}`;
        return 0 < parentPrec ? `(${s})` : s;
      }
      if (e instanceof Call) {
        const args = e.args.map((a) => printExpr(a, 0)).join(', ');
        return `${e.callee.name}(${args})`;
      }
      throw new Error('printExpr: ' + e?.constructor?.name);
    };

    const lines = [];
    const printStmt = (st, ind) => {
      const pad = '  '.repeat(ind);
      if (st instanceof Block) {
        st.statements.forEach((s) => printStmt(s, ind));
      } else if (st instanceof Declare) {
        lines.push(`${pad}${st.variable.type} ${st.variable.name}${st.initializer ? ' = ' + printExpr(st.initializer) : ''};`);
      } else if (st instanceof Assign) {
        lines.push(`${pad}${st.variable.name} = ${printExpr(st.value)};`);
      } else if (st instanceof ExpressionStatement) {
        lines.push(`${pad}${printExpr(st.expr)};`);
      } else if (st instanceof If) {
        lines.push(`${pad}if (${printExpr(st.cond)}) {`);
        printStmt(st.thenBlock, ind + 1);
        if (st.elseBlock) {
          lines.push(`${pad}} else {`);
          printStmt(st.elseBlock, ind + 1);
        }
        lines.push(`${pad}}`);
      } else if (st instanceof While) {
        lines.push(`${pad}while (${printExpr(st.cond)}) {`);
        printStmt(st.body, ind + 1);
        lines.push(`${pad}}`);
      } else if (st instanceof Switch) {
        lines.push(`${pad}switch (${printExpr(st.value)}) {`);
        printStmt(st.body, ind + 1);
        lines.push(`${pad}}`);
      } else if (st instanceof Case) {
        const tag = st.value === null ? 'default' : `case ${st.value}`;
        lines.push(`${pad}${tag}:`);
      } else if (st instanceof Break) {
        lines.push(`${pad}break;`);
      } else if (st instanceof Return) {
        lines.push(`${pad}return ${printExpr(st.value)};`);
      } else if (st instanceof Label) {
        lines.push(`${pad}${st.name}:`);
      } else if (st instanceof Goto) {
        lines.push(`${pad}goto ${st.target};`);
      } else {
        throw new Error('printStmt: ' + st?.constructor?.name);
      }
    };

    const fnLines = program.functions.map((fn) => {
      lines.length = 0;
      const params = fn.parameters.map((p) => `${p.type} ${p.name}`).join(', ');
      lines.push(`${fn.returnType} ${fn.name}(${params}) {`);
      printStmt(fn.body, 1);
      lines.push('}');
      return lines.join('\n');
    });
    return fnLines.join('\n\n') + '\n';
  };

  return {
    Program, Function, Block,
    Literal, Variable,
    Declare, Assign, ExpressionStatement,
    Binary, Unary, Ternary, Call,
    Switch, Case, If, While, Break,
    Label, Goto, Return,
    TYPE, printSource,
  };
})();

const PARSER = (() => {

  function tokenize(source) {
    const KEYWORDS = new Set([
      'i32', 'i64', 'f32', 'f64',
      'while', 'break', 'switch', 'case', 'default',
      'if', 'else', 'goto', 'return',
    ]);
    const PUNCT2 = ['==', '!=', '<=', '>=', '&&', '||'];
    const PUNCT1 = '{}()[];,:?+-*/%!=<>';
    const s = source;
    const tokens = [];
    let i = 0, line = 1, col = 1;
    // Consumes [i..) while pattern matches; returns the consumed substring.
    const munch = (pattern) => {
      const start = i;
      while (i < s.length && pattern.test(s[i])) { i++; col++; }
      return s.slice(start, i);
    };
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') { i++; line++; col = 1; continue; }
      if (/\s/.test(c)) { i++; col++; continue; }
      if (c === '/' && s[i + 1] === '/') {
        while (i < s.length && s[i] !== '\n') { i++; col++; }
        continue;
      }
      const startLine = line, startCol = col;
      if (/[a-zA-Z_]/.test(c)) {
        const name = munch(/[a-zA-Z0-9_]/);
        const type = KEYWORDS.has(name) ? name : 'ID';
        tokens.push({ type, value: name, line: startLine, col: startCol });
        continue;
      }
      if (/[0-9]/.test(c)) {
        let text = munch(/[0-9]/);
        let type = 'NUM';
        if (s[i] === '.') {
          text += s[i]; i++; col++;
          text += munch(/[0-9]/);
          type = 'FLOAT';
        }
        const value = type === 'FLOAT' ? parseFloat(text) : BigInt(text);
        tokens.push({ type, value, line: startLine, col: startCol });
        continue;
      }
      const two = s.slice(i, i + 2);
      if (PUNCT2.includes(two)) {
        tokens.push({ type: two, value: two, line: startLine, col: startCol });
        i += 2; col += 2;
        continue;
      }
      if (PUNCT1.includes(c)) {
        tokens.push({ type: c, value: c, line: startLine, col: startCol });
        i++; col++;
        continue;
      }
      throw new Error(`Unexpected '${c}' at line ${line}:${col}`);
    }
    return tokens;
  }

  // Parses source (string) to AST.Program.
  function parse(source) {
    // === setup ===
    const tokens = tokenize(source);
    let i = 0;
    let scope = Object.create(null);     // name → AST.Variable; flat per-function
    // name → AST.Function. The same Function object is shared between
    // a forward declaration (created with null body) and its eventual
    // definition (which fills in the body). Calls reference the Function
    // directly, so the call site reaches type info through callee.
    const prototypes = new Map();

    // === parse helpers ===
    const peek = (k = 0) => tokens[i + k];
    const advance = () => tokens[i++];
    const loc = (t) => t ? { line: t.line, col: t.col } : { line: 0, col: 0 };
    function at(type, value = null) {
      const t = peek();
      return !!t && t.type === type && (value === null || t.value === value);
    }
    function eat(type, value = null) {
      if (at(type, value)) return advance();
      return null;
    }
    function expect(type, value = null) {
      const t = eat(type, value);
      if (!t) throw new Error(`Expected ${value ?? type} at line ${peek()?.line}:${peek()?.col}`);
      return t;
    }

    // === grammar ===
    function atType() { return at('i32') || at('i64') || at('f32') || at('f64'); }
    function parseType() {
      const t = eat('i32') || eat('i64') || eat('f32') || eat('f64');
      if (!t) throw new Error(`Expected type at line ${peek()?.line}:${peek()?.col}`);
      return t.value;
    }

    function parseBlock() {
      const open = expect('{');
      const stmts = [];
      while (!eat('}')) stmts.push(parseStatement());
      return new AST.Block(loc(open), stmts);
    }

    function parseStatement() {
      // Label: ID :   (marker only — no body, no trailing `;`)
      if (peek()?.type === 'ID' && peek(1)?.type === ':') {
        const nameTok = advance(); advance();
        return new AST.Label(loc(nameTok), nameTok.value);
      }
      // Case marker: `case NUM :` or `default :` (inline markers, only
      // meaningful inside a Switch body; the CFG lowering treats them like
      // labels and the enclosing Switch wires them into its dispatch table).
      if (at('case')) {
        const ct = advance();
        const numTok = expect('NUM');
        expect(':');
        return new AST.Case(loc(ct), Number(numTok.value));
      }
      if (at('default')) {
        const dt = advance();
        expect(':');
        return new AST.Case(loc(dt), null);
      }
      // Declare: <type> ID [= expr] ;
      if (atType()) {
        const start = peek();
        const type = parseType();
        const id = expect('ID');
        if (scope[id.value]) throw new Error(`Duplicate var ${id.value} at line ${id.line}:${id.col}`);
        const variable = new AST.Variable(loc(id), type, id.value);
        scope[id.value] = variable;
        const init = eat('=') ? parseExpression() : null;
        expect(';');
        return new AST.Declare(loc(start), variable, init);
      }
      if (at('if')) return parseIf();
      if (at('while')) return parseWhile();
      if (at('switch')) return parseSwitch();
      if (at('{')) return parseBlock();
      if (at('break')) {
        const t = advance(); expect(';');
        return new AST.Break(loc(t));
      }
      if (at('return')) {
        const t = advance();
        const e = parseExpression();
        expect(';');
        return new AST.Return(loc(t), e);
      }
      if (at('goto')) {
        const t = advance();
        const tgt = expect('ID');
        expect(';');
        return new AST.Goto(loc(t), tgt.value);
      }
      // Assign: ID = expr ;
      if (peek()?.type === 'ID' && peek(1)?.type === '=') {
        const id = advance(); advance();
        const value = parseExpression();
        expect(';');
        const v = scope[id.value];
        if (!v) throw new Error(`Undefined variable ${id.value} at line ${id.line}:${id.col}`);
        return new AST.Assign(loc(id), v, value);
      }
      // Call statement: ID ( ... ) ;
      // (parsePrimary handles the call form; the wrapper marks it as a
      // statement whose result is discarded.)
      if (peek()?.type === 'ID' && peek(1)?.type === '(') {
        const start = peek();
        const expr = parseExpression();    // delegates to parsePrimary
        expect(';');
        return new AST.ExpressionStatement(loc(start), expr);
      }
      const bad = peek();
      throw new Error(`Unexpected token ${bad?.type} at line ${bad?.line}:${bad?.col}`);
    }

    function parseIf() {
      const t = expect('if');
      expect('(');
      const cond = parseExpression();
      expect(')');
      const thenBlock = parseBlock();
      // `else if` parses as a nested If wrapped in a 1-statement Block so
      // AST.If's elseBlock invariant (Block | null) holds.
      let elseBlock = null;
      if (eat('else')) {
        if (at('if')) {
          const nested = parseIf();
          elseBlock = new AST.Block(nested.loc, [nested]);
        } else {
          elseBlock = parseBlock();
        }
      }
      return new AST.If(loc(t), cond, thenBlock, elseBlock);
    }

    function parseWhile() {
      const t = expect('while');
      expect('(');
      const cond = parseExpression();
      expect(')');
      const body = parseBlock();
      return new AST.While(loc(t), cond, body);
    }

    function parseSwitch() {
      const t = expect('switch');
      expect('(');
      const value = parseExpression();
      expect(')');
      // Body is a regular Block; case/default markers parse as statements
      // (handled in parseStatement). Fallthrough between cases is natural —
      // explicit `break;` exits the switch.
      const body = parseBlock();
      return new AST.Switch(loc(t), value, body);
    }

    // Precedence (lowest to highest):
    //   parseExpression = parseTernary     ?: (right-assoc)
    //   parseLogicalOr                     ||
    //   parseLogicalAnd                    &&
    //   parseComparison                    == != < <= > >=
    //   parseAdd                           + -
    //   parseMul                           * / %
    //   parseUnary                         unary + - !
    //   parsePrimary                       literals, vars, parens
    function parseExpression() {
      return parseTernary();
    }
    function parseTernary() {
      const cond = parseLogicalOr();
      if (eat('?')) {
        const thenExpr = parseExpression();
        expect(':');
        const elseExpr = parseExpression();    // right-assoc via recursion
        return new AST.Ternary(cond.loc, cond, thenExpr, elseExpr);
      }
      return cond;
    }
    function parseLogicalOr() {
      let left = parseLogicalAnd();
      while (at('||')) {
        advance();
        const right = parseLogicalAnd();
        left = new AST.Binary(left.loc, '||', left, right);
      }
      return left;
    }
    function parseLogicalAnd() {
      let left = parseComparison();
      while (at('&&')) {
        advance();
        const right = parseComparison();
        left = new AST.Binary(left.loc, '&&', left, right);
      }
      return left;
    }
    function parseComparison() {
      let left = parseAdd();
      while (at('==') || at('!=') || at('<') || at('<=') || at('>') || at('>=')) {
        const op = advance().value;
        const right = parseAdd();
        left = new AST.Binary(left.loc, op, left, right);
      }
      return left;
    }
    function parseAdd() {
      let left = parseMul();
      while (at('+') || at('-')) {
        const op = advance().value;
        const right = parseMul();
        left = new AST.Binary(left.loc, op, left, right);
      }
      return left;
    }
    function parseMul() {
      let left = parseUnary();
      while (at('*') || at('/') || at('%')) {
        const op = advance().value;
        const right = parseUnary();
        left = new AST.Binary(left.loc, op, left, right);
      }
      return left;
    }
    function parseUnary() {
      if (at('+') || at('-') || at('!')) {
        const t = advance();
        const expr = parseUnary();
        return new AST.Unary(loc(t), t.value, expr);
      }
      return parsePrimary();
    }
    function parsePrimary() {
      const t = peek();
      if (eat('NUM')) return new AST.Literal(loc(t), 'i32', t.value);
      if (eat('FLOAT')) return new AST.Literal(loc(t), 'f64', t.value);
      // ID followed by '(' is a function call; bare ID is a variable.
      if (t?.type === 'ID' && peek(1)?.type === '(') {
        return parseCall();
      }
      if (eat('ID')) {
        if (scope[t.value]) return scope[t.value];
        throw new Error(`Undefined variable ${t.value} at line ${t.line}:${t.col}`);
      }
      if (eat('(')) {
        const e = parseExpression();
        expect(')');
        return e;
      }
      throw new Error(`Unexpected token ${t?.type} at line ${t?.line}:${t?.col}`);
    }

    function parseCall() {
      const idTok = advance();
      expect('(');
      const args = [];
      if (!at(')')) {
        do { args.push(parseExpression()); } while (eat(','));
      }
      expect(')');
      const fn = prototypes.get(idTok.value);
      if (!fn) {
        throw new Error(`Call to undeclared function '${idTok.value}' at line ${idTok.line}:${idTok.col}`);
      }
      if (args.length !== fn.parameters.length) {
        throw new Error(
          `'${idTok.value}': expected ${fn.parameters.length} arg(s), got ${args.length} at line ${idTok.line}:${idTok.col}`);
      }
      for (let k = 0; k < args.length; k++) {
        const got = AST.TYPE.of(args[k]);
        const want = fn.parameters[k].type;
        if (got !== want) {
          throw new Error(
            `'${idTok.value}' arg ${k}: expected ${want}, got ${got} at line ${idTok.line}:${idTok.col}`);
        }
      }
      return new AST.Call(loc(idTok), fn, args);
    }

    // Verify the signature implied by `slots`/`retType` matches the
    // already-registered prototype `fn`.
    function checkProtoMatches(fn, retType, slots, locTok) {
      const mismatch =
        fn.returnType !== retType
        || fn.parameters.length !== slots.length
        || fn.parameters.some((p, k) => p.type !== slots[k].type);
      if (mismatch) {
        throw new Error(`Conflicting declarations of '${fn.name}' at line ${locTok.line}:${locTok.col}`);
      }
    }

    // Parses one of:
    //   <type> ID ( <type> [ID], ... ) ;     ← forward declaration
    //   <type> ID ( <type> ID, ... ) <block> ← function definition
    // For a forward declaration, registers an AST.Function with body=null
    // in `prototypes` and returns null. For a definition, either creates a
    // new AST.Function or reuses the prototype object (filling in body and
    // replacing the placeholder parameters with the named ones); returns
    // the AST.Function.
    function parseFunctionOrPrototype() {
      const start = peek();
      const retType = parseType();
      const nameTok = expect('ID');
      expect('(');
      // Parameter slots: each has a type and (optionally, for forward decls) a name.
      const paramSlots = [];
      if (!at(')')) {
        do {
          const pType = parseType();
          const pName = eat('ID');           // optional in forward decls
          paramSlots.push({ type: pType, nameTok: pName });
        } while (eat(','));
      }
      expect(')');

      // Look up or create the AST.Function object for this name.
      let fn = prototypes.get(nameTok.value);
      if (fn) {
        checkProtoMatches(fn, retType, paramSlots, nameTok);
      } else {
        // Placeholder parameters — names may be empty here (forward decls
        // can omit them); a later definition will overwrite this list.
        const placeholder = paramSlots.map((p) => new AST.Variable(
          p.nameTok ? loc(p.nameTok) : loc(nameTok),
          p.type,
          p.nameTok ? p.nameTok.value : ''));
        fn = new AST.Function(loc(start), retType, nameTok.value, placeholder, null);
        prototypes.set(nameTok.value, fn);
      }

      if (eat(';')) return null;             // forward declaration only

      // Definition — require named parameters and parse a body. Replace
      // any placeholder parameters from a prior forward decl with the
      // real, named ones.
      if (fn.body !== null) {
        throw new Error(`Duplicate definition of '${nameTok.value}' at line ${nameTok.line}:${nameTok.col}`);
      }
      const params = paramSlots.map((p) => {
        if (!p.nameTok) {
          throw new Error(`Function definition of '${nameTok.value}' requires parameter names at line ${nameTok.line}:${nameTok.col}`);
        }
        return new AST.Variable(loc(p.nameTok), p.type, p.nameTok.value);
      });
      fn.parameters = params;
      scope = Object.create(null);
      for (const p of params) scope[p.name] = p;
      fn.body = parseBlock();
      return fn;
    }

    const functions = [];
    while (i < tokens.length) {
      const fn = parseFunctionOrPrototype();
      if (fn) functions.push(fn);
    }
    // Every forward-declared function must have a matching definition.
    for (const fn of prototypes.values()) {
      if (fn.body === null) {
        throw new Error(`'${fn.name}': forward declaration without a definition`);
      }
    }
    return new AST.Program(loc(tokens[0]), functions);
  }

  return { parse, tokenize };
})();

const CFG = (() => {

  // ────── Three-Address Code (TAC) CFG ──────
  //
  // Every operation is a one-line instruction that names its destination
  // and operands by reference to AST.Variables ("virtual registers"). VRegs
  // are mutable — any instruction may reassign any VReg. The CFG.Function's
  // `locals` list holds both source-declared variables and synthetic temps
  // produced by lowering (e.g. __t0, __t1, ...).
  //
  // Branches reference VRegs by identity rather than carrying expression
  // trees: BrIf.cond is a VReg holding an i32, Return.value is a VReg
  // holding the function's return type.

  // ────── Instructions ──────

  class Instruction {
    constructor(loc, dest) {
      this.loc = loc;
      this.dest = dest;                  // AST.Variable (the target VReg)
    }
  }

  // dest = <literal of dest.type>
  class Const extends Instruction {
    constructor(loc, dest, value) {
      super(loc, dest);
      this.value = value;                // number | BigInt
    }
  }

  // dest = lhs <op> rhs       (op: '+' '-' '*' '/' '%' '==' '!=' '<' '<=' '>' '>=')
  // Note: '&&' and '||' never appear here — they're lowered to control flow
  // during AST → CFG.
  class BinaryOp extends Instruction {
    constructor(loc, dest, op, lhs, rhs) {
      super(loc, dest);
      this.op = op;
      this.lhs = lhs;                    // AST.Variable
      this.rhs = rhs;                    // AST.Variable
    }
  }

  // dest = <op> operand       (op: '-' (float negate) or '!' (eqz))
  // Integer '-' is lowered to '0 - x' BinaryOp.
  class UnaryOp extends Instruction {
    constructor(loc, dest, op, operand) {
      super(loc, dest);
      this.op = op;
      this.operand = operand;            // AST.Variable
    }
  }

  // dest = src                (plain copy / move between VRegs)
  class Copy extends Instruction {
    constructor(loc, dest, src) {
      super(loc, dest);
      this.src = src;                    // AST.Variable
    }
  }

  // dest = call <callee>(args...)
  // dest is always present (this language has no void functions), even
  // when the source-level call was an ExpressionStatement and the result
  // is unused — the temp just stays dead. `callee` is a direct CFG.Function
  // reference; the cross-layer linkage (AST.Function ↔ CFG.Function) lives
  // inside the lower / lift passes.
  class Call extends Instruction {
    constructor(loc, dest, callee, args) {
      super(loc, dest);
      this.callee = callee;              // CFG.Function
      this.args = args;                  // AST.Variable[]
    }
  }

  // ────── Terminators ──────
  //
  // No expression trees here: cond / value reference VRegs (AST.Variables)
  // that were written by instructions in the same or a predecessor block.

  class Terminator {
    constructor(loc) { this.loc = loc; }
    get successors() { return []; }
  }

  class Br extends Terminator {
    constructor(loc, target) {
      if (!(target instanceof BasicBlock)) throw new Error('Br: target must be a BasicBlock');
      super(loc);
      this.target = target;
    }
    get successors() { return [this.target]; }
  }

  class BrIf extends Terminator {
    constructor(loc, cond, trueTarget, falseTarget) {
      if (!(trueTarget instanceof BasicBlock) || !(falseTarget instanceof BasicBlock)) {
        throw new Error('BrIf: targets must be BasicBlocks');
      }
      super(loc);
      this.cond = cond;                  // AST.Variable (i32)
      this.trueTarget = trueTarget;
      this.falseTarget = falseTarget;
    }
    get successors() { return [this.trueTarget, this.falseTarget]; }
  }

  class Return extends Terminator {
    constructor(loc, value) {
      super(loc);
      this.value = value;                // AST.Variable
    }
  }

  class Unreachable extends Terminator {
    constructor(loc) { super(loc); }
  }

  // ────── BasicBlock / Function / Module ──────

  class BasicBlock {
    constructor(name) {
      this.name = name;
      this.id = -1;
      this.instructions = [];            // Instruction[]
      this.terminator = null;
    }
    append(ins) {
      if (this.terminator) throw new Error(`Block '${this.name}' already terminated`);
      this.instructions.push(ins);
      return ins;
    }
    terminate(t) {
      if (this.terminator) throw new Error(`Block '${this.name}' already terminated`);
      this.terminator = t;
    }
  }

  class Function {
    constructor(name, params, returnType, exportName = null) {
      this.name = name;
      this.params = params;              // AST.Variable[] — function parameters
      this.returnType = returnType;
      this.exportName = exportName;
      // `locals` holds both source-declared variables AND synthetic temps
      // produced during lowering, in stable order. wasm encoding only cares
      // about the order, not the source / temp distinction.
      this.locals = [];                  // AST.Variable[]
      this.entry = new BasicBlock('entry');
      this.entry.id = 0;
      this.blocks = [this.entry];
      this._names = new Set(params.map((p) => p.name));
      this._tempCounter = 0;
    }
    hasName(name) { return this._names.has(name); }
    addLocal(v) {
      if (this._names.has(v.name)) throw new Error('duplicate local: ' + v.name);
      this._names.add(v.name);
      this.locals.push(v);
      return v;
    }
    newTemp(type, loc = null) {
      // Skip names that round-trip lifting may already have introduced
      // (e.g. an earlier lift's `__t0` is now a regular local on relower).
      let name;
      do { name = `__t${this._tempCounter++}`; } while (this._names.has(name));
      const v = new AST.Variable(loc, type, name);
      this._names.add(name);
      this.locals.push(v);
      return v;
    }
    createBlock(name) {
      const b = new BasicBlock(name);
      b.id = this.blocks.length;
      this.blocks.push(b);
      return b;
    }
  }

  class Module {
    constructor(functions) { this.functions = functions; }
  }

  function fromAST(program) {
    // Lower AST.Program => CFG.Module (TAC).
    //
    // Expressions get flattened to three-address ops with a fresh temp per
    // intermediate. emitExpr returns the AST.Variable holding the result.
    // Short-circuit ops (&&, ||) and ternary (?:) introduce control flow
    // by opening fresh blocks and threading the result through a shared
    // destination var.
    //
    // Two-pass: (1) mint a CFG.Function for every AST.Function so any call,
    // including one to a not-yet-walked function, can resolve its callee.
    // (2) walk each body, emitting instructions into the pre-created CFG.
    // Cross-layer linkage (AST.Function → CFG.Function) lives in cfgByAst
    // for the duration of this call.

    // Pass 1: pre-create CFG.Functions.
    const cfgByAst = new Map();
    for (const astFn of program.functions) {
      cfgByAst.set(astFn,
        new CFG.Function(astFn.name, astFn.parameters, astFn.returnType, astFn.name));
    }

    const lowerFunction = (astFn) => {
      const cfgFn = cfgByAst.get(astFn);

      // Pre-scan: register declared locals (source order) via cfgFn.addLocal
      // (which checks duplicates), and pre-create BasicBlocks for labels
      // and case markers.
      const labelBlocks = new Map();
      const caseBlocks = new Map();         // AST.Case node → BasicBlock
      const scan = (n) => {
        if (!n) return;
        if (n instanceof AST.Declare) {
          cfgFn.addLocal(n.variable);
        } else if (n instanceof AST.Label) {
          if (labelBlocks.has(n.name)) throw new Error('duplicate label: ' + n.name);
          labelBlocks.set(n.name, cfgFn.createBlock('lbl_' + n.name));
        } else if (n instanceof AST.Case) {
          const tag = n.value === null ? 'default' : `case_${n.value}`;
          caseBlocks.set(n, cfgFn.createBlock(tag));
        } else if (n instanceof AST.Switch) {
          scan(n.body);
        } else if (n instanceof AST.Block) {
          n.statements.forEach(scan);
        } else if (n instanceof AST.If) {
          scan(n.thenBlock); scan(n.elseBlock);
        } else if (n instanceof AST.While) {
          scan(n.body);
        }
      };
      scan(astFn.body);

      // Lazy switch scratch.
      let swScratch = null;
      const ensureSwitchScratch = () => {
        if (swScratch) return swScratch;
        let nm = '__sw_scratch';
        for (let k = 1; cfgFn.hasName(nm); k++) nm = `__sw_scratch_${k}`;
        swScratch = new AST.Variable(null, 'i32', nm);
        cfgFn.addLocal(swScratch);
        return swScratch;
      };

      let current = cfgFn.entry;
      const breakStack = [];                 // exit BasicBlock of innermost loop/switch
      const append = (s) => { if (current) current.append(s); };
      const terminate = (t) => { if (current) { current.terminate(t); current = null; } };

      // Emit AST expression `e`, returning the AST.Variable that holds its
      // value. Side effect: appends instructions (and may open new blocks
      // for short-circuit / ternary).
      const emitExpr = (e) => {
        if (e instanceof AST.Literal) {
          const t = cfgFn.newTemp(e.type, e.loc);
          append(new CFG.Const(e.loc, t, e.value));
          return t;
        }
        if (e instanceof AST.Variable) {
          return e;                          // source variables ARE VRegs
        }
        if (e instanceof AST.Binary && (e.op === '&&' || e.op === '||')) {
          return emitShortCircuit(e);
        }
        if (e instanceof AST.Binary) {
          const lhs = emitExpr(e.left);
          const rhs = emitExpr(e.right);
          const t = cfgFn.newTemp(AST.TYPE.of(e), e.loc);
          append(new CFG.BinaryOp(e.loc, t, e.op, lhs, rhs));
          return t;
        }
        if (e instanceof AST.Unary) {
          const opTy = AST.TYPE.of(e.operand);
          if (e.op === '-' && (opTy === 'i32' || opTy === 'i64')) {
            // 0 - x for integer negation (wasm has no integer neg).
            const zero = cfgFn.newTemp(opTy, e.loc);
            append(new CFG.Const(e.loc, zero, opTy === 'i64' ? 0n : 0));
            const x = emitExpr(e.operand);
            const t = cfgFn.newTemp(opTy, e.loc);
            append(new CFG.BinaryOp(e.loc, t, '-', zero, x));
            return t;
          }
          const operand = emitExpr(e.operand);
          const t = cfgFn.newTemp(AST.TYPE.of(e), e.loc);
          append(new CFG.UnaryOp(e.loc, t, e.op, operand));
          return t;
        }
        if (e instanceof AST.Ternary) {
          return emitTernary(e);
        }
        if (e instanceof AST.Call) {
          // Evaluate each arg into a VReg (in source order), then emit the
          // Call instruction. AST.Call.callee is an AST.Function; we route
          // it through cfgByAst to get the matching CFG.Function.
          const argVRegs = e.args.map((a) => emitExpr(a));
          const dest = cfgFn.newTemp(e.callee.returnType, e.loc);
          const calleeCfg = cfgByAst.get(e.callee);
          if (!calleeCfg) throw new Error(`fromAST: no CFG.Function for '${e.callee.name}'`);
          append(new CFG.Call(e.loc, dest, calleeCfg, argVRegs));
          return dest;
        }
        throw new Error('emitExpr: ' + e.constructor.name);
      };

      // a && b   →   dest = 0; if (a) { if (b) dest = 1; }
      // a || b   →   dest = 1; if (a) {} else { if (b) {} else dest = 0; }
      // Both produce a normalized i32 (0 or 1).
      const emitShortCircuit = (e) => {
        const dest = cfgFn.newTemp('i32', e.loc);
        const seedB = cfgFn.createBlock(e.op === '&&' ? 'and_seed' : 'or_seed');
        const checkRhsB = cfgFn.createBlock(e.op === '&&' ? 'and_rhs' : 'or_rhs');
        const flipB = cfgFn.createBlock(e.op === '&&' ? 'and_set1' : 'or_set0');
        const exitB = cfgFn.createBlock(e.op === '&&' ? 'and_exit' : 'or_exit');
        // Initialize dest with the "skip" value.
        terminate(new CFG.Br(e.loc, seedB));
        current = seedB;
        const seedT = cfgFn.newTemp('i32', e.loc);
        append(new CFG.Const(e.loc, seedT, e.op === '&&' ? 0 : 1));
        append(new CFG.Copy(e.loc, dest, seedT));
        // Test lhs.
        const lhs = emitExpr(e.left);
        if (e.op === '&&') {
          terminate(new CFG.BrIf(e.loc, lhs, checkRhsB, exitB));
        } else {
          terminate(new CFG.BrIf(e.loc, lhs, exitB, checkRhsB));
        }
        // Test rhs.
        current = checkRhsB;
        const rhs = emitExpr(e.right);
        if (e.op === '&&') {
          terminate(new CFG.BrIf(e.loc, rhs, flipB, exitB));
        } else {
          terminate(new CFG.BrIf(e.loc, rhs, exitB, flipB));
        }
        // Both operands agreed → flip dest to the "other" value.
        current = flipB;
        const flipT = cfgFn.newTemp('i32', e.loc);
        append(new CFG.Const(e.loc, flipT, e.op === '&&' ? 1 : 0));
        append(new CFG.Copy(e.loc, dest, flipT));
        terminate(new CFG.Br(e.loc, exitB));
        current = exitB;
        return dest;
      };

      // c ? t : e   →   if (c) dest = t; else dest = e;
      const emitTernary = (e) => {
        const ty = AST.TYPE.of(e.thenExpr);
        const dest = cfgFn.newTemp(ty, e.loc);
        const thenB = cfgFn.createBlock('tern_then');
        const elseB = cfgFn.createBlock('tern_else');
        const exitB = cfgFn.createBlock('tern_exit');
        const cond = emitExpr(e.cond);
        terminate(new CFG.BrIf(e.loc, cond, thenB, elseB));
        current = thenB;
        const thenV = emitExpr(e.thenExpr);
        append(new CFG.Copy(e.loc, dest, thenV));
        terminate(new CFG.Br(e.loc, exitB));
        current = elseB;
        const elseV = emitExpr(e.elseExpr);
        append(new CFG.Copy(e.loc, dest, elseV));
        terminate(new CFG.Br(e.loc, exitB));
        current = exitB;
        return dest;
      };

      // Emit an AST.Assign as TAC: evaluate RHS to a VReg, then Copy into LHS
      // (unless the RHS already wrote to the LHS during emission).
      const emitAssign = (target, expr, loc) => {
        const src = emitExpr(expr);
        if (src !== target) append(new CFG.Copy(loc, target, src));
      };

      const emitStmt = (st) => {
        // Labels, Case markers, and Blocks are handled even when `current`
        // is null: labels/cases are reachable jump targets that can
        // resurrect a dead position, and Blocks must recurse to surface
        // any such markers nested inside an otherwise-dead arm.
        if (st instanceof AST.Label) {
          const target = labelBlocks.get(st.name);
          if (current) terminate(new CFG.Br(st.loc, target));
          current = target;
          return;
        }
        if (st instanceof AST.Case) {
          const target = caseBlocks.get(st);
          if (current) terminate(new CFG.Br(st.loc, target));
          current = target;
          return;
        }
        if (st instanceof AST.Block) {
          st.statements.forEach(emitStmt);
          return;
        }
        if (!current) return;
        if (st instanceof AST.Declare) {
          if (st.initializer) emitAssign(st.variable, st.initializer, st.loc);
        } else if (st instanceof AST.Assign) {
          emitAssign(st.variable, st.value, st.loc);
        } else if (st instanceof AST.ExpressionStatement) {
          // The Call instruction is still emitted; its dest VReg just stays
          // unused. That's intentional — calls are impure, so we never DCE
          // them, but we also can't propagate the value anywhere.
          emitExpr(st.expr);
        } else if (st instanceof AST.If) {
          const cond = emitExpr(st.cond);
          const thenB = cfgFn.createBlock('then');
          const elseB = st.elseBlock ? cfgFn.createBlock('else') : null;
          const joinB = cfgFn.createBlock('endif');
          terminate(new CFG.BrIf(st.loc, cond, thenB, elseB ?? joinB));
          current = thenB;
          emitStmt(st.thenBlock);
          if (current) terminate(new CFG.Br(st.loc, joinB));
          if (elseB) {
            current = elseB;
            emitStmt(st.elseBlock);
            if (current) terminate(new CFG.Br(st.loc, joinB));
          }
          current = joinB;
        } else if (st instanceof AST.While) {
          const headerB = cfgFn.createBlock('while_head');
          const bodyB = cfgFn.createBlock('while_body');
          const exitB = cfgFn.createBlock('while_exit');
          terminate(new CFG.Br(st.loc, headerB));
          current = headerB;
          const cond = emitExpr(st.cond);
          terminate(new CFG.BrIf(st.loc, cond, bodyB, exitB));
          current = bodyB;
          breakStack.push(exitB);
          emitStmt(st.body);
          breakStack.pop();
          if (current) terminate(new CFG.Br(st.loc, headerB));
          current = exitB;
        } else if (st instanceof AST.Switch) {
          // Stash the value into a scratch local (avoids re-evaluation, and
          // stays correct if the value has side effects), then a BrIf chain
          // compares the scratch against each non-default case marker's
          // literal and falls through to a Br targeting the default marker
          // (or the exit, if no default).
          //
          // Case markers themselves are handled by AST.Case above — they
          // act like labels. The dispatch only references them; body
          // emission walks the body as a normal Block, so fallthrough
          // between adjacent cases is free.
          const cases = [];                // {value, block}
          let defaultBlock = null;
          const collect = (n) => {
            if (!n) return;
            if (n instanceof AST.Case) {
              const blk = caseBlocks.get(n);
              if (n.value === null) {
                if (defaultBlock) throw new Error('Duplicate default in switch');
                defaultBlock = blk;
              } else {
                cases.push({ value: n.value, block: blk });
              }
            } else if (n instanceof AST.Block) {
              n.statements.forEach(collect);
            } else if (n instanceof AST.If) {
              collect(n.thenBlock); collect(n.elseBlock);
            } else if (n instanceof AST.While) {
              collect(n.body);
            }
            // Don't descend into nested AST.Switch — those case markers
            // belong to the inner switch's dispatch table.
          };
          collect(st.body);

          const exitB = cfgFn.createBlock('sw_exit');
          const scratch = ensureSwitchScratch();
          emitAssign(scratch, st.value, st.loc);
          for (let i = 0; i < cases.length; i++) {
            const caseLit = cfgFn.newTemp('i32', st.loc);
            append(new CFG.Const(st.loc, caseLit, cases[i].value));
            const cond = cfgFn.newTemp('i32', st.loc);
            append(new CFG.BinaryOp(st.loc, cond, '==', scratch, caseLit));
            const fallthrough = (i < cases.length - 1)
              ? cfgFn.createBlock(`sw_disp_${i + 1}`)
              : (defaultBlock ?? exitB);
            terminate(new CFG.BrIf(st.loc, cond, cases[i].block, fallthrough));
            current = fallthrough;
          }
          if (cases.length === 0) {
            terminate(new CFG.Br(st.loc, defaultBlock ?? exitB));
          }
          // Body is emitted with `current = null` (statements before the
          // first Case marker are unreachable, per C semantics). Case
          // markers reactivate `current` via AST.Case's handler above.
          current = null;
          breakStack.push(exitB);
          emitStmt(st.body);
          breakStack.pop();
          if (current) terminate(new CFG.Br(st.loc, exitB));
          current = exitB;
        } else if (st instanceof AST.Break) {
          if (!breakStack.length) throw new Error('Break outside loop/switch');
          terminate(new CFG.Br(st.loc, breakStack[breakStack.length - 1]));
        } else if (st instanceof AST.Return) {
          const v = emitExpr(st.value);
          terminate(new CFG.Return(st.loc, v));
        } else if (st instanceof AST.Goto) {
          const target = labelBlocks.get(st.target);
          if (!target) throw new Error('undefined label: ' + st.target);
          terminate(new CFG.Br(st.loc, target));
        } else throw new Error('emitStmt: ' + st.constructor.name);
      };

      emitStmt(astFn.body);
      if (current) terminate(new CFG.Unreachable(null));
      for (const b of cfgFn.blocks) if (!b.terminator) b.terminate(new CFG.Unreachable(null));
      return cfgFn;
    };

    // Pass 2: walk each body. CFG.Functions were created in pass 1.
    for (const fn of program.functions) lowerFunction(fn);
    return new CFG.Module([...cfgByAst.values()]);
  }

  function intoAST(module) {
    // Lift CFG.Module => AST.Program (while-switch dispatcher form).
    //
    // Each TAC instruction becomes an AST.Assign whose RHS reconstructs the
    // instruction's operation as an expression tree (just one node deep).
    // Block terminators become state-update + break (for Br/BrIf), return
    // (for Return), or a default return (for Unreachable).
    //
    // Two-pass: (1) mint a fresh AST.Function (with null body) for every
    // CFG.Function so cross-function references exist; (2) fill in each body.
    // CFG.Call.callee (a CFG.Function) is resolved against astByCfg so the
    // lifted AST.Call.callee points at the matching new AST.Function.
    const zero = (t) => new AST.Literal(null, t, t === 'i64' ? 0n : 0);

    // Pass 1: pre-create AST.Functions keyed by their source CFG.Function.
    const astByCfg = new Map();
    for (const cfgFn of module.functions) {
      astByCfg.set(cfgFn,
        new AST.Function(null, cfgFn.returnType, cfgFn.name, cfgFn.params, null));
    }

    // Turn a TAC instruction into an AST.Assign(dest, <one-node expr>).
    const liftInstruction = (ins) => {
      let rhs;
      if (ins instanceof CFG.Const) {
        rhs = new AST.Literal(ins.loc, ins.dest.type, ins.value);
      } else if (ins instanceof CFG.BinaryOp) {
        rhs = new AST.Binary(ins.loc, ins.op, ins.lhs, ins.rhs);
      } else if (ins instanceof CFG.UnaryOp) {
        rhs = new AST.Unary(ins.loc, ins.op, ins.operand);
      } else if (ins instanceof CFG.Copy) {
        rhs = ins.src;                             // bare variable reference
      } else if (ins instanceof CFG.Call) {
        // ins.callee is a CFG.Function; route through astByCfg to get the
        // freshly minted AST.Function in the output program.
        const calleeFn = astByCfg.get(ins.callee);
        if (!calleeFn) throw new Error(`liftInstruction: unknown callee '${ins.callee.name}'`);
        rhs = new AST.Call(ins.loc, calleeFn, ins.args);
      } else throw new Error('liftInstruction: ' + ins.constructor.name);
      return new AST.Assign(ins.loc, ins.dest, rhs);
    };

    const buildBody = (cfgFn) => {
      // Pick a __state name that doesn't collide with any existing param
      // or local — keeps repeated lift/lower round-trips stable.
      const taken = new Set();
      for (const p of cfgFn.params) taken.add(p.name);
      for (const l of cfgFn.locals) taken.add(l.name);
      let stateName = '__state';
      for (let k = 1; taken.has(stateName); k++) stateName = `__state_${k}`;
      const stateVar = new AST.Variable(null, 'i32', stateName);
      const setState = (loc, id) =>
        new AST.Assign(loc, stateVar, new AST.Literal(null, 'i32', id));

      const liftBlock = (block) => {
        const stmts = block.instructions.map(liftInstruction);
        const term = block.terminator;
        if (term instanceof CFG.Br) {
          stmts.push(setState(term.loc, term.target.id));
          stmts.push(new AST.Break(term.loc));
        } else if (term instanceof CFG.BrIf) {
          stmts.push(new AST.If(term.loc, term.cond,
            new AST.Block(null, [setState(term.loc, term.trueTarget.id)]),
            new AST.Block(null, [setState(term.loc, term.falseTarget.id)]),
          ));
          stmts.push(new AST.Break(term.loc));
        } else if (term instanceof CFG.Return) {
          stmts.push(new AST.Return(term.loc, term.value));
        } else if (term instanceof CFG.Unreachable) {
          stmts.push(new AST.Return(null, zero(cfgFn.returnType)));
        } else throw new Error('liftBlock: terminator ' + term?.constructor?.name);
        return new AST.Block(null, stmts);
      };

      // Build a flat switch body: [Case(0), ...block0Stmts, Case(1), ...block1Stmts, ...].
      // Each block's terminator ends in `break;` (set by liftBlock), so
      // there's no fallthrough between cases — preserves dispatcher semantics.
      const switchBody = [];
      for (const b of cfgFn.blocks) {
        switchBody.push(new AST.Case(null, b.id));
        switchBody.push(...liftBlock(b).statements);
      }
      const decls = cfgFn.locals.map((v) => new AST.Declare(null, v, null));
      const stateDecl = new AST.Declare(null, stateVar,
        new AST.Literal(null, 'i32', cfgFn.entry.id));
      const dispatcher = new AST.While(null,
        new AST.Literal(null, 'i32', 1),
        new AST.Block(null, [new AST.Switch(null, stateVar,
          new AST.Block(null, switchBody))]));
      return new AST.Block(null, [...decls, stateDecl, dispatcher]);
    };

    // Pass 2: fill in each function's body.
    for (const cfgFn of module.functions) {
      astByCfg.get(cfgFn).body = buildBody(cfgFn);
    }

    return new AST.Program(null, [...astByCfg.values()]);
  }

  return {
    Instruction, Const, BinaryOp, UnaryOp, Copy, Call,
    Terminator, Br, BrIf, Return, Unreachable,
    BasicBlock, Function, Module,
    fromAST, intoAST,
  };
})();

const CODEGEN = (() => {

  function emit(program) {
    // ─── byte encoders ───────────────────────────────────────────
    const u = (v) => {                          // unsigned LEB128 (accepts Number or BigInt)
      v = BigInt(v);
      const out = [];
      do {
        let b = Number(v & 0x7Fn);
        v >>= 7n;
        if (v !== 0n) b |= 0x80;
        out.push(b);
      } while (v !== 0n);
      return out;
    };
    const s = (v) => {                          // signed LEB128
      v = BigInt(v);
      const out = [];
      for (; ;) {
        let b = Number(v & 0x7Fn);
        v >>= 7n;
        const done = (v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0);
        if (!done) b |= 0x80;
        out.push(b);
        if (done) return out;
      }
    };
    const f32 = (v) => { const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, v, true); return [...new Uint8Array(b)]; };
    const f64 = (v) => { const b = new ArrayBuffer(8); new DataView(b).setFloat64(0, v, true); return [...new Uint8Array(b)]; };
    const str = (x) => { const utf8 = [...new TextEncoder().encode(x)]; return [...u(utf8.length), ...utf8]; };
    const vec = (items) => { const out = [...u(items.length)]; for (const it of items) out.push(...it); return out; };
    const sect = (id, content) => [id, ...u(content.length), ...content];

    // ─── value-type byte ─────────────────────────────────────────
    const VT = { i32: 0x7F, i64: 0x7E, f32: 0x7D, f64: 0x7C };
    const vt = (t) => { if (!(t in VT)) throw new Error('bad type: ' + t); return VT[t]; };

    // ─── opcode tables ───────────────────────────────────────────
    // Binary op opcodes keyed by (AST op, operand type). Integer division and
    // remainder are signed; float comparisons have no signed/unsigned split.
    const BIN = {
      '+': { i32: 0x6A, i64: 0x7C, f32: 0x92, f64: 0xA0 },
      '-': { i32: 0x6B, i64: 0x7D, f32: 0x93, f64: 0xA1 },
      '*': { i32: 0x6C, i64: 0x7E, f32: 0x94, f64: 0xA2 },
      '/': { i32: 0x6D, i64: 0x7F, f32: 0x95, f64: 0xA3 },
      '%': { i32: 0x6F, i64: 0x81 },           // wasm has no float rem
      '==': { i32: 0x46, i64: 0x51, f32: 0x5B, f64: 0x61 },
      '!=': { i32: 0x47, i64: 0x52, f32: 0x5C, f64: 0x62 },
      '<': { i32: 0x48, i64: 0x53, f32: 0x5D, f64: 0x63 },
      '>': { i32: 0x4A, i64: 0x55, f32: 0x5E, f64: 0x64 },
      '<=': { i32: 0x4C, i64: 0x57, f32: 0x5F, f64: 0x65 },
      '>=': { i32: 0x4E, i64: 0x59, f32: 0x60, f64: 0x66 },
    };
    const FNEG = { f32: 0x8C, f64: 0x9A };

    // ─── per-function wasm-local layout ──────────────────────────
    // Function parameters take indices 0..N-1, then each Declare claims
    // the next free slot. A switch in the body requires one extra i32
    // scratch slot (used to stash the switch value so it isn't
    // recomputed per case). The returned record is what the visualizer
    // surfaces in the Locals tab; the emitter consumes it via the
    // name→idx map and declared-types list derived from it below.
    const layoutFor = (astFn) => {
      const params = astFn.parameters.map((p, i) => ({
        name: p.name, type: p.type, idx: i, origin: 'function param',
      }));
      const locals = [];
      let hasSwitch = false;
      const seen = new Set(params.map((p) => p.name));
      const collect = (node) => {
        if (!node) return;
        if (node instanceof AST.Declare) {
          if (seen.has(node.variable.name)) throw new Error('duplicate local: ' + node.variable.name);
          seen.add(node.variable.name);
          locals.push({
            name: node.variable.name, type: node.variable.type,
            idx: params.length + locals.length, origin: 'VarDecl',
          });
        } else if (node instanceof AST.Block) {
          node.statements.forEach(collect);
        } else if (node instanceof AST.If) {
          collect(node.thenBlock); collect(node.elseBlock);
        } else if (node instanceof AST.While) {
          collect(node.body);
        } else if (node instanceof AST.Switch) {
          hasSwitch = true;
          collect(node.body);
        }
      };
      collect(astFn.body);
      if (hasSwitch) {
        locals.push({
          name: '$swScratch', type: 'i32',
          idx: params.length + locals.length, origin: 'switch scratch',
        });
      }
      return { params, locals };
    };

    // fnLayouts is keyed by function NAME (not the AST.Function instance)
    // so the visualizer can look up by name regardless of whether the
    // emitted program was the original AST or the lifted one.
    const fnLayouts = new Map();

    // ─── per-function compilation ────────────────────────────────
    const compileFunction = (fn) => {
      const layout = layoutFor(fn);
      fnLayouts.set(fn.name, layout);
      const locals = new Map();      // name → wasm local index
      for (const r of layout.params) locals.set(r.name, r.idx);
      for (const r of layout.locals) locals.set(r.name, r.idx);
      const declared = layout.locals.map((r) => r.type);
      const switchScratch = layout.locals.find((r) => r.origin === 'switch scratch')?.idx ?? -1;

      // Wasm label scope stack — used to resolve br depths by name.
      const scopes = [];             // [{ name, breakable }]
      const push = (name, breakable = false) => scopes.push({ name, breakable });
      const pop = () => scopes.pop();
      const depth = (name) => {
        for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].name === name) return scopes.length - 1 - i;
        throw new Error('no scope: ' + name);
      };
      const breakTarget = () => {
        for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].breakable) return scopes[i].name;
        throw new Error('Break outside loop/switch');
      };
      let gen = 0;
      const sym = (p) => `${p}_${gen++}`;

      const out = [];

      const emitExpr = (e) => {
        if (e instanceof AST.Literal) {
          if (e.type === 'i32') out.push(0x41, ...s(e.value));
          else if (e.type === 'i64') out.push(0x42, ...s(e.value));
          else if (e.type === 'f32') out.push(0x43, ...f32(Number(e.value)));
          else if (e.type === 'f64') out.push(0x44, ...f64(Number(e.value)));
          else throw new Error('bad literal type: ' + e.type);
        } else if (e instanceof AST.Variable) {
          const idx = locals.get(e.name);
          if (idx === undefined) throw new Error('undefined: ' + e.name);
          out.push(0x20, ...u(idx));
        } else if (e instanceof AST.Binary && (e.op === '&&' || e.op === '||')) {
          // Short-circuit. Use wasm `if (result i32) ... else ... end` so the
          // result is pushed straight onto the stack — no scratch local.
          //   a && b → if (a) { b != 0 } else { 0 }
          //   a || b → if (a) { 1 }       else { b != 0 }
          emitExpr(e.left);
          out.push(0x04, vt('i32'));               // if (result i32)
          if (e.op === '&&') {
            emitExpr(e.right);
            out.push(0x45, 0x45);                  // i32.eqz; i32.eqz  → normalize to 0/1
            out.push(0x05);                        // else
            out.push(0x41, 0);                     // i32.const 0
          } else {
            out.push(0x41, 1);                     // i32.const 1
            out.push(0x05);                        // else
            emitExpr(e.right);
            out.push(0x45, 0x45);                  // i32.eqz; i32.eqz
          }
          out.push(0x0B);                          // end
        } else if (e instanceof AST.Binary) {
          emitExpr(e.left); emitExpr(e.right);
          const t = AST.TYPE.of(e.left);
          const op = BIN[e.op]?.[t];
          if (op === undefined) throw new Error(`no opcode for ${t} ${e.op}`);
          out.push(op);
        } else if (e instanceof AST.Ternary) {
          const t = AST.TYPE.of(e.thenExpr);
          emitExpr(e.cond);
          out.push(0x04, vt(t));                   // if (result T)
          emitExpr(e.thenExpr);
          out.push(0x05);                          // else
          emitExpr(e.elseExpr);
          out.push(0x0B);                          // end
        } else if (e instanceof AST.Unary) {
          const t = AST.TYPE.of(e.operand);
          if (e.op === '-') {
            if (t === 'f32' || t === 'f64') { emitExpr(e.operand); out.push(FNEG[t]); }
            else { out.push(t === 'i64' ? 0x42 : 0x41, 0); emitExpr(e.operand); out.push(BIN['-'][t]); }
          } else if (e.op === '!') {
            emitExpr(e.operand); out.push(0x45);   // i32.eqz
          } else throw new Error('unary: ' + e.op);
        } else if (e instanceof AST.Call) {
          for (const a of e.args) emitExpr(a);
          const idx = funcIdxByFn.get(e.callee);
          if (idx === undefined) throw new Error(`call to unknown function: ${e.callee?.name}`);
          out.push(0x10, ...u(idx));               // call funcIdx
        } else throw new Error('emitExpr: ' + e.constructor.name);
      };

      const emitStmt = (st) => {
        if (st instanceof AST.Block) {
          st.statements.forEach(emitStmt);
        } else if (st instanceof AST.Declare) {
          if (st.initializer) { emitExpr(st.initializer); out.push(0x21, ...u(locals.get(st.variable.name))); }
        } else if (st instanceof AST.Assign) {
          emitExpr(st.value); out.push(0x21, ...u(locals.get(st.variable.name)));
        } else if (st instanceof AST.ExpressionStatement) {
          // Evaluate for side effects; discard the produced value.
          emitExpr(st.expr); out.push(0x1A);       // drop
        } else if (st instanceof AST.If) {
          emitExpr(st.cond);
          out.push(0x04, 0x40);                   // if void
          push(sym('if'));
          emitStmt(st.thenBlock);
          if (st.elseBlock) { out.push(0x05); emitStmt(st.elseBlock); }
          out.push(0x0B); pop();
        } else if (st instanceof AST.While) {
          const exit = sym('w_exit'), cont = sym('w_cont');
          out.push(0x02, 0x40); push(exit, true);   // outer block (break target)
          out.push(0x03, 0x40); push(cont);          // loop (continue target)
          emitExpr(st.cond); out.push(0x45);         // !cond
          out.push(0x0D, ...u(depth(exit)));         // br_if exit
          emitStmt(st.body);
          out.push(0x0C, ...u(depth(cont)));         // br cont
          out.push(0x0B); pop();                     // end loop
          out.push(0x0B); pop();                     // end block
        } else if (st instanceof AST.Switch) {
          // Group the body into regions: a leading Case marker followed by
          // its statements, up to the next Case marker. Each region gets
          // its own wasm block; regions fall through to the next region
          // (C semantics). Any source switch that's not "structured" —
          // Case markers only at top level of body — is rejected here, and
          // compileWithTrace falls back to the lifted (CFG→AST) form.
          const stmts = st.body.statements;
          const regions = [];                        // [{value: number|null, stmts: []}]
          let i0 = 0;
          if (i0 < stmts.length && !(stmts[i0] instanceof AST.Case)) {
            throw new Error('emit: Switch body has statements before first case marker — lift through CFG');
          }
          while (i0 < stmts.length) {
            const marker = stmts[i0++];
            const region = { value: marker.value, stmts: [] };
            while (i0 < stmts.length && !(stmts[i0] instanceof AST.Case)) {
              region.stmts.push(stmts[i0++]);
            }
            regions.push(region);
          }
          const hasNestedCase = (n) => {
            if (!n) return false;
            if (n instanceof AST.Case) return true;
            if (n instanceof AST.Block) return n.statements.some(hasNestedCase);
            if (n instanceof AST.If) return hasNestedCase(n.thenBlock) || hasNestedCase(n.elseBlock);
            if (n instanceof AST.While) return hasNestedCase(n.body);
            return false;       // nested Switch's cases belong to it, not us
          };
          for (const r of regions) {
            if (r.stmts.some(hasNestedCase)) {
              throw new Error('emit: Switch has case marker inside nested control flow — lift through CFG');
            }
          }
          const defaultIdx = regions.findIndex((r) => r.value === null);
          if (regions.filter((r) => r.value === null).length > 1) {
            throw new Error('emit: Switch has multiple default markers');
          }

          // Layout (innermost to outermost): block $end ─ block $regionN-1 ─ … ─ block $region0.
          // Dispatch in region 0's scope. If a default exists, "no match"
          // br's to its region; otherwise it br's to end.
          const N = regions.length;
          const endL = sym('sw_end');
          const regionL = regions.map((_, k) => sym(`sw_r${k}`));
          out.push(0x02, 0x40); push(endL, true);
          for (let k = N - 1; k >= 0; k--) { out.push(0x02, 0x40); push(regionL[k]); }

          emitExpr(st.value); out.push(0x21, ...u(switchScratch));
          for (let k = 0; k < N; k++) {
            if (regions[k].value === null) continue;
            out.push(0x20, ...u(switchScratch));
            out.push(0x41, ...s(regions[k].value));
            out.push(0x46);                          // i32.eq
            out.push(0x0D, ...u(depth(regionL[k]))); // br_if region_k
          }
          if (defaultIdx >= 0) {
            out.push(0x0C, ...u(depth(regionL[defaultIdx])));
          } else {
            out.push(0x0C, ...u(depth(endL)));
          }

          for (let k = 0; k < N; k++) {
            out.push(0x0B); pop();                   // close region_k's block
            for (const s of regions[k].stmts) emitStmt(s);
            // No br end — let execution fall through to the next region.
          }
          out.push(0x0B); pop();                     // close end block
        } else if (st instanceof AST.Case) {
          throw new Error('emit: stray AST.Case marker outside switch body — lift through CFG');
        } else if (st instanceof AST.Break) {
          out.push(0x0C, ...u(depth(breakTarget())));
        } else if (st instanceof AST.Return) {
          emitExpr(st.value); out.push(0x0F);
        } else if (st instanceof AST.Label || st instanceof AST.Goto) {
          throw new Error('emitWasm: Label/Goto unsupported — lift to structured form first');
        } else throw new Error('emitStmt: ' + st.constructor.name);
      };

      emitStmt(fn.body);
      // Falling off the end is a bug (function should have returned). Emit
      // `unreachable` so wasm typechecks regardless of declared return type.
      out.push(0x00, 0x0B);                        // unreachable + end

      // Run-length-encode declared locals by consecutive type.
      const groups = [];
      for (const t of declared) {
        const g = groups[groups.length - 1];
        if (g && g.t === t) g.n++; else groups.push({ n: 1, t });
      }
      const localsEnc = vec(groups.map((g) => [...u(g.n), vt(g.t)]));
      return [...localsEnc, ...out];
    };

    // ─── intern signatures into the type section ────────────────
    const typeIdx = new Map();
    const typeEntries = [];
    const internType = (paramTypes, returnType) => {
      const key = paramTypes.join(',') + '->' + returnType;
      if (typeIdx.has(key)) return typeIdx.get(key);
      const i = typeEntries.length;
      typeIdx.set(key, i);
      typeEntries.push({ paramTypes, returnType });
      return i;
    };

    // Resolve AST.Function references to wasm function indices. Built
    // BEFORE compileFunction runs so call sites in any body can be
    // resolved. Keyed by AST.Function identity, not by name — calls hold
    // a direct ref to their target Function.
    const funcIdxByFn = new Map();
    program.functions.forEach((fn, i) => funcIdxByFn.set(fn, i));

    const funcs = program.functions.map((fn) => ({
      fn,
      typeIdx: internType(fn.parameters.map((p) => p.type), fn.returnType),
      code: compileFunction(fn),
    }));

    // ─── module assembly ────────────────────────────────────────
    const out = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];

    out.push(...sect(1, vec(typeEntries.map(({ paramTypes, returnType }) => [
      0x60,
      ...vec(paramTypes.map((t) => [vt(t)])),
      ...vec([[vt(returnType)]]),
    ]))));
    out.push(...sect(3, vec(funcs.map((f) => u(f.typeIdx)))));
    out.push(...sect(7, vec(funcs.map((f, i) => [...str(f.fn.name), 0x00, ...u(i)]))));
    out.push(...sect(10, vec(funcs.map((f) => [...u(f.code.length), ...f.code]))));

    return { bytes: new Uint8Array(out), fnLayouts };
  }

  // ─────────────────────── compile entry points ───────────────────────
  //
  // Same shape as c0's compileWithTrace: gather tokens, AST, CFG, lifted
  // AST, wasm bytes, and the per-function wasm-local layout in one pass.
  // CFG / lift / emit are each best-effort — if one throws, the visualizer
  // still gets every prior stage's result.
  function compileWithTrace(source, filename = '<input>') {
    const tokens = PARSER.tokenize(source);
    const ast = PARSER.parse(source);
    let mod = null, modError = null;
    try { mod = CFG.fromAST(ast); } catch (e) { modError = e; }
    let lifted = null, liftedError = null;
    if (mod) {
      try { lifted = CFG.intoAST(mod); } catch (e) { liftedError = e; }
    }
    // Direct emit on the source AST first. If that rejects something (e.g.
    // a goto-bearing program), fall back to the lifted form.
    let emitResult = null, bytesError = null;
    try {
      emitResult = emit(ast);
    } catch (e) {
      bytesError = e;
      if (lifted) {
        try { emitResult = emit(lifted); bytesError = null; }
        catch (e2) { bytesError = e2; }
      }
    }
    const bytes = emitResult ? emitResult.bytes : null;
    const fnTraces = emitResult ? emitResult.fnLayouts : new Map();

    return {
      tokens, ast, mod, lifted, bytes, fnTraces,
      modError, liftedError, bytesError,
    };
  }

  return { emit, compileWithTrace };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AST, PARSER, CFG, CODEGEN };
}
