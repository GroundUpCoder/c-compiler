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

  // PARALLEL_ASSIGN((a, b, ...), (e0, e1, ...));
  //
  // Parallel-copy semantics: every rvalue expression is evaluated first,
  // then the resulting values are bound to the lvalue variables. Reads
  // observe pre-assignment state of all variables (so swaps like
  // PARALLEL_ASSIGN((a, b), (b, a)) work without temps in source).
  //
  // Constraints: lvalues are bare AST.Variable identifiers (no array
  // index, no field access); arities must match; element types must match
  // pairwise; lvalues must already be declared (does not declare).
  //
  // intoAST also emits this for SSA destruction — block-param assigns on
  // each predecessor edge become a single ParallelAssign, removing the
  // need for hazard analysis and destruction temps.
  class ParallelAssign {
    constructor(loc, lvalues, rvalues) {
      this.loc = loc;
      this.lvalues = lvalues; // Variable[]
      this.rvalues = rvalues; // Expression[]
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

  class DoWhile {
    constructor(loc, body, cond) {
      this.loc = loc;
      this.body = body; // Block
      this.cond = cond; // Expression
    }
  }

  class Break {
    constructor(loc) {
      this.loc = loc;
    }
  }

  // Just a marker: `name:` in source. Goto targets resolve by walking the
  // enclosing block. A later lifting pass turns flat labels + gotos into
  // structured control flow before CODEGEN.emit.
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
      } else if (st instanceof ParallelAssign) {
        const lhs = st.lvalues.map((v) => v.name).join(', ');
        const rhs = st.rvalues.map((e) => printExpr(e)).join(', ');
        lines.push(`${pad}PARALLEL_ASSIGN((${lhs}), (${rhs}));`);
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
      } else if (st instanceof DoWhile) {
        lines.push(`${pad}do {`);
        printStmt(st.body, ind + 1);
        lines.push(`${pad}} while (${printExpr(st.cond)});`);
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
    Declare, Assign, ParallelAssign, ExpressionStatement,
    Binary, Unary, Ternary, Call,
    Switch, Case, If, While, DoWhile, Break,
    Label, Goto, Return,
    TYPE, printSource,
  };
})();

const PARSER = (() => {

  function tokenize(source) {
    const KEYWORDS = new Set([
      'i32', 'i64', 'f32', 'f64',
      'while', 'do', 'break', 'switch', 'case', 'default',
      'if', 'else', 'goto', 'return',
      'PARALLEL_ASSIGN',
    ]);
    // Source-level type aliases: `int x;` lexes identically to `i32 x;`.
    // The alias is folded away at tokenize time, so the AST/CFG/codegen
    // only ever see the canonical wasm names.
    const TYPE_ALIAS = { int: 'i32', long: 'i64', float: 'f32', double: 'f64' };
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
        const text = munch(/[a-zA-Z0-9_]/);
        const name = TYPE_ALIAS[text] ?? text;
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
      if (at('do')) return parseDoWhile();
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
      // PARALLEL_ASSIGN((id, id, ...), (expr, expr, ...));
      // Reads all rvalues before writing any lvalue. lvalues are bare
      // identifiers of already-declared variables. Arities must match.
      // Zero-arity (PARALLEL_ASSIGN((), ())) is permitted as a no-op.
      if (at('PARALLEL_ASSIGN')) {
        const t = advance();
        expect('(');
        expect('(');
        const lvalues = [];
        if (!at(')')) {
          do {
            const id = expect('ID');
            const v = scope[id.value];
            if (!v) throw new Error(`Undefined variable ${id.value} at line ${id.line}:${id.col}`);
            lvalues.push(v);
          } while (eat(','));
        }
        expect(')');
        expect(',');
        expect('(');
        const rvalues = [];
        if (!at(')')) {
          do { rvalues.push(parseExpression()); } while (eat(','));
        }
        expect(')');
        expect(')');
        expect(';');
        if (lvalues.length !== rvalues.length) {
          throw new Error(`PARALLEL_ASSIGN arity mismatch: ${lvalues.length} lvalues vs ${rvalues.length} rvalues at line ${t.line}:${t.col}`);
        }
        for (let i = 0; i < lvalues.length; i++) {
          const lt = lvalues[i].type;
          const rt = AST.TYPE.of(rvalues[i]);
          if (lt !== rt) {
            throw new Error(`PARALLEL_ASSIGN type mismatch at position ${i}: ${lvalues[i].name} is ${lt} but rvalue is ${rt} at line ${t.line}:${t.col}`);
          }
        }
        return new AST.ParallelAssign(loc(t), lvalues, rvalues);
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

    function parseDoWhile() {
      const t = expect('do');
      const body = parseBlock();
      expect('while');
      expect('(');
      const cond = parseExpression();
      expect(')');
      expect(';');
      return new AST.DoWhile(loc(t), body, cond);
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

  // ────── Static Single Assignment (SSA) CFG ──────
  //
  // Every operation produces a Value. A Value is defined exactly once —
  // either by an instruction's `dest`, by a basic block parameter, or by
  // a function parameter. Source-level mutability (`x = x + 1`) is encoded
  // by allocating a fresh Value at each definition site; control-flow joins
  // reconcile multiple incoming Values via *block parameters* (the
  // Cranelift / MLIR / SwiftIR alternative to phi nodes — a target's
  // params describe the values it expects from each predecessor, and each
  // predecessor's terminator carries a matching list of args).
  //
  // SSA construction follows Braun et al. 2013, "Simple and Efficient
  // Construction of SSA Form" — `readVariable` / `writeVariable` track
  // the "current Value of source-var X at the end of block B", and the
  // *sealed-block* trick handles forward references (back edges in loops,
  // forward gotos) without needing a separate dominator computation.
  //
  // No Copy instruction: SSA needs no explicit move. The c1 cases that
  // used Copy — `&&` / `||` short-circuit dests, `?:` arms, source-level
  // `x = y` — are subsumed by block parameters and by re-binding the
  // source variable's currentDef without emitting any instruction.

  // ────── Values ──────

  class Value {
    constructor(type, name) {
      this.type = type;        // 'i32' | 'i64' | 'f32' | 'f64'
      this.name = name;        // string — for display & destruction
      this.id = -1;            // assigned by the owning Function
    }
  }

  // ────── Instructions ──────

  class Instruction {
    constructor(loc, dest) {
      this.loc = loc;
      this.dest = dest;                  // Value
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
  // '&&' / '||' never appear here — they lower to control flow plus a
  // block parameter at the join.
  class BinaryOp extends Instruction {
    constructor(loc, dest, op, lhs, rhs) {
      super(loc, dest);
      this.op = op;
      this.lhs = lhs;                    // Value
      this.rhs = rhs;                    // Value
    }
  }

  // dest = <op> operand       (op: '-' (float negate) or '!' (eqz))
  // Integer '-' is lowered to `0 - x` BinaryOp.
  class UnaryOp extends Instruction {
    constructor(loc, dest, op, operand) {
      super(loc, dest);
      this.op = op;
      this.operand = operand;            // Value
    }
  }

  // dest = call <callee>(args...). `callee` is a direct CFG.Function
  // reference. dest is always present (no void functions), even when the
  // source-level call was an ExpressionStatement — the dest just goes unused.
  class Call extends Instruction {
    constructor(loc, dest, callee, args) {
      super(loc, dest);
      this.callee = callee;              // CFG.Function
      this.args = args;                  // Value[]
    }
  }

  // ────── Terminators ──────
  //
  // Branch terminators carry an args list per outgoing edge — one Value
  // per parameter of the target block. (Block parameters are c2's
  // alternative to phi nodes.) cond / value reference Values; never
  // expression trees.

  class Terminator {
    constructor(loc) { this.loc = loc; }
    get successors() { return []; }
  }

  class Br extends Terminator {
    constructor(loc, target, args = []) {
      if (!(target instanceof BasicBlock)) throw new Error('Br: target must be a BasicBlock');
      super(loc);
      this.target = target;
      this.args = args;                  // Value[] — one per target.params
    }
    get successors() { return [this.target]; }
  }

  class BrIf extends Terminator {
    constructor(loc, cond, trueTarget, falseTarget, trueArgs = [], falseArgs = []) {
      if (!(trueTarget instanceof BasicBlock) || !(falseTarget instanceof BasicBlock)) {
        throw new Error('BrIf: targets must be BasicBlocks');
      }
      super(loc);
      this.cond = cond;                  // Value (i32)
      this.trueTarget = trueTarget;
      this.falseTarget = falseTarget;
      this.trueArgs = trueArgs;          // Value[] — one per trueTarget.params
      this.falseArgs = falseArgs;        // Value[] — one per falseTarget.params
    }
    get successors() { return [this.trueTarget, this.falseTarget]; }
  }

  class Return extends Terminator {
    constructor(loc, value) {
      super(loc);
      this.value = value;                // Value
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
      this.params = [];                  // Value[] — block parameters
      this.instructions = [];            // Instruction[]
      this.terminator = null;
      this.predecessors = [];            // BasicBlock[] — maintained by terminate()
      this.sealed = false;               // Braun: true once all preds are known
      // SSA construction state (private; consulted only during fromAST):
      this._fn = null;                   // back-pointer set by createBlock
      this._currentDef = new Map();      // AST.Variable → Value (end-of-block)
      this._incompletePhis = new Map();  // AST.Variable → Value (param awaiting operands)
    }
    append(ins) {
      if (this.terminator) throw new Error(`Block '${this.name}' already terminated`);
      this.instructions.push(ins);
      return ins;
    }
    terminate(t) {
      if (this.terminator) throw new Error(`Block '${this.name}' already terminated`);
      this.terminator = t;
      // Maintain predecessors on successors. A BrIf with the same true / false
      // target intentionally adds two entries (one per edge).
      for (const succ of t.successors) succ.predecessors.push(this);
    }
  }

  class Function {
    constructor(name, params, returnType, exportName = null) {
      this.name = name;
      this.params = params;              // AST.Variable[] (source-level params)
      this.returnType = returnType;
      this.exportName = exportName;
      this.blocks = [];
      this._valueCounter = 0;
      // _takenNames starts empty; param Values get minted first and claim
      // the source names cleanly. Later Values for reassigned source vars
      // get suffixed (e.g. `x_1`, `x_2`).
      this._takenNames = new Set();
      this.entry = this.createBlock('entry');
      // Mint one Value per source param, binding it in entry._currentDef.
      // The entry block has no other predecessors — sealed at birth.
      // Params use newParamValue so they claim the bare source-var name
      // ('n', 'a', etc.) — matching how the function signature reads.
      this.paramValues = params.map((p) => {
        const v = this.newParamValue(p.type, p.name);
        this.entry._currentDef.set(p, v);
        return v;
      });
      this.entry.sealed = true;
    }
    newValue(type, hint = null) {
      // Pick a unique name. When a hint is provided, ALWAYS suffix
      // with a counter — never claim the bare hint name. Source
      // variable names like 'x' produce 'x_1', 'x_2', etc. across
      // multiple definitions, keeping every SSA Value visually
      // distinct from the source-var it represents.
      //
      // Bare source-var names are reserved for the function parameter
      // Values, which use newParamValue() instead. That makes the
      // lifted function signature stay 'i32 f(i32 n)' while internal
      // SSA Values for assignments / phis read as 'n_1', 'n_2', etc.
      let name;
      const base = hint ?? '__v';
      let k = 1;
      do { name = `${base}_${k++}`; } while (this._takenNames.has(name));
      this._takenNames.add(name);
      const v = new Value(type, name);
      v.id = this._valueCounter++;
      return v;
    }
    newParamValue(type, name) {
      // Params claim the bare source-var name directly. Distinct path
      // from newValue (which always-suffixes) so the function
      // parameter Value stays callable as `n`, `a`, `b` etc. in the
      // IR — matching how the function signature reads.
      if (this._takenNames.has(name)) {
        throw new Error(`newParamValue: name '${name}' already taken`);
      }
      this._takenNames.add(name);
      const v = new Value(type, name);
      v.id = this._valueCounter++;
      return v;
    }
    createBlock(name) {
      const b = new BasicBlock(name);
      b.id = this.blocks.length;
      b._fn = this;
      this.blocks.push(b);
      return b;
    }
  }

  class Module {
    constructor(functions) { this.functions = functions; }
  }

  function fromAST(program) {
    // Lower AST.Program => CFG.Module (SSA).
    //
    // Expressions become Const / BinaryOp / UnaryOp / Call instructions
    // whose `dest` is a fresh Value. Source-level variable reads route
    // through readVariable (Braun's algorithm); writes via writeVariable.
    // Short-circuit (`&&` / `||`) and ternary (`?:`) merge their two
    // paths via a manually-constructed block parameter on the exit
    // block.
    //
    // Two-pass: (1) pre-mint a CFG.Function per AST.Function (so any Call
    // resolves, including forward refs). (2) lower each body. Cross-layer
    // linkage AST.Function → CFG.Function lives in cfgByAst.

    // ────── Braun SSA construction primitives ──────

    function writeVariable(astVar, block, value) {
      block._currentDef.set(astVar, value);
    }

    function readVariable(astVar, block) {
      if (block._currentDef.has(astVar)) return block._currentDef.get(astVar);
      return readVariableRecursive(astVar, block);
    }

    function readVariableRecursive(astVar, block) {
      let val;
      if (!block.sealed) {
        // Forward reference: predecessor set isn't final yet (e.g. loop
        // header pending back edge, or a label awaiting forward goto).
        // Create a block param now; fill operands on sealBlock.
        val = createBlockParam(block, astVar);
        block._incompletePhis.set(astVar, val);
      } else if (block.predecessors.length === 0) {
        throw new Error(`SSA: '${astVar.name}' read before any definition`);
      } else if (block.predecessors.length === 1) {
        val = readVariable(astVar, block.predecessors[0]);
      } else {
        // Multi-pred join: introduce a block param. Bind it before resolving
        // operands so any cycle through this block terminates.
        val = createBlockParam(block, astVar);
        writeVariable(astVar, block, val);
        fillBlockParamOperands(astVar, block, val);
      }
      writeVariable(astVar, block, val);
      return val;
    }

    function createBlockParam(block, astVar) {
      const v = block._fn.newValue(astVar.type, astVar.name);
      block.params.push(v);
      return v;
    }

    // For each predecessor of `block`, find that pred's current Value for
    // `astVar` and assign it to the matching args slot on the pred's
    // terminator. Index-based (not push) so recursive readVariable cannot
    // interleave param creations into the args list in the wrong order.
    // JS sparse arrays let us set args[k] even when args.length < k —
    // intermediate slots are filled by other params' fill calls.
    function fillBlockParamOperands(astVar, block, paramValue) {
      const k = block.params.indexOf(paramValue);
      if (k < 0) throw new Error(`fillBlockParamOperands: paramValue not in block.params`);
      for (const pred of block.predecessors) {
        const arg = readVariable(astVar, pred);
        const term = pred.terminator;
        if (term instanceof Br) {
          term.args[k] = arg;
        } else if (term instanceof BrIf) {
          if (term.trueTarget === block) term.trueArgs[k] = arg;
          if (term.falseTarget === block) term.falseArgs[k] = arg;
        } else {
          throw new Error(`fillBlockParamOperands: predecessor of '${block.name}' has non-branching terminator`);
        }
      }
    }

    function sealBlock(block) {
      if (block.sealed) return;
      for (const [astVar, val] of block._incompletePhis) {
        fillBlockParamOperands(astVar, block, val);
      }
      block._incompletePhis.clear();
      block.sealed = true;
    }

    // ────── SSA phi cleanup via Tarjan SCC (Braun §3.3) ──────
    //
    // After SSA construction some block-param phis are redundant — they
    // can be replaced by an existing value with no change in semantics.
    // Two cases:
    //
    //   1. A phi whose non-self-ref operands all equal one value V.
    //      (Braun §3.2 "trivial" phi.) Common sources: variables that
    //      aren't reassigned across a join; eager phi creation at
    //      unsealed blocks; loop-header phis where the body never
    //      reassigns.
    //
    //   2. A *cycle* of phis whose operands collectively reference only
    //      each other plus one outside value V. Locally each phi has
    //      two distinct operands (another phi + V) — neither is trivial
    //      in isolation. But globally the cycle collapses to V.
    //      (Braun §3.3 "almost trivial" via SCC.)
    //
    // Case (1) is the size-1 specialization of case (2). A single SCC
    // pass over the phi-dependence graph handles both uniformly and
    // produces minimal SSA on ALL CFGs — including irreducible CFGs
    // arising from arbitrary goto / Duff's-device-style code.
    //
    // The phi-dependence graph G has:
    //   nodes: every block param (phi) in the function
    //   edges: phi X → phi Y iff X is an operand of Y
    //
    // Algorithm:
    //   1. Build G's adjacency from each phi's operand list.
    //   2. Run iterative Tarjan SCC. Emits SCCs in reverse-topological
    //      order of the condensation.
    //   3. Iterate SCCs in topological order (reverse of Tarjan's
    //      emission) — operand-sources processed before operand-readers,
    //      so by the time we classify an SCC's operands, any prior SCC
    //      it references has either collapsed (and replaceAllUses already
    //      rewrote the operand slot to its canonical value) or remained
    //      as a genuine external phi value.
    //   4. For each SCC, compute external operands — operands of phis in
    //      the SCC that aren't self-refs and aren't other phis in the
    //      same SCC. If they all equal one V, collapse the SCC to V.

    function argAtSlot(pred, target, k) {
      const t = pred.terminator;
      if (t instanceof Br) return t.args[k];
      if (t instanceof BrIf) {
        if (t.trueTarget === target) return t.trueArgs[k];
        if (t.falseTarget === target) return t.falseArgs[k];
      }
      throw new Error('argAtSlot: pred has no branching terminator targeting block');
    }

    function removeArgAtSlot(pred, target, k) {
      const t = pred.terminator;
      if (t instanceof Br) t.args.splice(k, 1);
      else if (t instanceof BrIf) {
        // A BrIf with the same true/false target intentionally keeps two
        // matching slots — one in each args list — and the predecessors
        // list is also doubled. Shrink whichever list(s) correspond to the
        // current edge in this iteration.
        if (t.trueTarget === target) t.trueArgs.splice(k, 1);
        if (t.falseTarget === target) t.falseArgs.splice(k, 1);
      }
    }

    // Walk the function substituting every reference to `oldV` with `newV`.
    // Returns the list of {block, value} phis whose args contained oldV —
    // these are candidates for re-checking on the worklist.
    function replaceAllUses(cfgFn, oldV, newV) {
      const usersToRecheck = [];
      const recordPhiUse = (target, slotIdx) => {
        if (slotIdx < target.params.length) {
          usersToRecheck.push({ block: target, value: target.params[slotIdx] });
        }
      };
      for (const block of cfgFn.blocks) {
        for (const ins of block.instructions) {
          if (ins instanceof BinaryOp) {
            if (ins.lhs === oldV) ins.lhs = newV;
            if (ins.rhs === oldV) ins.rhs = newV;
          } else if (ins instanceof UnaryOp) {
            if (ins.operand === oldV) ins.operand = newV;
          } else if (ins instanceof Call) {
            for (let i = 0; i < ins.args.length; i++) {
              if (ins.args[i] === oldV) ins.args[i] = newV;
            }
          }
          // Const: no operands.
        }
        const t = block.terminator;
        if (t instanceof Br) {
          for (let i = 0; i < t.args.length; i++) {
            if (t.args[i] === oldV) { t.args[i] = newV; recordPhiUse(t.target, i); }
          }
        } else if (t instanceof BrIf) {
          if (t.cond === oldV) t.cond = newV;
          for (let i = 0; i < t.trueArgs.length; i++) {
            if (t.trueArgs[i] === oldV) { t.trueArgs[i] = newV; recordPhiUse(t.trueTarget, i); }
          }
          for (let i = 0; i < t.falseArgs.length; i++) {
            if (t.falseArgs[i] === oldV) { t.falseArgs[i] = newV; recordPhiUse(t.falseTarget, i); }
          }
        } else if (t instanceof Return) {
          if (t.value === oldV) t.value = newV;
        }
        // Unreachable: no operands.
      }
      return usersToRecheck;
    }

    // Iterative Tarjan SCC over the phi-dependence graph. Returns SCCs
    // in DFS-finish (reverse-topological) order. Iterative because deep
    // CFGs (Duff's device, dispatcher loops) can overflow JS recursion.
    function tarjanSCC(nodes, adj) {
      let nextIndex = 0;
      const indexOf = new Map();
      const lowlinkOf = new Map();
      const stack = [];
      const onStack = new Set();
      const sccs = [];

      function strongconnect(start) {
        // Stack frame: { v, it, justReturnedFrom }
        const frames = [{ v: start, it: (adj.get(start) || []).values(), justReturnedFrom: null }];
        indexOf.set(start, nextIndex);
        lowlinkOf.set(start, nextIndex);
        nextIndex++;
        stack.push(start);
        onStack.add(start);

        while (frames.length > 0) {
          const top = frames[frames.length - 1];
          // If we just returned from a child, fold its lowlink into ours.
          if (top.justReturnedFrom !== null) {
            lowlinkOf.set(top.v, Math.min(lowlinkOf.get(top.v), lowlinkOf.get(top.justReturnedFrom)));
            top.justReturnedFrom = null;
          }
          let recursed = false;
          while (true) {
            const next = top.it.next();
            if (next.done) break;
            const w = next.value;
            if (!indexOf.has(w)) {
              indexOf.set(w, nextIndex);
              lowlinkOf.set(w, nextIndex);
              nextIndex++;
              stack.push(w);
              onStack.add(w);
              top.justReturnedFrom = w;
              frames.push({ v: w, it: (adj.get(w) || []).values(), justReturnedFrom: null });
              recursed = true;
              break;
            } else if (onStack.has(w)) {
              lowlinkOf.set(top.v, Math.min(lowlinkOf.get(top.v), indexOf.get(w)));
            }
          }
          if (recursed) continue;
          // No more neighbors. If v is an SCC root, pop the SCC off the stack.
          if (lowlinkOf.get(top.v) === indexOf.get(top.v)) {
            const scc = [];
            let w;
            do {
              w = stack.pop();
              onStack.delete(w);
              scc.push(w);
            } while (w !== top.v);
            sccs.push(scc);
          }
          frames.pop();
        }
      }

      for (const v of nodes) {
        if (!indexOf.has(v)) strongconnect(v);
      }
      return sccs;
    }

    function trimPhis(cfgFn) {
      // phiInfo: phi Value → { block, slotIdx }. Slot indices shift as
      // we splice phis out of params; the splice-batch step below keeps
      // this map current for the remaining params in each affected block.
      const phiInfo = new Map();
      for (const b of cfgFn.blocks) {
        for (let k = 0; k < b.params.length; k++) {
          phiInfo.set(b.params[k], { block: b, slotIdx: k });
        }
      }
      if (phiInfo.size === 0) return;

      // Build the phi-dep adjacency. For each phi Y, for each of Y's
      // operands O at any pred slot, if O is itself a phi, add edge O→Y.
      const adj = new Map();
      for (const Y of phiInfo.keys()) adj.set(Y, new Set());
      for (const [Y, { block, slotIdx }] of phiInfo) {
        for (const pred of block.predecessors) {
          const arg = argAtSlot(pred, block, slotIdx);
          if (phiInfo.has(arg)) adj.get(arg).add(Y);
        }
      }

      // Tarjan emits SCCs in reverse-topological order; we want
      // topological (operand-source SCCs first) so iterate in reverse.
      const sccs = tarjanSCC([...phiInfo.keys()], adj);
      for (let i = sccs.length - 1; i >= 0; i--) {
        const scc = sccs[i];
        const sccSet = new Set(scc);

        // Compute the SCC's external operands. self-refs and within-SCC
        // edges are ignored. Operands referencing prior already-collapsed
        // SCCs were rewritten to their canonical value by replaceAllUses
        // below, so by now they read as plain non-phi values.
        let canonical = null;
        let nonTrivial = false;
        for (const Y of scc) {
          const { block, slotIdx } = phiInfo.get(Y);
          for (const pred of block.predecessors) {
            const arg = argAtSlot(pred, block, slotIdx);
            if (arg === Y) continue;            // self-ref
            if (sccSet.has(arg)) continue;      // internal SCC edge
            if (canonical === null) canonical = arg;
            else if (canonical !== arg) { nonTrivial = true; break; }
          }
          if (nonTrivial) break;
        }
        if (nonTrivial) continue;
        if (canonical === null) continue;       // unreachable cycle, leave alone

        // Collapse: replace uses of each phi in SCC with canonical, then
        // splice each phi out of its block's params (descending slot
        // order per block to keep earlier indices valid), and strip the
        // corresponding pred arg slots.
        for (const Y of scc) replaceAllUses(cfgFn, Y, canonical);
        const byBlock = new Map();
        for (const Y of scc) {
          const { block, slotIdx } = phiInfo.get(Y);
          if (!byBlock.has(block)) byBlock.set(block, []);
          byBlock.get(block).push(slotIdx);
        }
        for (const [blk, slots] of byBlock) {
          slots.sort((a, b) => b - a);
          for (const k of slots) {
            blk.params.splice(k, 1);
            for (const pred of blk.predecessors) removeArgAtSlot(pred, blk, k);
          }
          // Re-index remaining params so future SCC lookups stay correct.
          for (let j = 0; j < blk.params.length; j++) {
            phiInfo.set(blk.params[j], { block: blk, slotIdx: j });
          }
        }
        for (const Y of scc) phiInfo.delete(Y);
      }
    }

    // Pass 1: pre-create CFG.Functions.
    const cfgByAst = new Map();
    for (const astFn of program.functions) {
      cfgByAst.set(astFn,
        new CFG.Function(astFn.name, astFn.parameters, astFn.returnType, astFn.name));
    }

    const lowerFunction = (astFn) => {
      const cfgFn = cfgByAst.get(astFn);

      // Pre-scan for labels and Case markers. Source-level locals don't get
      // registered here — in SSA they aren't standalone storage; each
      // definition site produces a fresh Value tracked through
      // writeVariable. Label and Case blocks get pre-created so forward
      // jumps (gotos / dispatch BrIfs) can resolve; they stay unsealed
      // until their predecessor set is finalized (labels at function-end,
      // case blocks at switch-end).
      const labelBlocks = new Map();
      const caseBlocks = new Map();         // AST.Case node → BasicBlock
      const scan = (n) => {
        if (!n) return;
        if (n instanceof AST.Label) {
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
        } else if (n instanceof AST.DoWhile) {
          scan(n.body);
        }
      };
      scan(astFn.body);

      let current = cfgFn.entry;
      const breakStack = [];                 // exit BasicBlock of innermost loop/switch
      const append = (s) => { if (current) current.append(s); };
      const terminate = (t) => { if (current) { current.terminate(t); current = null; } };
      // Resume current at `block` unless `block` ended up with no predecessors
      // (e.g. join after both branches Returned) — in which case drop into
      // dead-code mode so subsequent stmts get dropped instead of erroring.
      const useOrDrop = (block) => {
        sealBlock(block);
        current = block.predecessors.length > 0 ? block : null;
      };

      // --- Value-emitting helpers ---
      // The `hint` parameter on each emit helper threads through to
      // newValue's name policy. Used so an assignment's outermost
      // result Value can carry the assigned-to source-var's name:
      // `x = 1` produces a Value named `x_1` instead of `__v_2`.
      // Sub-expressions don't carry hints — they stay `__v_N`.
      const emitConst = (type, value, loc, hint = null) => {
        const dest = cfgFn.newValue(type, hint);
        append(new CFG.Const(loc, dest, value));
        return dest;
      };
      const emitBinop = (op, lhs, rhs, type, loc, hint = null) => {
        const dest = cfgFn.newValue(type, hint);
        append(new CFG.BinaryOp(loc, dest, op, lhs, rhs));
        return dest;
      };
      const emitUnop = (op, operand, type, loc, hint = null) => {
        const dest = cfgFn.newValue(type, hint);
        append(new CFG.UnaryOp(loc, dest, op, operand));
        return dest;
      };
      const emitCallIns = (callee, args, type, loc, hint = null) => {
        const dest = cfgFn.newValue(type, hint);
        append(new CFG.Call(loc, dest, callee, args));
        return dest;
      };

      // emitExpr returns the Value holding the expression's result.
      // `hint` is the source-var name (if any) the result is being
      // assigned to. Forwarded ONLY to the outermost instruction's
      // dest. Sub-expression recursion calls drop the hint so
      // operands keep generic __v_N names — only the assignment's
      // top-level Value carries the source-var-themed name.
      const emitExpr = (e, hint = null) => {
        if (e instanceof AST.Literal) {
          return emitConst(e.type, e.value, e.loc, hint);
        }
        if (e instanceof AST.Variable) {
          // Source-level variable read: route through Braun's algorithm.
          if (!current) throw new Error('emitExpr: read in unreachable position');
          return readVariable(e, current);
        }
        if (e instanceof AST.Binary && (e.op === '&&' || e.op === '||')) {
          return emitShortCircuit(e, hint);
        }
        if (e instanceof AST.Binary) {
          const lhs = emitExpr(e.left);
          const rhs = emitExpr(e.right);
          return emitBinop(e.op, lhs, rhs, AST.TYPE.of(e), e.loc, hint);
        }
        if (e instanceof AST.Unary) {
          const opTy = AST.TYPE.of(e.operand);
          if (e.op === '-' && (opTy === 'i32' || opTy === 'i64')) {
            // 0 - x for integer negation (wasm has no integer neg).
            const zeroV = emitConst(opTy, opTy === 'i64' ? 0n : 0, e.loc);
            const x = emitExpr(e.operand);
            return emitBinop('-', zeroV, x, opTy, e.loc, hint);
          }
          const operand = emitExpr(e.operand);
          return emitUnop(e.op, operand, AST.TYPE.of(e), e.loc, hint);
        }
        if (e instanceof AST.Ternary) {
          return emitTernary(e, hint);
        }
        if (e instanceof AST.Call) {
          const argVals = e.args.map((a) => emitExpr(a));
          const calleeCfg = cfgByAst.get(e.callee);
          if (!calleeCfg) throw new Error(`fromAST: no CFG.Function for '${e.callee.name}'`);
          return emitCallIns(calleeCfg, argVals, e.callee.returnType, e.loc, hint);
        }
        throw new Error('emitExpr: ' + e.constructor.name);
      };

      // a && b in SSA:
      //   cur:   a_v = eval a; skip = const 0;
      //          brIf a_v → rhsB(), exitB(skip)
      //   rhsB:  b_v = eval b; bNorm = b_v != 0;
      //          br exitB(bNorm)
      //   exitB(result): ...
      // a || b is symmetric: skip = const 1; brIf a_v → exitB(skip), rhsB().
      // The exit block's single param `result` is the value of the
      // short-circuit expression.
      const emitShortCircuit = (e, hint = null) => {
        const rhsB = cfgFn.createBlock(e.op === '&&' ? 'and_rhs' : 'or_rhs');
        rhsB.sealed = true;                       // single pred (cur)
        const exitB = cfgFn.createBlock(e.op === '&&' ? 'and_exit' : 'or_exit');

        // Pre-declare exitB's result param so each predecessor's BrIf/Br
        // can carry its arg matching params[0]. If the surrounding
        // assignment passed a source-var hint, prefer it over the
        // synthetic 'and_result' / 'or_result' name.
        const resultV = cfgFn.newValue('i32', hint || (e.op === '&&' ? 'and_result' : 'or_result'));
        exitB.params.push(resultV);

        const lhs = emitExpr(e.left);
        const skipV = emitConst('i32', e.op === '&&' ? 0 : 1, e.loc);

        if (e.op === '&&') {
          terminate(new CFG.BrIf(e.loc, lhs, rhsB, exitB, [], [skipV]));
        } else {
          terminate(new CFG.BrIf(e.loc, lhs, exitB, rhsB, [skipV], []));
        }

        current = rhsB;
        const rhs = emitExpr(e.right);
        // Normalize rhs to canonical 0 or 1 via `rhs != 0`.
        const rhsZero = emitConst('i32', 0, e.loc);
        const rhsNorm = emitBinop('!=', rhs, rhsZero, 'i32', e.loc);
        terminate(new CFG.Br(e.loc, exitB, [rhsNorm]));

        sealBlock(exitB);
        current = exitB;
        return resultV;
      };

      // c ? t : e in SSA:
      //   cur:   c_v = eval c; brIf c_v → thenB, elseB
      //   thenB: t_v = eval t; br exitB(t_v)
      //   elseB: e_v = eval e; br exitB(e_v)
      //   exitB(result): ...
      const emitTernary = (e, hint = null) => {
        const ty = AST.TYPE.of(e.thenExpr);
        const thenB = cfgFn.createBlock('tern_then');
        thenB.sealed = true;
        const elseB = cfgFn.createBlock('tern_else');
        elseB.sealed = true;
        const exitB = cfgFn.createBlock('tern_exit');
        // Same logic as emitShortCircuit: pick the hint if provided.
        const resultV = cfgFn.newValue(ty, hint || 'tern_result');
        exitB.params.push(resultV);

        const cond = emitExpr(e.cond);
        terminate(new CFG.BrIf(e.loc, cond, thenB, elseB));

        current = thenB;
        const thenV = emitExpr(e.thenExpr);
        terminate(new CFG.Br(e.loc, exitB, [thenV]));

        current = elseB;
        const elseV = emitExpr(e.elseExpr);
        terminate(new CFG.Br(e.loc, exitB, [elseV]));

        sealBlock(exitB);
        current = exitB;
        return resultV;
      };

      const emitStmt = (st) => {
        // Labels, Case markers, and Blocks are handled even when `current`
        // is null: labels/cases are reachable jump targets that can
        // resurrect a dead position, and Blocks must recurse to surface
        // any such markers nested inside an otherwise-dead arm.
        if (st instanceof AST.Label) {
          const target = labelBlocks.get(st.name);
          if (current) terminate(new CFG.Br(st.loc, target));
          current = target;                      // label stays unsealed
          return;
        }
        if (st instanceof AST.Case) {
          const target = caseBlocks.get(st);
          if (current) terminate(new CFG.Br(st.loc, target));
          current = target;                      // case block stays unsealed until switch end
          return;
        }
        if (st instanceof AST.Block) {
          st.statements.forEach(emitStmt);
          return;
        }
        if (!current) return;
        if (st instanceof AST.Declare) {
          // Bind the declared variable in the current block. With an explicit
          // initializer, use that. Without one, match wasm's zero-init
          // semantics for locals (c1 relied on this implicitly; here it
          // also avoids spurious "read before definition" errors on lifted
          // dispatcher code where assigns live in a separate switch case
          // from the declaration).
          //
          // Pass the source-var name as a hint so the emitted Value's
          // name reflects the assigned-to variable (e.g. `x = 0` → `x_1`
          // instead of `__v_N`).
          let v;
          if (st.initializer) {
            v = emitExpr(st.initializer, st.variable.name);
          } else {
            const ty = st.variable.type;
            v = emitConst(ty, ty === 'i64' ? 0n : 0, st.loc, st.variable.name);
          }
          writeVariable(st.variable, current, v);
        } else if (st instanceof AST.Assign) {
          // Pass source-var name as hint — Value gets named x_N for x = ...
          const v = emitExpr(st.value, st.variable.name);
          writeVariable(st.variable, current, v);
        } else if (st instanceof AST.ParallelAssign) {
          // Parallel-copy semantics: evaluate every rvalue to a Value first
          // (all reads happen in source order), then bind each lvalue. Since
          // writeVariable only mutates currentDef (never affects expression
          // evaluation), the read-then-write phase ordering preserves the
          // parallel-assignment guarantee without temps.
          //
          // Each rvalue's outermost Value carries its target lvalue's
          // source-var name as a hint.
          const vs = st.rvalues.map((e, i) => emitExpr(e, st.lvalues[i].name));
          for (let i = 0; i < st.lvalues.length; i++) {
            writeVariable(st.lvalues[i], current, vs[i]);
          }
        } else if (st instanceof AST.ExpressionStatement) {
          // Result is discarded; the Call instruction is still emitted
          // (calls are impure). The dest Value just stays unused.
          emitExpr(st.expr);
        } else if (st instanceof AST.If) {
          const cond = emitExpr(st.cond);
          const thenB = cfgFn.createBlock('then');
          thenB.sealed = true;
          const elseB = st.elseBlock ? cfgFn.createBlock('else') : null;
          if (elseB) elseB.sealed = true;
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
          useOrDrop(joinB);
        } else if (st instanceof AST.While) {
          const headerB = cfgFn.createBlock('while_head');
          const bodyB = cfgFn.createBlock('while_body');
          const exitB = cfgFn.createBlock('while_exit');
          terminate(new CFG.Br(st.loc, headerB));
          // headerB stays unsealed until the back edge is in place.
          current = headerB;
          const cond = emitExpr(st.cond);
          terminate(new CFG.BrIf(st.loc, cond, bodyB, exitB));
          sealBlock(bodyB);                       // sole pred = headerB
          current = bodyB;
          breakStack.push(exitB);
          emitStmt(st.body);
          breakStack.pop();
          if (current) terminate(new CFG.Br(st.loc, headerB));
          sealBlock(headerB);                     // back edge now resolved
          useOrDrop(exitB);
        } else if (st instanceof AST.DoWhile) {
          // Body block doubles as loop entry; it has two preds (entry Br
          // from above + back edge from tail BrIf), so it stays unsealed
          // until body emission completes.
          const bodyB = cfgFn.createBlock('do_body');
          const exitB = cfgFn.createBlock('do_exit');
          terminate(new CFG.Br(st.loc, bodyB));
          current = bodyB;
          breakStack.push(exitB);
          emitStmt(st.body);
          breakStack.pop();
          if (current) {
            const cond = emitExpr(st.cond);
            terminate(new CFG.BrIf(st.loc, cond, bodyB, exitB));
          }
          sealBlock(bodyB);                       // back edge resolved (or body exited via return)
          useOrDrop(exitB);
        } else if (st instanceof AST.Switch) {
          // Block-bodied switch. Case markers in the body act like Labels —
          // each was pre-created as a BasicBlock in `caseBlocks`. The
          // dispatch is a BrIf chain comparing the switch value (evaluated
          // once into an SSA Value) against each non-default case marker's
          // literal, falling through to the default marker's block (or the
          // exit, if no default). Body emission walks the body as a normal
          // Block; Case markers reactivate `current` and add fallthrough
          // Brs, so cases are naturally connected.
          //
          // Case target blocks (and the default block) stay unsealed until
          // body emission completes, because their predecessor set isn't
          // known until then: dispatch BrIf + fallthrough Br from the prior
          // case region + any branches from nested control flow within the
          // body all contribute predecessors.
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
            } else if (n instanceof AST.DoWhile) {
              collect(n.body);
            }
            // Don't descend into nested AST.Switch — those case markers
            // belong to the inner switch's dispatch table.
          };
          collect(st.body);

          const exitB = cfgFn.createBlock('sw_exit');
          // Evaluate the switch value once into a Value; the dominators of
          // every dispatch / case block include the block this Value is
          // defined in, so direct reuse across the dispatch chain is safe.
          const scratchV = emitExpr(st.value);
          for (let i = 0; i < cases.length; i++) {
            const caseLit = emitConst('i32', cases[i].value, st.loc);
            const cond = emitBinop('==', scratchV, caseLit, 'i32', st.loc);
            const fallthrough = (i < cases.length - 1)
              ? cfgFn.createBlock(`sw_disp_${i + 1}`)
              : (defaultBlock ?? exitB);
            terminate(new CFG.BrIf(st.loc, cond, cases[i].block, fallthrough));
            // Intermediate dispatch blocks have exactly one predecessor
            // (the prior BrIf), so seal immediately. Case targets and the
            // default block get sealed after body emission below.
            if (i < cases.length - 1) sealBlock(fallthrough);
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
          // All predecessors of case / default blocks are now in place.
          for (const c of cases) sealBlock(c.block);
          if (defaultBlock) sealBlock(defaultBlock);
          useOrDrop(exitB);
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
      // Any unterminated blocks (orphans) become Unreachable. Any unsealed
      // blocks (mostly forward labels with no incoming goto) get sealed —
      // their incomplete phis just won't have operands, which is fine
      // since those blocks are dead and never executed.
      for (const b of cfgFn.blocks) if (!b.terminator) b.terminate(new CFG.Unreachable(null));
      for (const b of cfgFn.blocks) sealBlock(b);

      // Final cleanup: collapse redundant phis via Tarjan SCC over the
      // phi-dependence graph. Per Braun §3.3 — handles both single-phi
      // "trivial" collapses (size-1 SCC special case) and multi-phi
      // "almost trivial" cycles uniformly. Produces minimal SSA on ALL
      // CFGs, including irreducible loops from arbitrary goto patterns.
      trimPhis(cfgFn);

      return cfgFn;
    };

    // Pass 2: walk each body. CFG.Functions were created in pass 1.
    for (const fn of program.functions) lowerFunction(fn);
    return new CFG.Module([...cfgByAst.values()]);
  }

  function intoAST(module) {
    // Lift CFG.Module => AST.Program (while-switch dispatcher form), with
    // SSA destruction folded in along the way.
    //
    // Each Value in the function becomes an AST.Variable in the lifted
    // source. Function-param Values map directly back to the source
    // AST.Variables (so the function signature stays stable across
    // round-trips). All other Values become declared locals.
    //
    // SSA destruction: at each predecessor edge to a block B with N
    // params, we emit 2N copies — first into N per-block temps, then
    // from temps into the actual param Values. The temps protect against
    // parallel-copy cycles (e.g. back-edge swaps) without us having to
    // analyze them. Wasteful when the cycle hazard isn't present, but
    // simple and correct; an optimizer pass (c3) is the natural place
    // to clean this up.
    //
    // Two-pass: (1) mint a fresh AST.Function per CFG.Function so
    // cross-function references exist; (2) fill in each body.
    const zero = (t) => new AST.Literal(null, t, t === 'i64' ? 0n : 0);

    // Pass 1: pre-create AST.Functions keyed by their source CFG.Function.
    const astByCfg = new Map();
    for (const cfgFn of module.functions) {
      astByCfg.set(cfgFn,
        new AST.Function(null, cfgFn.returnType, cfgFn.name, cfgFn.params, null));
    }

    const buildBody = (cfgFn) => {
      // valueToAstVar: every Value in this function maps to one AST.Variable
      // in the lifted source. Function-param Values pre-map to the source
      // AST.Variables; everything else gets a fresh local.
      const valueToAstVar = new Map();
      const taken = new Set(cfgFn.params.map((p) => p.name));
      const newLocals = [];                       // accumulated as Values get mapped

      const reserveName = (hint) => {
        const base = hint || '__v';
        if (!taken.has(base)) { taken.add(base); return base; }
        let k = 1;
        let name;
        do { name = `${base}_${k++}`; } while (taken.has(name));
        taken.add(name);
        return name;
      };

      // Function-param Values → source AST.Variables (kept identical so
      // the lifted function signature matches the original).
      cfgFn.paramValues.forEach((v, i) => {
        valueToAstVar.set(v, cfgFn.params[i]);
      });

      const makeVar = (v) => {
        if (valueToAstVar.has(v)) return valueToAstVar.get(v);
        const name = reserveName(v.name);
        const av = new AST.Variable(null, v.type, name);
        valueToAstVar.set(v, av);
        newLocals.push(av);
        return av;
      };

      // Pre-walk: realize an AST.Variable for every Value that's a def
      // site (block param or instruction dest). Operand-only Values are
      // reachable through their defs.
      for (const block of cfgFn.blocks) {
        for (const p of block.params) makeVar(p);
        for (const ins of block.instructions) makeVar(ins.dest);
      }

      // __state state variable; pick a name that doesn't collide with
      // existing param or local names. Declared separately (with initializer).
      const stateName = reserveName('__state');
      const stateVar = new AST.Variable(null, 'i32', stateName);
      const setState = (loc, id) =>
        new AST.Assign(loc, stateVar, new AST.Literal(null, 'i32', id));

      // Parallel-copy expansion at an outgoing edge to `block` with `args`.
      // One AST.ParallelAssign per multi-param edge — the parallel-copy
      // semantics handle swap hazards intrinsically (all rvalues evaluated
      // before any lvalue binding), so no temp routing or hazard analysis
      // is needed here. Codegen lowers ParallelAssign via the wasm value
      // stack (push all rhs, then set lvalues in reverse), which is also
      // hazard-free.
      const destructEdge = (block, args, loc) => {
        if (block.params.length === 0) return [];
        const lvalues = block.params.map(makeVar);
        const rvalues = args.map(makeVar);
        return [new AST.ParallelAssign(loc, lvalues, rvalues)];
      };

      // Turn a CFG instruction into a single AST.Assign(destVar, <expr>).
      const liftInstruction = (ins) => {
        const destVar = makeVar(ins.dest);
        let rhs;
        if (ins instanceof CFG.Const) {
          rhs = new AST.Literal(ins.loc, destVar.type, ins.value);
        } else if (ins instanceof CFG.BinaryOp) {
          rhs = new AST.Binary(ins.loc, ins.op, makeVar(ins.lhs), makeVar(ins.rhs));
        } else if (ins instanceof CFG.UnaryOp) {
          rhs = new AST.Unary(ins.loc, ins.op, makeVar(ins.operand));
        } else if (ins instanceof CFG.Call) {
          const calleeFn = astByCfg.get(ins.callee);
          if (!calleeFn) throw new Error(`liftInstruction: unknown callee '${ins.callee.name}'`);
          rhs = new AST.Call(ins.loc, calleeFn, ins.args.map((a) => makeVar(a)));
        } else throw new Error('liftInstruction: ' + ins.constructor.name);
        return new AST.Assign(ins.loc, destVar, rhs);
      };

      const liftBlock = (block) => {
        const stmts = block.instructions.map(liftInstruction);
        const term = block.terminator;
        if (term instanceof CFG.Br) {
          stmts.push(...destructEdge(term.target, term.args, term.loc));
          stmts.push(setState(term.loc, term.target.id));
          stmts.push(new AST.Break(term.loc));
        } else if (term instanceof CFG.BrIf) {
          const trueStmts = [
            ...destructEdge(term.trueTarget, term.trueArgs, term.loc),
            setState(term.loc, term.trueTarget.id),
          ];
          const falseStmts = [
            ...destructEdge(term.falseTarget, term.falseArgs, term.loc),
            setState(term.loc, term.falseTarget.id),
          ];
          stmts.push(new AST.If(term.loc, makeVar(term.cond),
            new AST.Block(null, trueStmts),
            new AST.Block(null, falseStmts),
          ));
          stmts.push(new AST.Break(term.loc));
        } else if (term instanceof CFG.Return) {
          stmts.push(new AST.Return(term.loc, makeVar(term.value)));
        } else if (term instanceof CFG.Unreachable) {
          // Dead block — emit a default return so the case body is well-typed.
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
      const decls = newLocals.map((v) => new AST.Declare(null, v, null));
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
    Value,
    Instruction, Const, BinaryOp, UnaryOp, Call,
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
        } else if (node instanceof AST.DoWhile) {
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
        } else if (st instanceof AST.ParallelAssign) {
          // Push every rvalue onto the wasm value stack (reads happen
          // before any writes), then pop into lvalues in REVERSE order so
          // the LIFO stack delivers them correctly.
          for (const e of st.rvalues) emitExpr(e);
          for (let i = st.lvalues.length - 1; i >= 0; i--) {
            out.push(0x21, ...u(locals.get(st.lvalues[i].name)));   // local.set
          }
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
        } else if (st instanceof AST.DoWhile) {
          const exit = sym('dw_exit'), cont = sym('dw_cont');
          out.push(0x02, 0x40); push(exit, true);   // outer block (break target)
          out.push(0x03, 0x40); push(cont);          // loop (continue target = body start)
          emitStmt(st.body);
          emitExpr(st.cond);
          out.push(0x0D, ...u(depth(cont)));         // br_if cont (loop while true)
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
            if (n instanceof AST.DoWhile) return hasNestedCase(n.body);
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
          throw new Error('CODEGEN.emit: Label/Goto unsupported — lift to structured form first');
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
