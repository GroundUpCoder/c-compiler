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
    const CMP = new Set(['==', '!=', '<', '<=', '>', '>=']);

    const of = (e) => {
      if (e instanceof AST.Literal) return e.type;
      if (e instanceof AST.Variable) return e.type;
      if (e instanceof AST.Binary) return CMP.has(e.op) ? 'i32' : of(e.left);
      if (e instanceof AST.Unary) return e.op === '!' ? 'i32' : of(e.operand);
      throw new Error('AST.TYPE.of: ' + e.constructor.name);
    };

    return { of };
  })();

  // ─────────────────────── AST pretty-printer ─────────────────────────
  //
  // Renders an AST.Program back to c0 source text. Used by the Lifted tab
  // to display CFG.intoAST's output as readable source (which the user can
  // paste back into the editor for re-compilation).
  function printSource(program) {
    const PREC = {
      '||': 1, '&&': 2,
      '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
      '+': 5, '-': 5, '*': 6, '/': 6, '%': 6,
    };

    const printExpr = (e, parentPrec = 0) => {
      if (e instanceof AST.Literal) {
        if (e.type === 'i64') return e.value.toString() + 'L';
        if (e.type === 'f32') return Number(e.value).toString() + 'f';
        if (e.type === 'f64') {
          const s = Number(e.value).toString();
          return s.includes('.') || s.includes('e') ? s : s + '.0';
        }
        return e.value.toString();
      }
      if (e instanceof AST.Variable) return e.name;
      if (e instanceof AST.Unary) {
        const inner = printExpr(e.operand, 7);
        return `${e.op}${inner}`;
      }
      if (e instanceof AST.Binary) {
        const p = PREC[e.op] ?? 0;
        const s = `${printExpr(e.left, p)} ${e.op} ${printExpr(e.right, p + 1)}`;
        return p < parentPrec ? `(${s})` : s;
      }
      throw new Error('printExpr: ' + e?.constructor?.name);
    };

    const lines = [];
    const printStmt = (st, ind) => {
      const pad = '  '.repeat(ind);
      if (st instanceof AST.Block) {
        st.statements.forEach((s) => printStmt(s, ind));
      } else if (st instanceof AST.Declare) {
        lines.push(`${pad}${st.variable.type} ${st.variable.name}${st.initializer ? ' = ' + printExpr(st.initializer) : ''};`);
      } else if (st instanceof AST.Assign) {
        lines.push(`${pad}${st.variable.name} = ${printExpr(st.value)};`);
      } else if (st instanceof AST.If) {
        lines.push(`${pad}if (${printExpr(st.cond)}) {`);
        printStmt(st.thenBlock, ind + 1);
        if (st.elseBlock) {
          lines.push(`${pad}} else {`);
          printStmt(st.elseBlock, ind + 1);
        }
        lines.push(`${pad}}`);
      } else if (st instanceof AST.While) {
        lines.push(`${pad}while (${printExpr(st.cond)}) {`);
        printStmt(st.body, ind + 1);
        lines.push(`${pad}}`);
      } else if (st instanceof AST.DoWhile) {
        lines.push(`${pad}do {`);
        printStmt(st.body, ind + 1);
        lines.push(`${pad}} while (${printExpr(st.cond)});`);
      } else if (st instanceof AST.Switch) {
        lines.push(`${pad}switch (${printExpr(st.value)}) {`);
        printStmt(st.body, ind + 1);
        lines.push(`${pad}}`);
      } else if (st instanceof AST.Case) {
        const tag = st.value === null ? 'default' : `case ${st.value}`;
        lines.push(`${pad}${tag}:`);
      } else if (st instanceof AST.Break) {
        lines.push(`${pad}break;`);
      } else if (st instanceof AST.Return) {
        lines.push(`${pad}return ${printExpr(st.value)};`);
      } else if (st instanceof AST.Label) {
        lines.push(`${pad}${st.name}:`);
      } else if (st instanceof AST.Goto) {
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
  }

  return {
    Program, Function, Block,
    Literal, Variable,
    Declare, Assign,
    Binary, Unary,
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
    ]);
    // Source-level type aliases: `int x;` lexes identically to `i32 x;`.
    // The alias is folded away at tokenize time, so the AST/CFG/codegen
    // only ever see the canonical wasm names.
    const TYPE_ALIAS = { int: 'i32', long: 'i64', float: 'f32', double: 'f64' };
    const PUNCT2 = ['==', '!=', '<=', '>='];
    const PUNCT1 = '{}()[];,:+-*/%!=<>';
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
      // Assign: ID = expr ;
      if (peek()?.type === 'ID' && peek(1)?.type === '=') {
        const id = advance(); advance();
        const value = parseExpression();
        expect(';');
        const v = scope[id.value];
        if (!v) throw new Error(`Undefined variable ${id.value} at line ${id.line}:${id.col}`);
        return new AST.Assign(loc(id), v, value);
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

    function parseExpression() {
      return parseComparison();
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

    // <type> ID ( [<type> ID, ...] ) <block>
    function parseFunction() {
      const start = peek();
      const retType = parseType();
      const nameTok = expect('ID');
      expect('(');
      const params = [];
      if (!at(')')) {
        do {
          const pType = parseType();
          const pName = expect('ID');
          params.push(new AST.Variable(loc(pName), pType, pName.value));
        } while (eat(','));
      }
      expect(')');
      // Fresh per-function scope, seeded with parameters.
      scope = Object.create(null);
      for (const p of params) scope[p.name] = p;
      const body = parseBlock();
      return new AST.Function(loc(start), retType, nameTok.value, params, body);
    }

    const functions = [];
    while (i < tokens.length) functions.push(parseFunction());
    return new AST.Program(loc(tokens[0]), functions);
  }
  return { parse, tokenize };
})();

const CFG = (() => {

  // ────── Statement-CFG ──────
  //
  // Each BasicBlock holds a straight-line list of AST.Assign statements
  // (mutations to declared locals); branching lives in the terminator.
  // Expressions stay as AST trees — no stack-machine ops, no SSA, no
  // value-naming. Function locals are tracked at the Function level
  // (Declare nodes from the source contribute their AST.Variable here
  // and their initializer becomes an Assign at the point of declaration).

  // ────── Terminators ──────
  //
  // BrIf and Return carry full AST.Expression trees as cond / value.

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
      this.cond = cond;                  // AST.Expression
      this.trueTarget = trueTarget;
      this.falseTarget = falseTarget;
    }
    get successors() { return [this.trueTarget, this.falseTarget]; }
  }

  class Return extends Terminator {
    constructor(loc, value) {
      super(loc);
      this.value = value;                // AST.Expression
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
      this.statements = [];              // AST.Assign[] — straight-line only
      this.terminator = null;
    }
    append(stmt) {
      if (this.terminator) throw new Error(`Block '${this.name}' already terminated`);
      this.statements.push(stmt);
      return stmt;
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
      this.locals = [];                  // AST.Variable[] — declared non-param locals, in order
      this.entry = new BasicBlock('entry');
      this.entry.id = 0;
      this.blocks = [this.entry];
    }
    addLocal(v) { this.locals.push(v); return v; }
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
    // Lower AST.Program => CFG.Module.
    //
    // Walks each function with a "current block" cursor. Straight-line code
    // (Assign + Declare-with-initializer) pushes AST.Assign nodes into
    // block.statements as-is; control flow constructs (If/While/Switch/
    // Break/Return/Goto) open fresh blocks and connect them with
    // terminators. Labels are pre-allocated in a scan so forward gotos
    // resolve. After an unconditional terminator the cursor is null and
    // subsequent statements are dropped until a label restores reachability.

    const lowerFunction = (astFn) => {
      const cfgFn = new CFG.Function(astFn.name, astFn.parameters, astFn.returnType, astFn.name);

      // Pre-scan: register declared locals (in source order), and pre-create
      // one BasicBlock per label name (forward gotos need a resolvable
      // target). Switch detection is implicit — the scratch local is
      // allocated lazily on first use.
      const labelBlocks = new Map();
      const caseBlocks = new Map();           // AST.Case node → BasicBlock
      const namesSeen = new Set(cfgFn.params.map((p) => p.name));
      const scan = (n) => {
        if (!n) return;
        if (n instanceof AST.Declare) {
          if (namesSeen.has(n.variable.name)) throw new Error('duplicate local: ' + n.variable.name);
          namesSeen.add(n.variable.name);
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
        } else if (n instanceof AST.DoWhile) {
          scan(n.body);
        }
      };
      scan(astFn.body);

      // Lazy switch scratch: pick a fresh name so repeated round-trips don't
      // accumulate collisions like __sw_scratch / __sw_scratch_1 / ...
      let swScratch = null;
      const ensureSwitchScratch = () => {
        if (swScratch) return swScratch;
        let nm = '__sw_scratch';
        for (let k = 1; namesSeen.has(nm); k++) nm = `__sw_scratch_${k}`;
        namesSeen.add(nm);
        swScratch = new AST.Variable(null, 'i32', nm);
        cfgFn.addLocal(swScratch);
        return swScratch;
      };

      // Cursor for the in-progress block. `null` means we're at an
      // unreachable position (after Return / Br) and most statements are
      // dropped.
      let current = cfgFn.entry;
      const breakStack = [];                 // exit BasicBlock of innermost loop/switch
      const append = (s) => { if (current) current.append(s); };
      const terminate = (t) => { if (current) { current.terminate(t); current = null; } };

      const emitStmt = (st) => {
        // Labels, Case markers, and Blocks are handled even when `current`
        // is null: labels/cases are reachable jump targets that can
        // resurrect a dead position, and Blocks must recurse to surface
        // any such markers nested inside an otherwise-dead arm (e.g. a
        // switch body whose dispatch fell through to a case marker).
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
        if (!current) return;                // dead-code position
        if (st instanceof AST.Declare) {
          // The local itself was registered in scan(); here we just emit the
          // initializer (if any) as an Assign at the declaration point.
          if (st.initializer) {
            append(new AST.Assign(st.loc, st.variable, st.initializer));
          }
        } else if (st instanceof AST.Assign) {
          append(st);
        } else if (st instanceof AST.If) {
          const thenB = cfgFn.createBlock('then');
          const elseB = st.elseBlock ? cfgFn.createBlock('else') : null;
          const joinB = cfgFn.createBlock('endif');
          terminate(new CFG.BrIf(st.loc, st.cond, thenB, elseB ?? joinB));
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
          terminate(new CFG.BrIf(st.loc, st.cond, bodyB, exitB));
          current = bodyB;
          breakStack.push(exitB);
          emitStmt(st.body);
          breakStack.pop();
          if (current) terminate(new CFG.Br(st.loc, headerB));
          current = exitB;
        } else if (st instanceof AST.DoWhile) {
          // Body runs first, then the condition; on true we loop back to
          // body, on false we fall to exit. No separate header block —
          // the body block itself is the loop entry.
          const bodyB = cfgFn.createBlock('do_body');
          const exitB = cfgFn.createBlock('do_exit');
          terminate(new CFG.Br(st.loc, bodyB));
          current = bodyB;
          breakStack.push(exitB);
          emitStmt(st.body);
          breakStack.pop();
          if (current) terminate(new CFG.BrIf(st.loc, st.cond, bodyB, exitB));
          current = exitB;
        } else if (st instanceof AST.Switch) {
          // Stash the value into a scratch local (avoids re-evaluation, and
          // stays correct if the value has side effects), then a BrIf chain
          // compares the scratch against each non-default case marker's
          // literal and falls through to a Br targeting the default marker
          // (or the exit, if no default).
          //
          // Case markers themselves are handled by AST.Case below — they
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
            } else if (n instanceof AST.DoWhile) {
              collect(n.body);
            }
            // Don't descend into nested AST.Switch — those case markers
            // belong to the inner switch's dispatch table.
          };
          collect(st.body);

          const exitB = cfgFn.createBlock('sw_exit');
          const scratch = ensureSwitchScratch();
          append(new AST.Assign(st.loc, scratch, st.value));
          for (let i = 0; i < cases.length; i++) {
            const caseLit = new AST.Literal(st.loc, 'i32', cases[i].value);
            const cond = new AST.Binary(st.loc, '==', scratch, caseLit);
            const fallthrough = (i < cases.length - 1)
              ? cfgFn.createBlock(`sw_disp_${i + 1}`)
              : (defaultBlock ?? exitB);
            terminate(new CFG.BrIf(st.loc, cond, cases[i].block, fallthrough));
            current = fallthrough;
          }
          if (cases.length === 0) {
            // No non-default cases — go straight to default (or exit).
            terminate(new CFG.Br(st.loc, defaultBlock ?? exitB));
          }
          // Body is emitted with `current = null` (statements before the
          // first Case marker are unreachable, per C semantics). Case
          // markers reactivate `current` via AST.Case's handler below.
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
          terminate(new CFG.Return(st.loc, st.value));
        } else if (st instanceof AST.Goto) {
          const target = labelBlocks.get(st.target);
          if (!target) throw new Error('undefined label: ' + st.target);
          terminate(new CFG.Br(st.loc, target));
        } else throw new Error('emitStmt: ' + st.constructor.name);
      };

      emitStmt(astFn.body);
      // A function that falls off the end is ill-formed; mark Unreachable so
      // the CFG invariant (every block terminated) holds.
      if (current) terminate(new CFG.Unreachable(null));
      for (const b of cfgFn.blocks) if (!b.terminator) b.terminate(new CFG.Unreachable(null));

      return cfgFn;
    };

    const functions = [];
    for (const fn of program.functions) functions.push(lowerFunction(fn));
    return new CFG.Module(functions);
  }

  function intoAST(module) {
    // Lift CFG.Module => AST.Program (while-switch dispatcher form).
    //
    // Each function becomes:
    //   <decls for non-param locals>
    //   i32 __state = <entry block id>;
    //   while (1) {
    //     switch (__state) {
    //       case <block id>: <block.statements>; <terminator-to-stmts>;
    //       ...
    //     }
    //   }
    //
    // Since blocks already hold AST.Assigns and terminators already carry
    // AST expressions, this is a near-mechanical re-layout — no un-stackifying.
    const zero = (t) => new AST.Literal(null, t, t === 'i64' ? 0n : 0);

    const liftFunction = (cfgFn) => {
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
        const stmts = [...block.statements];      // already AST.Assigns
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
          // Dead block; emit a default return so the case body is well-typed.
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
      const body = new AST.Block(null, [...decls, stateDecl, dispatcher]);

      return new AST.Function(null, cfgFn.returnType, cfgFn.name, cfgFn.params, body);
    };

    return new AST.Program(null, module.functions.map(liftFunction));
  }

  return {
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
      const indexOf = new Map();
      for (const r of layout.params) indexOf.set(r.name, r.idx);
      for (const r of layout.locals) indexOf.set(r.name, r.idx);
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
          const idx = indexOf.get(e.name);
          if (idx === undefined) throw new Error('undefined: ' + e.name);
          out.push(0x20, ...u(idx));
        } else if (e instanceof AST.Binary) {
          emitExpr(e.left); emitExpr(e.right);
          const t = AST.TYPE.of(e.left);
          const op = BIN[e.op]?.[t];
          if (op === undefined) throw new Error(`no opcode for ${t} ${e.op}`);
          out.push(op);
        } else if (e instanceof AST.Unary) {
          const t = AST.TYPE.of(e.operand);
          if (e.op === '-') {
            if (t === 'f32' || t === 'f64') { emitExpr(e.operand); out.push(FNEG[t]); }
            else { out.push(t === 'i64' ? 0x42 : 0x41, 0); emitExpr(e.operand); out.push(BIN['-'][t]); }
          } else if (e.op === '!') {
            emitExpr(e.operand); out.push(0x45);   // i32.eqz
          } else throw new Error('unary: ' + e.op);
        } else throw new Error('emitExpr: ' + e.constructor.name);
      };

      const emitStmt = (st) => {
        if (st instanceof AST.Block) {
          st.statements.forEach(emitStmt);
        } else if (st instanceof AST.Declare) {
          if (st.initializer) { emitExpr(st.initializer); out.push(0x21, ...u(indexOf.get(st.variable.name))); }
        } else if (st instanceof AST.Assign) {
          emitExpr(st.value); out.push(0x21, ...u(indexOf.get(st.variable.name)));
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
          out.push(0x0D, ...u(depth(cont)));         // br_if cont  (loop while true)
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
          // Reject case markers buried in nested control flow (Duff's-style).
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

          // Layout (innermost to outermost): block $end ─ block $regionN-1 ─ … ─ block $region0
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
          throw new Error('emit: Label/Goto unsupported — lift to structured form first');
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
  // compileWithTrace gathers everything the visualizer needs in one pass:
  // tokens, AST, statement-style CFG, lifted AST, wasm bytes, plus the
  // per-function wasm-local layout (which emit computes as a side-effect
  // and exposes on its return).
  function compileWithTrace(source, filename = '<input>') {
    const tokens = PARSER.tokenize(source);
    const ast = PARSER.parse(source);
    // CFG / lift only succeed when the source is structurally well-formed
    // for emit too. Both are best-effort: if one throws (e.g. lifted
    // emit fails on a label-only path), the visualizer still gets tokens
    // and ast.
    let mod = null, modError = null;
    try { mod = CFG.fromAST(ast); } catch (e) { modError = e; }
    let lifted = null, liftedError = null;
    if (mod) {
      try { lifted = CFG.intoAST(mod); } catch (e) { liftedError = e; }
    }
    // Direct emit (no CFG). c0's emit rejects label/goto sources, so if
    // the source uses goto we fall back to the lifted form.
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
