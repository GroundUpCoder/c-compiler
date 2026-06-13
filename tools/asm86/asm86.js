#!/usr/bin/env node
// asm86.js — single-file x86 assembler, NASM-compatible, flat binary output.
//
// Golden-tested against NASM 2.16.03 byte-for-byte.
// Usage: node asm86.js -f bin input.asm -o output.bin

'use strict';

// ═══════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════

function parseCli(argv) {
  const args = { input: null, output: null, format: 'bin' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--format') args.format = argv[++i];
    else if (a === '-o' || a === '--output') args.output = argv[++i];
    else if (!a.startsWith('-')) args.input = a;
  }
  if (!args.input) {
    console.error('Usage: node asm86.js -f bin <input.asm> -o <output.bin>');
    process.exit(1);
  }
  return args;
}

// ═══════════════════════════════════════════════════════════════════════
// TOKENIZER
// ═══════════════════════════════════════════════════════════════════════

const TOKEN = {
  ID: 'ID',         // identifier, mnemonic, register name, label
  NUM: 'NUM',       // integer literal (decimal, hex, binary, octal)
  STR: 'STR',       // string literal
  PUNCT: 'PUNCT',   // punctuation: , : [ ] ( ) + - * / etc.
  EOL: 'EOL',       // end of line (semicolon or newline)
  EOF: 'EOF',       // end of file
};

function tokenize(src, filename) {
  const tokens = [];
  let i = 0;
  let line = 1, col = 1;

  function tok(type, value, startLine, startCol, text) {
    return { type, value, line: startLine, col: startCol, filename, text };
  }

  function peek(n) { n = n ?? 1; return i + n < src.length ? src[i + n] : ''; }

  while (i < src.length) {
    const c = src[i];
    const startLine = line, startCol = col;

    // Whitespace
    if (c === ' ' || c === '\t') { i++; col++; continue; }

    // Newlines
    if (c === '\n') {
      tokens.push(tok(TOKEN.EOL, '\n', startLine, startCol));
      i++; line++; col = 1;
      continue;
    }
    if (c === '\r') { i++; col = 1; continue; } // normalize CRLF

    // Comments: ; to end of line
    if (c === ';') {
      while (i < src.length && src[i] !== '\n') i++;
      tokens.push(tok(TOKEN.EOL, ';', startLine, startCol));
      continue;
    }

    // Backtick-quoted identifiers (NASM: `foo` treats contents as identifier chars)
    if (c === '`') {
      i++; col++;
      let val = '';
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\n') { line++; col = 1; }
        val += src[i]; i++; col++;
      }
      i++; col++; // skip closing backtick
      tokens.push(tok(TOKEN.ID, val, startLine, startCol));
      continue;
    }

    // String literals: '...' or "..."
    if (c === "'" || c === '"') {
      const quote = c;
      i++; col++;
      let val = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          i++; col++;
          const esc = src[i];
          if (esc === 'n') val += '\n';
          else if (esc === 't') val += '\t';
          else if (esc === 'r') val += '\r';
          else if (esc === '\\') val += '\\';
          else if (esc === quote) val += quote;
          else if (esc === '0') val += '\0';
          else if (esc === 'x' || esc === 'X') {
            // \xNN hex escape
            i++; let hex = '';
            while (i < src.length && /[0-9a-fA-F]/.test(src[i])) { hex += src[i]; i++; }
            val += String.fromCharCode(parseInt(hex, 16));
            col += 2 + hex.length;
            continue;
          } else if (esc >= '0' && esc <= '9') {
            // \NNN octal escape (up to 3 digits)
            let oct = esc;
            i++;
            for (let k = 0; k < 2 && i < src.length && src[i] >= '0' && src[i] <= '7'; k++, i++)
              oct += src[i];
            val += String.fromCharCode(parseInt(oct, 8));
            col += oct.length;
            continue;
          }
          i++; col++;
          continue;
        }
        val += src[i]; i++; col++;
      }
      i++; col++; // skip closing quote
      tokens.push(tok(TOKEN.STR, val, startLine, startCol));
      continue;
    }

    // Numbers: 0x..., 0d..., 0b..., 0o..., $... (hex), or plain decimal
    // NASM: $ means "here" in expressions but can also prefix hex numbers.
    // We handle $ as a separate token; $FF is a hex number.
    // Also: numbers can end with h (hex), b (binary), o/q (octal), d (decimal) — NASM suffix style.

    // $ followed by hex digits → hex number
    if (c === '$' && /[0-9a-fA-F]/.test(peek())) {
      i++; col++;
      let hex = '';
      while (i < src.length && /[0-9a-fA-F_]/.test(src[i])) {
        if (src[i] !== '_') hex += src[i];
        i++; col++;
      }
      tokens.push(tok(TOKEN.NUM, parseInt(hex, 16), startLine, startCol, '$' + hex));
      continue;
    }

    // 0x / 0X prefix
    if (c === '0' && (peek() === 'x' || peek() === 'X')) {
      i += 2; col += 2;
      let hex = '';
      while (i < src.length && /[0-9a-fA-F_]/.test(src[i])) {
        if (src[i] !== '_') hex += src[i];
        i++; col++;
      }
      tokens.push(tok(TOKEN.NUM, parseInt(hex, 16), startLine, startCol, '0x' + hex));
      continue;
    }

    // 0b / 0B prefix
    if (c === '0' && (peek() === 'b' || peek() === 'B')) {
      i += 2; col += 2;
      let bin = '';
      while (i < src.length && /[01_]/.test(src[i])) {
        if (src[i] !== '_') bin += src[i];
        i++; col++;
      }
      const num = parseInt(bin, 2);
      tokens.push(tok(TOKEN.NUM, num, startLine, startCol, '0b' + bin));
      continue;
    }

    // 0o / 0O prefix
    if (c === '0' && (peek() === 'o' || peek() === 'O')) {
      i += 2; col += 2;
      let oct = '';
      while (i < src.length && /[0-7_]/.test(src[i])) {
        if (src[i] !== '_') oct += src[i];
        i++; col++;
      }
      tokens.push(tok(TOKEN.NUM, parseInt(oct, 8), startLine, startCol, '0o' + oct));
      continue;
    }

    // Decimal number (plain digit) — also handles h/b/o/d NASM suffixes
    if (c >= '0' && c <= '9') {
      let num = '';
      while (i < src.length && /[0-9a-fA-F_]/.test(src[i])) {
        if (src[i] !== '_') num += src[i];
        i++; col++;
      }
      if (/^[0-9]/.test(num)) {
        let val, text;
        if (/^[0-9][0-9a-fA-F]*[hH]$/.test(num) && /[a-fA-F]/.test(num)) {
          val = parseInt(num.slice(0, -1), 16);
          text = '0x' + num.slice(0, -1);
        } else if (/[bB]$/.test(num) && /^[01]+[bB]$/.test(num)) {
          val = parseInt(num.slice(0, -1), 2);
          text = num;
        } else if (/[oOqQ]$/.test(num)) {
          val = parseInt(num.slice(0, -1), 8);
          text = num;
        } else if (/[dD]$/.test(num) && /^[0-9]+[dD]$/.test(num)) {
          val = parseInt(num.slice(0, -1), 10);
          text = num;
        } else {
          val = parseInt(num, 10);
          text = num;
        }
        tokens.push(tok(TOKEN.NUM, val, startLine, startCol, text));
        continue;
      }
    }

    // Identifiers and keywords
    if (/[a-zA-Z_.?@]/.test(c)) {
      let id = '';
      // NASM: identifiers are [a-zA-Z_.?@][a-zA-Z0-9_$#~.?@]*
      // But $ is also the "here" token — handled below
      while (i < src.length && /[a-zA-Z0-9_$#~.?@]/.test(src[i])) {
        id += src[i]; i++; col++;
      }
      tokens.push(tok(TOKEN.ID, id, startLine, startCol));
      continue;
    }

    // $$ (start of section address) — MUST come before $ single check
    if (c === '$' && peek() === '$') {
      tokens.push(tok(TOKEN.ID, '$$', startLine, startCol));
      i += 2; col += 2;
      continue;
    }

    // $ (current address)
    if (c === '$') {
      tokens.push(tok(TOKEN.ID, '$', startLine, startCol));
      i++; col++;
      continue;
    }

    // Hex suffix numbers that start with a digit: 0FFh, 1234h
    // Already handled in the digit branch above, but if we're here
    // the current char isn't a digit. Continue.

    // Punct: multi-char operators first
    if (c === '<' && peek() === '<') {
      tokens.push(tok(TOKEN.ID, '<<', startLine, startCol));
      i += 2; col += 2; continue;
    }
    if (c === '>' && peek() === '>') {
      tokens.push(tok(TOKEN.ID, '>>', startLine, startCol));
      i += 2; col += 2; continue;
    }
    if (c === '/' && peek() === '/') {
      tokens.push(tok(TOKEN.ID, '//', startLine, startCol));
      i += 2; col += 2; continue;
    }
    if (c === '&' && peek() === '&') {
      tokens.push(tok(TOKEN.ID, '&&', startLine, startCol));
      i += 2; col += 2; continue;
    }
    if (c === '|' && peek() === '|') {
      tokens.push(tok(TOKEN.ID, '||', startLine, startCol));
      i += 2; col += 2; continue;
    }
    if (c === '^' && peek() === '^') {
      tokens.push(tok(TOKEN.ID, '^^', startLine, startCol));
      i += 2; col += 2; continue;
    }
    // NOSPLIT: << >> as shift operators. Handled above.
    if ((c === 'S' || c === 's') && src.slice(i, i + 3).toUpperCase() === 'SEG') {
      // SEG operator
      tokens.push(tok(TOKEN.ID, 'SEG', startLine, startCol));
      i += 3; col += 3;
      continue;
    }

    // Single-char punct
    const punctChars = ',:[]()+-*/|&^~!=%';
    if (punctChars.includes(c)) {
      tokens.push(tok(TOKEN.PUNCT, c, startLine, startCol));
      i++; col++;
      continue;
    }

    // Unknown char — skip with warning
    console.error(`${filename}:${line}:${col}: warning: ignoring unknown character '${c}' (${c.charCodeAt(0)})`);
    i++; col++;
  }

  tokens.push(tok(TOKEN.EOF, '', line, col));
  return tokens;
}

// ═══════════════════════════════════════════════════════════════════════
// PREPROCESSOR (stub — expands to full NASM compatibility)
// ═══════════════════════════════════════════════════════════════════════

// For now, the preprocessor is a passthrough. It will grow to handle:
//   %define, %macro, %if/%else/%endif, %rep, %include, %error, %warning
// The token stream passes through unmodified.
//
// Preprocessor directives start with % at beginning of line (or after whitespace).
// They are intercepted during parsing, not here — this keeps the tokenizer simple.

// ═══════════════════════════════════════════════════════════════════════
// EXPRESSION PARSER
// ═══════════════════════════════════════════════════════════════════════

// Expressions appear in immediates, displacements, TIMES counts, EQU values, etc.
// NASM expression grammar (subset for v1):
//
//   expr      := term ( '|' term )*
//   term      := factor ( '^' factor )*
//   factor    := unary ( '&' unary )*
//   unary     := ( '+' | '-' | '~' | 'SEG' ) unary | shift
//   shift     := primary ( ( '<<' | '>>' | 'SHL' | 'SHR' ) primary )*
//   primary   := NUM | ID | STR | '$' | '$$' | '(' expr ')'
//
// ID evaluates to: 0 if undefined label (forward ref, resolved later),
// or the label value if known. $ = current address. $$ = section start.
//
// Operators use NASM's precedence (tightest to loosest):
//   1. unary +, -, ~, SEG
//   2. *, /, // (unsigned div), % (unsigned mod), %% (signed mod)
//   3. +, - (binary)
//   4. <<, >>
//   5. &
//   6. ^
//   7. |

const EXPR_PREC = {
  '|': 1,
  '^': 2,
  '&': 3,
  '<<': 4, '>>': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '//': 6, '%': 6, '%%': 6,
};

const UNARY_OPS = new Set(['+', '-', '~', 'SEG']);
const BINARY_OPS = new Set(['|', '^', '&', '<<', '>>', '+', '-', '*', '/', '//', '%', '%%']);

// Wrapping parseInt for 32-bit unsigned — all assembly values are 32-bit in flat binary.
// Actually NASM uses 64-bit internally for expression evaluation,
// but for flat binary output the final value is truncated to 32-bit.
// Convert to unsigned 32-bit. USE SPARINGLY — only at byte emission sites where
// unsigned interpretation is explicitly needed. DO NOT use for range checks,
// comparisons, or value storage. Those must use raw Numbers (which preserve sign).
//
// In practice, JS bitwise ops (&, >>>, <<) already coerce to 32-bit, so to32()
// is rarely necessary. It exists as an explicit marker for "unsigned interpretation."
//
// For signed 32-bit clamping, use `v | 0` or `v >> 0`.
function to32(n) { return n >>> 0; }

// Parse an expression from a token array, starting at index `start`.
// Returns { value: number, next: index }.
// `ctx` provides: $ (current offset), $$ (section start), labels map (name → value).
function parseExpr(tokens, start, ctx) {
  return parseBinary(tokens, start, ctx, 1);
}

function parseBinary(tokens, i, ctx, minPrec) {
  let left = parseUnary(tokens, i, ctx);
  i = left.next;

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === TOKEN.EOF || t.type === TOKEN.EOL) break;
    if (t.type === TOKEN.PUNCT && t.value === ')') break;
    if (t.type === TOKEN.PUNCT && t.value === ',') break;
    if (t.type === TOKEN.PUNCT && t.value === ']') break;

    // Check if this token is a binary operator
    let op = null;
    if (t.type === TOKEN.PUNCT && BINARY_OPS.has(t.value)) {
      op = t.value;
    } else if (t.type === TOKEN.ID && (t.value === 'SHL' || t.value === 'SHR')) {
      op = t.value === 'SHL' ? '<<' : '>>';
    } else if (t.type === TOKEN.ID && (t.value === 'AND' || t.value === 'and')) {
      op = '&';
    } else if (t.type === TOKEN.ID && (t.value === 'OR' || t.value === 'or')) {
      op = '|';
    } else if (t.type === TOKEN.ID && (t.value === 'XOR' || t.value === 'xor')) {
      op = '^';
    } else if (t.type === TOKEN.ID && (t.value === 'MOD' || t.value === 'mod')) {
      op = '%';
    }
    // Also: +, -, *, / are PUNCT and caught above

    if (!op) break;
    const prec = EXPR_PREC[op] || 0;
    if (prec < minPrec) break;

    i++;
    let right = parseBinary(tokens, i, ctx, prec + 1);
    i = right.next;

    switch (op) {
      // Bitwise ops: JS already produces 32-bit signed ints. The result is the
      // raw two's-complement value — no to32() conversion needed.
      case '|': left.value = left.value | right.value; break;
      case '^': left.value = left.value ^ right.value; break;
      case '&': left.value = left.value & right.value; break;
      case '<<': left.value = left.value << right.value; break;
      case '>>': left.value = left.value >> right.value; break;
      // Arithmetic ops: JS produces floating-point. Clamp to signed 32-bit
      // (v | 0) so the value stays interpretable as both signed and unsigned.
      case '+': left.value = (left.value + right.value) | 0; break;
      case '-': left.value = (left.value - right.value) | 0; break;
      case '*': left.value = (left.value * right.value) | 0; break;
      case '/': left.value = Math.floor(right.value ? left.value / right.value : 0) | 0; break;
      case '//': left.value = Math.floor(right.value ? left.value / right.value : 0) | 0; break;
      case '%': left.value = (right.value ? left.value % right.value : 0) | 0; break;
      case '%%': left.value = (right.value ? ((left.value % right.value) + right.value) % right.value : 0) | 0; break;
    }
  }

  return { value: left.value, next: i };
}

function parseUnary(tokens, i, ctx) {
  const t = tokens[i];
  if ((t.type === TOKEN.PUNCT && UNARY_OPS.has(t.value)) ||
      (t.type === TOKEN.ID && t.value === 'SEG')) {
    const op = t.value;
    i++;
    const operand = parseUnary(tokens, i, ctx);
    switch (op) {
      case '+': return { value: operand.value, next: operand.next };
      // - and ~ already produce signed 32-bit values in JS. No to32().
      case '-': return { value: -operand.value, next: operand.next };
      case '~': return { value: ~operand.value, next: operand.next };
      case 'SEG': return { value: 0, next: operand.next }; // SEG returns 0 in flat binary
    }
  }
  return parsePrimary(tokens, i, ctx);
}

function parsePrimary(tokens, i, ctx) {
  const t = tokens[i];
  if (!t) return { value: 0, next: i };

  if (t.type === TOKEN.NUM) {
    return { value: t.value, next: i + 1 };
  }

  if (t.type === TOKEN.STR) {
    return { value: t.value.length > 0 ? t.value.charCodeAt(0) : 0, next: i + 1 };
  }

  if (t.type === TOKEN.ID) {
    if (t.value === '$') {
      return { value: ctx.here || 0, next: i + 1 };
    }
    if (t.value === '$$') {
      return { value: ctx.sectionStart || 0, next: i + 1 };
    }
    // Label reference — look up in labels
    if (ctx.labels && ctx.labels.has(t.value)) {
      return { value: ctx.labels.get(t.value), next: i + 1 };
    }
    // Undefined label (forward reference) — return 0 for now, will be fixed in multi-pass
    // Actually, for labels that end with ':', we want to skip those (they're definitions)
    // Also check: maybe the next token is ':' (label definition)? If so, this is a label def.
    if (i + 1 < tokens.length && tokens[i + 1].type === TOKEN.PUNCT && tokens[i + 1].value === ':') {
      // This is a label definition — don't consume it as part of expression
      return { value: 0, next: i }; // return 0, don't advance
    }
    // Forward ref: return 0 for now
    return { value: 0, next: i + 1 };
  }

  // Parenthesized expression
  if (t.type === TOKEN.PUNCT && t.value === '(') {
    i++;
    const inner = parseExpr(tokens, i, ctx);
    i = inner.next;
    if (i < tokens.length && tokens[i].type === TOKEN.PUNCT && tokens[i].value === ')') {
      i++;
    }
    return { value: inner.value, next: i };
  }

  return { value: 0, next: i + 1 };
}

// ═══════════════════════════════════════════════════════════════════════
// PARSER — token stream → AST of statements
// ═══════════════════════════════════════════════════════════════════════

// A statement is one of:
//   { type: 'label',    name: string }
//   { type: 'insn',     mnemonic: string, ops: [...], size: number|null }
//   { type: 'directive', dir: string, args: [...] }
//   { type: 'empty' }

function parse(tokens, filename) {
  const statements = [];
  let i = 0;

  function peek(n) { return tokens[i + (n || 0)]; }
  function consume() { return tokens[i++]; }

  function skipEOL() {
    while (i < tokens.length && tokens[i].type === TOKEN.EOL) i++;
  }

  function skipToEOL() {
    while (i < tokens.length && tokens[i].type !== TOKEN.EOL && tokens[i].type !== TOKEN.EOF) i++;
    skipEOL();
  }

  function readExprList() {
    // Read comma-separated expressions and string literals
    const items = [];
    while (true) {
      const t = peek();
      if (!t || t.type === TOKEN.EOL || t.type === TOKEN.EOF) break;

      // Could be a string
      if (t.type === TOKEN.STR) {
        consume();
        items.push({ kind: 'str', value: t.value });
      } else if (t.type === TOKEN.NUM) {
        // Single-token number — preserve raw text for 64-bit accuracy
        const text = t.text || String(t.value);
        const startIdx = i;
        const expr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
        i = expr.next;
        items.push({ kind: 'expr', value: expr.value, text, tokenStart: startIdx, tokenEnd: expr.next });
      } else {
        const startIdx = i;
        const expr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
        i = expr.next;
        items.push({ kind: 'expr', value: expr.value, tokenStart: startIdx, tokenEnd: expr.next });
      }

      // Skip comma
      if (peek() && peek().type === TOKEN.PUNCT && peek().value === ',') {
        consume();
        continue;
      }
      break;
    }
    return items;
  }

  while (i < tokens.length) {
    skipEOL();
    if (i >= tokens.length || tokens[i].type === TOKEN.EOF) break;

    const t = peek();

    // % line — preprocessor directive
    if (t.type === TOKEN.ID && t.value.startsWith('%')) {
      skipToEOL();
      continue;
    }

    // [BITS N] — bracket directive syntax
    if (t.type === TOKEN.PUNCT && t.value === '[') {
      const next = peek(1);
      if (next && next.type === TOKEN.ID && (next.value.toUpperCase() === 'BITS' || next.value.toUpperCase() === 'ORG' || next.value.toUpperCase() === 'USE16' || next.value.toUpperCase() === 'USE32')) {
        consume(); // '['
        const dirTok = consume(); // BITS or ORG
        const dir = dirTok.value.toUpperCase();
        const tokenStart = i;
        const expr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
        i = expr.next;
        if (i < tokens.length && tokens[i].type === TOKEN.PUNCT && tokens[i].value === ']') {
          i++; // consume ']'
        }
        statements.push({ type: 'directive', dir, args: [{value: expr.value, tokenStart, tokenEnd: expr.next}] });
        skipToEOL();
        continue;
      }
    }

    // BITS / USE16 / USE32 directive
    if (t.type === TOKEN.ID && (t.value.toUpperCase() === 'BITS' || t.value.toUpperCase() === 'USE16' || t.value.toUpperCase() === 'USE32')) {
      if (t.value.toUpperCase() === 'USE16') {
        consume();
        statements.push({ type: 'directive', dir: 'BITS', args: [{value: 16}] });
        skipToEOL(); continue;
      }
      if (t.value.toUpperCase() === 'USE32') {
        consume();
        statements.push({ type: 'directive', dir: 'BITS', args: [{value: 32}] });
        skipToEOL(); continue;
      }
      consume();
      const bitsTokenStart = i;
      const bitsExpr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = bitsExpr.next;
      statements.push({ type: 'directive', dir: 'BITS', args: [{value: bitsExpr.value, tokenStart: bitsTokenStart, tokenEnd: bitsExpr.next}] });
      skipToEOL();
      continue;
    }

    // ORG directive
    if (t.type === TOKEN.ID && t.value.toUpperCase() === 'ORG') {
      consume();
      const orgTokenStart = i;
      const orgExpr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = orgExpr.next;
      statements.push({ type: 'directive', dir: 'ORG', args: [{value: orgExpr.value, tokenStart: orgTokenStart, tokenEnd: orgExpr.next}] });
      skipToEOL();
      continue;
    }

    // Data directives: DB, DW, DD, DQ, DT
    // Also RESB, RESW, RESD, RESQ
    // TIMES prefix
    // ALIGN directive

    // Check for TIMES prefix: TIMES <expr> <statement>
    // Store as compound directive — count is re-evaluated each assembly pass
    if (t.type === TOKEN.ID && t.value.toUpperCase() === 'TIMES') {
      consume();
      const countStart = i;
      const countExpr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = countExpr.next;
      const countEnd = i;
      const count = Math.max(0, countExpr.value);

      // Parse the repeated statement (one copy only — expansion happens in assembler)
      const inner = parseOneStatement();
      const body = inner ? (Array.isArray(inner) ? inner : [inner]) : [];
      skipToEOL();
      statements.push({ type: 'directive', dir: 'TIMES', count, 
        countTokenStart: countStart, countTokenEnd: countEnd, body });
      continue;
    }

    // ALIGN directive
    if (t.type === TOKEN.ID && t.value.toUpperCase() === 'ALIGN') {
      consume();
      const alignTokenStart = i;
      const alignExpr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = alignExpr.next;
      statements.push({ type: 'directive', dir: 'ALIGN', args: [{value: alignExpr.value, tokenStart: alignTokenStart, tokenEnd: alignExpr.next}] });
      skipToEOL();
      continue;
    }

    // Data directives
    const dataDirMatch = t.type === TOKEN.ID && t.value.toUpperCase().match(/^(DB|DW|DD|DQ|DT|RESB|RESW|RESD|RESQ)$/);
    if (dataDirMatch) {
      const dir = consume().value.toUpperCase();
      const args = readExprList();
      statements.push({ type: 'directive', dir, args });
      skipToEOL();
      continue;
    }

    // EQU directive: label EQU <expr>
    // Check: ID EQU expr
    if (t.type === TOKEN.ID && peek(1) && peek(1).type === TOKEN.ID && peek(1).value.toUpperCase() === 'EQU') {
      const label = consume().value;
      consume(); // EQU
      const equTokenStart = i;
      const equExpr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = equExpr.next;
      statements.push({ type: 'directive', dir: 'EQU', label, args: [{value: equExpr.value, tokenStart: equTokenStart, tokenEnd: equExpr.next}] });
      skipToEOL();
      continue;
    }

    // Label definition: ID ':'
    if (t.type === TOKEN.ID && peek(1) && peek(1).type === TOKEN.PUNCT && peek(1).value === ':') {
      const name = consume().value;
      consume(); // ':'
      // A label on its own line (or with more tokens on same line — NASM allows this)
      statements.push({ type: 'label', name });
      // Check if there's more on this line
      if (peek() && peek().type !== TOKEN.EOL && peek().type !== TOKEN.EOF) {
        // Parse the rest of the line as a statement
        const stmt = parseOneStatement();
        if (stmt) statements.push(stmt);
      }
      skipToEOL();
      continue;
    }

    // Must be an instruction or unrecognized
    const stmt = parseOneStatement();
    if (stmt) {
      if (Array.isArray(stmt)) statements.push(...stmt);
      else statements.push(stmt);
    }
    skipToEOL();
  }

  return statements;

  function parseOneStatement() {
    skipEOL();
    if (i >= tokens.length || tokens[i].type === TOKEN.EOF) return null;

    const t = peek();

    // Could be a preprocessor line
    if (t.type === TOKEN.ID && t.value.startsWith('%')) {
      skipToEOL();
      return null;
    }

    // Label on same line as instruction: ID ':' <rest>
    if (t.type === TOKEN.ID && peek(1) && peek(1).type === TOKEN.PUNCT && peek(1).value === ':') {
      const name = consume().value;
      consume(); // ':'
      const stmt = parseOneStatement();
      return [{ type: 'label', name }].concat(
        Array.isArray(stmt) ? stmt : (stmt ? [stmt] : [])
      );
    }

    // Must be a mnemonic
    if (t.type !== TOKEN.ID) {
      console.error(`${filename}:${t.line}:${t.col}: error: expected mnemonic, got '${t.value}'`);
      skipToEOL();
      return null;
    }

    const mnemonic = consume().value.toUpperCase();

    // Could be a directive
    if (['DB', 'DW', 'DD', 'DQ', 'DT', 'RESB', 'RESW', 'RESD', 'RESQ',
         'TIMES', 'EQU', 'ALIGN', 'BITS', 'ORG'].includes(mnemonic)) {
      // Already handled above, but if we get here, parse inline
      if (mnemonic === 'DB' || mnemonic === 'DW' || mnemonic === 'DD' ||
          mnemonic === 'DQ' || mnemonic === 'DT' ||
          mnemonic === 'RESB' || mnemonic === 'RESW' || mnemonic === 'RESD' || mnemonic === 'RESQ') {
        const args = readExprList();
        return { type: 'directive', dir: mnemonic, args };
      }
      if (mnemonic === 'TIMES') {
        const countStart = i;
        const countExpr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
        i = countExpr.next;
        const inner = parseOneStatement();
        const body = inner ? (Array.isArray(inner) ? inner : [inner]) : [];
        return { type: 'directive', dir: 'TIMES', count: Math.max(0, countExpr.value),
          countTokenStart: countStart, countTokenEnd: i, body };
      }
      skipToEOL();
      return null;
    }

    // Instruction — read operands
    const ops = [];
    while (true) {
      const next = peek();
      if (!next || next.type === TOKEN.EOL || next.type === TOKEN.EOF) break;

      // Read one operand
      const op = readOperand();
      if (op) ops.push(op);

      // Skip comma
      if (peek() && peek().type === TOKEN.PUNCT && peek().value === ',') {
        consume();
        continue;
      }
      break;
    }

    return { type: 'insn', mnemonic, ops, size: null };
  }

  function readOperand() {
    // An operand is one of:
    //   - register (ID that is a register name)
    //   - memory reference: [...] with optional SEG: prefix
    //   - immediate: expression, possibly with PTR or size specifier
    //   - string literal

    const t = peek();
    if (!t || t.type === TOKEN.EOL || t.type === TOKEN.EOF) return null;

    // Far pointer: expr ':' expr (before other operand checks)
    if (t.type === TOKEN.NUM || t.type === TOKEN.ID || (t.type === TOKEN.PUNCT && (t.value === '+' || t.value === '-' || t.value === '~'))) {
      const fsI = i;
      const fe = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      if (fe.next < tokens.length && tokens[fe.next].type === TOKEN.PUNCT && tokens[fe.next].value === ':') {
        const colonIdx = fe.next;
        i = colonIdx + 1;
        const soI = i;
        const se = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
        i = se.next;
        return { kind: 'farptr', seg: to32(fe.value), off: to32(se.value),
                 segTokenStart: fsI, segTokenEnd: colonIdx,
                 offTokenStart: soI, offTokenEnd: se.next };
      }
      i = fsI; // restore — not a far pointer
    }

    // String
    if (t.type === TOKEN.STR) {
      consume();
      return { kind: 'str', value: t.value };
    }

    // Memory reference: '[' ... ']'
    if (t.type === TOKEN.PUNCT && t.value === '[') {
      return readMemRef();
    }

    // Size specifiers: BYTE, WORD, DWORD, QWORD, TWORD, OWORD, YWORD, FAR, NEAR, SHORT
    // These appear before memory refs or as PTR prefixes
    const sizeSpecs = new Set(['BYTE', 'WORD', 'DWORD', 'QWORD', 'TWORD', 'OWORD', 'YWORD', 'FAR', 'NEAR', 'SHORT']);
    if (t.type === TOKEN.ID && sizeSpecs.has(t.value.toUpperCase())) {
      const sizeTok = consume();
      // Check if followed by PTR
      if (peek() && peek().type === TOKEN.ID && peek().value.toUpperCase() === 'PTR') {
        consume(); // PTR
        // Next must be memory ref
        if (peek() && peek().type === TOKEN.PUNCT && peek().value === '[') {
          const mem = readMemRef();
          mem.size = sizeTok.value.toUpperCase();
          return mem;
        }
        // Or expression
        const szStartIdx = i;
        const expr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
        i = expr.next;
        return { kind: 'imm', value: expr.value, size: sizeTok.value.toUpperCase(), tokenStart: szStartIdx, tokenEnd: expr.next };
      }
      // Size prefix followed by memory reference or expression
      if (peek() && peek().type === TOKEN.PUNCT && peek().value === '[') {
        const mem = readMemRef();
        mem.size = sizeTok.value.toUpperCase();
        return mem;
      }
      const szStartIdx2 = i;
      const expr2 = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = expr2.next;
      return { kind: 'imm', value: expr2.value, size: sizeTok.value.toUpperCase(), tokenStart: szStartIdx2, tokenEnd: expr2.next };
    }

    // Immediate or register
    if (t.type === TOKEN.ID) {
      const reg = parseRegister(t.value);
      if (reg) {
        consume();
        return { kind: 'reg', name: reg.name, bits: reg.bits, code: reg.code,
                 seg: reg.seg, cr: reg.cr, dr: reg.dr, tr: reg.tr };
      }
      // Not a register — it's an expression (label, immediate, etc.)
      const startIdx = i;
      const expr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = expr.next;
      return { kind: 'imm', value: expr.value, tokenStart: startIdx, tokenEnd: expr.next };
    }

    // Numeric immediate
    if (t.type === TOKEN.NUM) {
      const startIdx = i;
      const expr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = expr.next;
      return { kind: 'imm', value: expr.value, tokenStart: startIdx, tokenEnd: expr.next };
    }

    // Unary operator starting an expression
    if (t.type === TOKEN.PUNCT && (t.value === '+' || t.value === '-' || t.value === '~')) {
      const startIdx = i;
      const expr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = expr.next;
      return { kind: 'imm', value: expr.value, tokenStart: startIdx, tokenEnd: expr.next };
    }

    // $ token
    if (t.type === TOKEN.ID && t.value === '$') {
      const startIdx = i;
      const expr = parseExpr(tokens, i, { here: 0, sectionStart: 0, labels: new Map() });
      i = expr.next;
      return { kind: 'imm', value: expr.value, tokenStart: startIdx, tokenEnd: expr.next };
    }

    return null;
  }

  function readMemRef() {
    consume(); // '['

    let seg = null;
    let base = null, index = null, scale = 1;
    let disp = 0;
    const parts = [];

    // Read tokens until ']'
    let depth = 1;
    while (depth > 0 && i < tokens.length) {
      const t = peek();
      if (!t || t.type === TOKEN.EOF) break;
      if (t.type === TOKEN.PUNCT && t.value === '[') { depth++; consume(); continue; }
      if (t.type === TOKEN.PUNCT && t.value === ']') { depth--; if (depth === 0) { consume(); break; } }
      parts.push(consume());
    }

    // Parse the parts into base, index, scale, displacement, segment
    let p = 0, dispVal = 0, dispTokenStart = null, dispTokenEnd = null, sign = 1;

    // Check for segment override: ID ':' at start
    if (p < parts.length && parts[p].type === TOKEN.ID &&
        ALL_REGS.has(parts[p].value.toUpperCase()) && ALL_REGS.get(parts[p].value.toUpperCase()).seg &&
        p + 1 < parts.length && parts[p + 1].type === TOKEN.PUNCT && parts[p + 1].value === ':') {
      seg = parts[p].value.toUpperCase();
      p += 2;
    }

    // Classify remaining tokens
    while (p < parts.length) {
      const pt = parts[p];

      // Sign operators
      if (pt.type === TOKEN.PUNCT && pt.value === '+') { sign = 1; p++; continue; }
      if (pt.type === TOKEN.PUNCT && pt.value === '-') { sign = -1; p++; continue; }

      // Register
      if (pt.type === TOKEN.ID && ALL_REGS.has(pt.value.toUpperCase())) {
        const reg = ALL_REGS.get(pt.value.toUpperCase());
        if (reg.seg) { p++; continue; }
        // Check for '* scale' — this makes it an index register
        let sc = 1;
        if (p + 2 < parts.length && parts[p + 1].type === TOKEN.PUNCT && parts[p + 1].value === '*' &&
            parts[p + 2].type === TOKEN.NUM) {
          sc = parts[p + 2].value;
          p += 2; // skip * and scale value
        }
        // Classify register as base or index
        // 16-bit: SI/DI are always index, BX/BP are always base
        // 32-bit: any reg can be base or index; scale forces index
        const isIdx16 = (reg.name === 'SI' || reg.name === 'DI') && reg.bits === 16;
        const isBase16 = (reg.name === 'BX' || reg.name === 'BP') && reg.bits === 16;
        if (sc !== 1 || isIdx16) {
          // This is an index register (scale or 16-bit SI/DI)
          if (!index) {
            index = { name: reg.name, bits: reg.bits, code: reg.code };
            scale = sc;
          } else if (!base && !isBase16) {
            base = { name: reg.name, bits: reg.bits, code: reg.code };
          }
        } else if (!base) {
          base = { name: reg.name, bits: reg.bits, code: reg.code };
        } else if (!index) {
          index = { name: reg.name, bits: reg.bits, code: reg.code };
        }
        p++;
        continue;
      }

      // Expression (label or number) — accumulates into displacement
      // We evaluate it as a signed contribution via sign
      dispTokenStart = p; // store index into parts for re-evaluation
      dispTokenEnd = p + 1;
      if (pt.type === TOKEN.NUM) {
        dispVal += sign * pt.value;
      } else if (pt.type === TOKEN.ID) {
        // Label reference — store for later re-evaluation
        // We'll re-evaluate via the parts tokens during assembly
        dispVal += 0; // placeholder
      }
      p++;
      sign = 1;
    }

    disp = dispVal;
    return { kind: 'mem', parts, seg, base, index, scale, disp,
             dispTokenStart, dispTokenEnd };
  }
}

// Register tables
const REG8  = { AL:0, CL:1, DL:2, BL:3, AH:4, CH:5, DH:6, BH:7 };
const REG16 = { AX:0, CX:1, DX:2, BX:3, SP:4, BP:5, SI:6, DI:7 };
const REG32 = { EAX:0, ECX:1, EDX:2, EBX:3, ESP:4, EBP:5, ESI:6, EDI:7 };
const REG_SEG = { ES:0, CS:1, SS:2, DS:3, FS:4, GS:5 };
const REG_MM = { MM0:0, MM1:1, MM2:2, MM3:3, MM4:4, MM5:5, MM6:6, MM7:7 };
const REG_XMM = { XMM0:0, XMM1:1, XMM2:2, XMM3:3, XMM4:4, XMM5:5, XMM6:6, XMM7:7 };
const REG_CR = { CR0:0, CR2:2, CR3:3, CR4:4 };
const REG_DR = { DR0:0, DR1:1, DR2:2, DR3:3, DR6:6, DR7:7 };
const REG_TR = { TR3:3, TR4:4, TR5:5, TR6:6, TR7:7 };

const ALL_REGS = new Map();
for (const [k,v] of Object.entries(REG8))   ALL_REGS.set(k, { name:k, bits:8,  code:v });
for (const [k,v] of Object.entries(REG16))  ALL_REGS.set(k, { name:k, bits:16, code:v });
for (const [k,v] of Object.entries(REG32))  ALL_REGS.set(k, { name:k, bits:32, code:v });
for (const [k,v] of Object.entries(REG_SEG))ALL_REGS.set(k, { name:k, bits:16, code:v, seg:true });
for (const [k,v] of Object.entries(REG_MM)) ALL_REGS.set(k, { name:k, bits:64, code:v });
for (const [k,v] of Object.entries(REG_XMM))ALL_REGS.set(k, { name:k, bits:128, code:v });
for (const [k,v] of Object.entries(REG_CR)) ALL_REGS.set(k, { name:k, bits:32, code:v, cr:true });
for (const [k,v] of Object.entries(REG_DR)) ALL_REGS.set(k, { name:k, bits:32, code:v, dr:true });
for (const [k,v] of Object.entries(REG_TR)) ALL_REGS.set(k, { name:k, bits:32, code:v, tr:true });

function parseRegister(name) {
  return ALL_REGS.get(name.toUpperCase()) || null;
}

// ═══════════════════════════════════════════════════════════════════════
// INSTRUCTION ENCODING DATABASE
// ═══════════════════════════════════════════════════════════════════════

// Operand kinds for the encoding table
const OK = {
  R8:    'r8',     // 8-bit register
  R16:   'r16',    // 16-bit register
  R32:   'r32',    // 32-bit register
  RM8:   'rm8',    // 8-bit register or memory
  RM16:  'rm16',   // 16-bit register or memory
  RM32:  'rm32',   // 32-bit register or memory
  IMM8:  'imm8',   // 8-bit immediate
  IMM16: 'imm16',  // 16-bit immediate
  IMM32: 'imm32',  // 32-bit immediate
  SREG:  'sreg',   // segment register
  CR:    'cr',     // control register
  DR:    'dr',     // debug register
  TR:    'tr',     // test register
  MM:    'mm',     // MMX register
  XMM:   'xmm',    // XMM register
  MEM:   'mem',    // memory only (no register form)
  REL8:  'rel8',   // 8-bit relative offset
  REL1632:'rel1632', // 16/32-bit relative offset
  AL:    'al',     // AL specifically
  AX:    'ax',     // AX/EAX specifically
  EAX:   'eax',    // EAX specifically
  ONE:   'one',    // implied 1 (for shifts)
  CL:    'cl',     // CL specifically
  DX:    'dx',     // DX specifically
  FARPTR:'farptr',  // segment:offset far pointer
};

// Instruction encoding table.
// Each mnemonic maps to an array of encoding forms.
// An encoding form is: { op: [byte, ...], ops: [kind, ...], modrm: rule|null, sizePrefix:bool }
//
// modrm rule describes how operands map onto ModR/M fields:
//   'reg=rN,rm=rM' — reg field gets operand N's register code, rm field gets operand M
//   null — opcode encodes the operand directly (+r in low 3 bits of opcode)
//
// TODO: this is the table that grows as we add instructions.
// Each entry is verified byte-for-byte against NASM via golden tests.

const INSN_TABLE = new Map();

// ── MOV ──

INSN_TABLE.set('MOV', [
  // mov r/m8, r8
  { op:[0x88], ops:[OK.RM8, OK.R8], modrm:'reg=r2,rm=r1' },
  // mov r/m16, r16
  { op:[0x89], ops:[OK.RM16, OK.R16], modrm:'reg=r2,rm=r1' },
  // mov r/m32, r32
  { op:[0x89], ops:[OK.RM32, OK.R32], modrm:'reg=r2,rm=r1' },
  // mov r8, r/m8  — reg=r1(dest register), rm=r2(source r/m)
  { op:[0x8A], ops:[OK.R8, OK.RM8], modrm:'reg=r1,rm=r2' },
  // mov r16, r/m16
  { op:[0x8B], ops:[OK.R16, OK.RM16], modrm:'reg=r1,rm=r2' },
  // mov r32, r/m32
  { op:[0x8B], ops:[OK.R32, OK.RM32], modrm:'reg=r1,rm=r2' },
  // mov r/m16, Sreg  — ModR/M reg = Sreg(op2), rm = r/m16(op1)
  { op:[0x8C], ops:[OK.RM16, OK.SREG], modrm:'reg=r2,rm=r1' },
  // mov Sreg, r/m16  — ModR/M reg = Sreg(op1), rm = r/m16(op2)
  { op:[0x8E], ops:[OK.SREG, OK.RM16], modrm:'reg=r1,rm=r2' },
  // mov al, moffs8
  { op:[0xA0], ops:[OK.AL, OK.MEM], modrm:null }, // special moffs encoding
  // mov ax/eax, moffs16/32
  { op:[0xA1], ops:[OK.AX, OK.MEM], modrm:null },
  // mov moffs8, al
  { op:[0xA2], ops:[OK.MEM, OK.AL], modrm:null },
  // mov moffs16/32, ax/eax
  { op:[0xA3], ops:[OK.MEM, OK.AX], modrm:null },
  // mov r8, imm8
  { op:[0xB0], ops:[OK.R8, OK.IMM8], modrm:null, opReg:true }, // +r encoded in opcode
  // mov r16, imm16
  { op:[0xB8], ops:[OK.R16, OK.IMM16], modrm:null, opReg:true },
  // mov r32, imm32
  { op:[0xB8], ops:[OK.R32, OK.IMM32], modrm:null, opReg:true },
  // mov r/m8, imm8
  { op:[0xC6], ops:[OK.RM8, OK.IMM8], modrm:'rm=r1', modrmReg:0 },
  // mov r/m16, imm16
  { op:[0xC7], ops:[OK.RM16, OK.IMM16], modrm:'rm=r1', modrmReg:0 },
  // mov r/m32, imm32
  { op:[0xC7], ops:[OK.RM32, OK.IMM32], modrm:'rm=r1', modrmReg:0 },
]);

// ── INT ──
INSN_TABLE.set('INT', [
  { op:[0xCD], ops:[OK.IMM8], modrm:null },
]);

// ── HLT ──
INSN_TABLE.set('HLT', [
  { op:[0xF4], ops:[], modrm:null },
]);

// ── NOP ──
INSN_TABLE.set('NOP', [
  { op:[0x90], ops:[], modrm:null },
]);

// ── CLI / STI ──
INSN_TABLE.set('CLI', [{ op:[0xFA], ops:[], modrm:null }]);
INSN_TABLE.set('STI', [{ op:[0xFB], ops:[], modrm:null }]);

// ── CLD / STD ──
INSN_TABLE.set('CLD', [{ op:[0xFC], ops:[], modrm:null }]);
INSN_TABLE.set('STD', [{ op:[0xFD], ops:[], modrm:null }]);

// ── PUSH / POP ──
INSN_TABLE.set('PUSH', [
  { op:[0x50], ops:[OK.R16], modrm:null, opReg:true },
  { op:[0x50], ops:[OK.R32], modrm:null, opReg:true },
  { op:[0xFF], ops:[OK.RM16], modrm:'rm=r1', modrmReg:6 },
  { op:[0xFF], ops:[OK.RM32], modrm:'rm=r1', modrmReg:6 },
  { op:[0x6A], ops:[OK.IMM8], modrm:null },  // push imm8 (sign-extended)
  { op:[0x68], ops:[OK.IMM16], modrm:null },
  { op:[0x68], ops:[OK.IMM32], modrm:null },
  { op:[0x06], ops:[OK.SREG], modrm:null, opSeg:true }, // push seg (ES=0, CS=1, SS=2, DS=3)
]);

INSN_TABLE.set('POP', [
  { op:[0x58], ops:[OK.R16], modrm:null, opReg:true },
  { op:[0x58], ops:[OK.R32], modrm:null, opReg:true },
  { op:[0x8F], ops:[OK.RM16], modrm:'rm=r1', modrmReg:0 },
  { op:[0x8F], ops:[OK.RM32], modrm:'rm=r1', modrmReg:0 },
  { op:[0x07], ops:[OK.SREG], modrm:null, opSeg:true },
]);

// ── CALL / RET / JMP ──
INSN_TABLE.set('CALL', [
  { op:[0xE8], ops:[OK.REL1632], modrm:null }, // call rel16/32
  { op:[0xFF], ops:[OK.RM16], modrm:'rm=r1', modrmReg:2 }, // call r/m16
  { op:[0xFF], ops:[OK.RM32], modrm:'rm=r1', modrmReg:2 }, // call r/m32
]);

INSN_TABLE.set('RET', [
  { op:[0xC3], ops:[], modrm:null },
  { op:[0xC2], ops:[OK.IMM16], modrm:null }, // ret imm16
]);

INSN_TABLE.set('RETF', [
  { op:[0xCB], ops:[], modrm:null },
]);

// JMP (unconditional)
INSN_TABLE.set('JMP', [
  { op:[0xEB], ops:[OK.REL8], modrm:null },     // jmp short
  { op:[0xE9], ops:[OK.REL1632], modrm:null },   // jmp near
  { op:[0xEA], ops:[OK.FARPTR], modrm:null },    // jmp far seg:off
  { op:[0xFF], ops:[OK.RM16], modrm:'rm=r1', modrmReg:4 }, // jmp r/m16
  { op:[0xFF], ops:[OK.RM32], modrm:'rm=r1', modrmReg:4 }, // jmp r/m32
]);

// Conditional jumps (JC, JNC, JZ, JNZ, etc.)
const JCC_TABLE = {
  JO:0x70, JNO:0x71, JB:0x72, JNAE:0x72, JC:0x72,
  JNB:0x73, JAE:0x73, JNC:0x73,
  JZ:0x74, JE:0x74, JNZ:0x75, JNE:0x75,
  JBE:0x76, JNA:0x76, JNBE:0x77, JA:0x77,
  JS:0x78, JNS:0x79, JP:0x7A, JPE:0x7A, JNP:0x7B, JPO:0x7B,
  JL:0x7C, JNGE:0x7C, JNL:0x7D, JGE:0x7D,
  JLE:0x7E, JNG:0x7E, JNLE:0x7F, JG:0x7F,
};

for (const [mnem, opcode] of Object.entries(JCC_TABLE)) {
  INSN_TABLE.set(mnem, [
    { op:[opcode], ops:[OK.REL8], modrm:null },          // jcc short (8-bit relative)
    { op:[0x0F, 0x80 + (opcode & 0x0F)], ops:[OK.REL1632], modrm:null }, // jcc near (32-bit relative)
  ]);
  // Also add the near form for 16-bit mode: 0x0F 0x80 + low nibble
  // Actually for 16-bit mode it's the same opcode bytes, just different operand size prefix.
  // The operand size prefix is added automatically based on BITS directive.
}

// ── IN / OUT ──
INSN_TABLE.set('IN', [
  { op:[0xE4], ops:[OK.AL, OK.IMM8], modrm:null },      // in al, imm8
  { op:[0xE5], ops:[OK.AX, OK.IMM8], modrm:null },      // in ax/eax, imm8
  { op:[0xEC], ops:[OK.AL, OK.DX], modrm:null },         // in al, dx
  { op:[0xED], ops:[OK.AX, OK.DX], modrm:null },         // in ax/eax, dx
]);

INSN_TABLE.set('OUT', [
  { op:[0xE6], ops:[OK.IMM8, OK.AL], modrm:null },      // out imm8, al
  { op:[0xE7], ops:[OK.IMM8, OK.AX], modrm:null },      // out imm8, ax/eax
  { op:[0xEE], ops:[OK.DX, OK.AL], modrm:null },         // out dx, al
  { op:[0xEF], ops:[OK.DX, OK.AX], modrm:null },         // out dx, ax/eax
]);

// ── MOV CRn / DRn / TRn ──
INSN_TABLE.set('MOV', INSN_TABLE.get('MOV').concat([
  // mov crN, r32
  { op:[0x0F, 0x22], ops:[OK.CR, OK.R32], modrm:'reg=r2,rm=r1' },
  // mov r32, crN
  { op:[0x0F, 0x20], ops:[OK.R32, OK.CR], modrm:'reg=r2,rm=r1' },
]));

// ── LGDT / LIDT / SGDT / SIDT ──
INSN_TABLE.set('LGDT', [{ op:[0x0F, 0x01], ops:[OK.MEM], modrm:'rm=r1', modrmReg:2 }]);
INSN_TABLE.set('LIDT', [{ op:[0x0F, 0x01], ops:[OK.MEM], modrm:'rm=r1', modrmReg:3 }]);

// ── ARITHMETIC: ADD, OR, ADC, SBB, AND, SUB, XOR, CMP ──
// Group 1 encoding: opcode = base + 8*opExt, r/m forms use 0x80-0x83 + ModR/M reg field
function addAluMnemonic(name, opExt) {
  INSN_TABLE.set(name, [
    // r/m8, r8
    { op:[0x00 + opExt * 8], ops:[OK.RM8, OK.R8], modrm:'reg=r2,rm=r1' },
    // r/m16, r16
    { op:[0x01 + opExt * 8], ops:[OK.RM16, OK.R16], modrm:'reg=r2,rm=r1' },
    // r/m32, r32
    { op:[0x01 + opExt * 8], ops:[OK.RM32, OK.R32], modrm:'reg=r2,rm=r1' },
    // r8, r/m8  — reg=r1(dest register), rm=r2(source r/m)
    { op:[0x02 + opExt * 8], ops:[OK.R8, OK.RM8], modrm:'reg=r1,rm=r2' },
    // r16, r/m16
    { op:[0x03 + opExt * 8], ops:[OK.R16, OK.RM16], modrm:'reg=r1,rm=r2' },
    // r32, r/m32
    { op:[0x03 + opExt * 8], ops:[OK.R32, OK.RM32], modrm:'reg=r1,rm=r2' },
    // r/mN, immN — full-width forms (only match when imm doesn't fit in 8-bit)
    { op:[0x81], ops:[OK.RM16, OK.IMM16], modrm:'rm=r1', modrmReg:opExt },
    { op:[0x81], ops:[OK.RM32, OK.IMM32], modrm:'rm=r1', modrmReg:opExt },
    // r/m8, imm8
    { op:[0x80], ops:[OK.RM8, OK.IMM8], modrm:'rm=r1', modrmReg:opExt },
    // r/m16/32, imm8 sign-extended — before accumulator forms for NASM tie-breaking
    { op:[0x83], ops:[OK.RM16, OK.IMM8], modrm:'rm=r1', modrmReg:opExt },
    { op:[0x83], ops:[OK.RM32, OK.IMM8], modrm:'rm=r1', modrmReg:opExt },
    // Accumulator-specific forms (after r/m forms — 0x83 wins ties)
    // al, imm8
    { op:[0x04 + opExt * 8], ops:[OK.AL, OK.IMM8], modrm:null },
    // ax/eax, imm16/32
    { op:[0x05 + opExt * 8], ops:[OK.AX, OK.IMM16], modrm:null },
    { op:[0x05 + opExt * 8], ops:[OK.AX, OK.IMM32], modrm:null },
  ]);
}

addAluMnemonic('ADD', 0);
addAluMnemonic('OR',  1);
addAluMnemonic('ADC', 2);
addAluMnemonic('SBB', 3);
addAluMnemonic('AND', 4);
addAluMnemonic('SUB', 5);
addAluMnemonic('XOR', 6);
addAluMnemonic('CMP', 7);

// ── SHIFT/ROTATE ──
function addShiftMnemonic(name, opExt) {
  INSN_TABLE.set(name, [
    // r/m8, 1
    { op:[0xD0], ops:[OK.RM8, OK.ONE], modrm:'rm=r1', modrmReg:opExt },
    // r/m16, 1
    { op:[0xD1], ops:[OK.RM16, OK.ONE], modrm:'rm=r1', modrmReg:opExt },
    // r/m32, 1
    { op:[0xD1], ops:[OK.RM32, OK.ONE], modrm:'rm=r1', modrmReg:opExt },
    // r/m8, CL
    { op:[0xD2], ops:[OK.RM8, OK.CL], modrm:'rm=r1', modrmReg:opExt },
    // r/m16, CL
    { op:[0xD3], ops:[OK.RM16, OK.CL], modrm:'rm=r1', modrmReg:opExt },
    // r/m32, CL
    { op:[0xD3], ops:[OK.RM32, OK.CL], modrm:'rm=r1', modrmReg:opExt },
    // r/m8, imm8
    { op:[0xC0], ops:[OK.RM8, OK.IMM8], modrm:'rm=r1', modrmReg:opExt },
    // r/m16, imm8
    { op:[0xC1], ops:[OK.RM16, OK.IMM8], modrm:'rm=r1', modrmReg:opExt },
    // r/m32, imm8
    { op:[0xC1], ops:[OK.RM32, OK.IMM8], modrm:'rm=r1', modrmReg:opExt },
  ]);
}

addShiftMnemonic('ROL', 0); addShiftMnemonic('ROR', 1);
addShiftMnemonic('RCL', 2); addShiftMnemonic('RCR', 3);
addShiftMnemonic('SHL', 4); addShiftMnemonic('SAL', 4);
addShiftMnemonic('SHR', 5); addShiftMnemonic('SAR', 7);

// ── TEST ──
INSN_TABLE.set('TEST', [
  // test r/m8, r8
  { op:[0x84], ops:[OK.RM8, OK.R8], modrm:'reg=r2,rm=r1' },
  // test r/m16, r16
  { op:[0x85], ops:[OK.RM16, OK.R16], modrm:'reg=r2,rm=r1' },
  // test r/m32, r32
  { op:[0x85], ops:[OK.RM32, OK.R32], modrm:'reg=r2,rm=r1' },
  // test r/m8, imm8
  { op:[0xF6], ops:[OK.RM8, OK.IMM8], modrm:'rm=r1', modrmReg:0 },
  // test r/m16, imm16
  { op:[0xF7], ops:[OK.RM16, OK.IMM16], modrm:'rm=r1', modrmReg:0 },
  // test r/m32, imm32
  { op:[0xF7], ops:[OK.RM32, OK.IMM32], modrm:'rm=r1', modrmReg:0 },
  // test al, imm8
  { op:[0xA8], ops:[OK.AL, OK.IMM8], modrm:null },
  // test ax/eax, imm16/32
  { op:[0xA9], ops:[OK.AX, OK.IMM16], modrm:null },
  { op:[0xA9], ops:[OK.AX, OK.IMM32], modrm:null },
]);

// ── INC / DEC (FE/FF group) ──
INSN_TABLE.set('INC', [
  // Short form: 0x40+reg for all 16-bit registers (BITS 16) or 32-bit (BITS 32)
  { op:[0x40], ops:[OK.R16], modrm:null, opReg:true },
  { op:[0x40], ops:[OK.R32], modrm:null, opReg:true },
  // Long form for r/m8
  { op:[0xFE], ops:[OK.RM8], modrm:'rm=r1', modrmReg:0 },
  // Long form for r/m16, r/m32 (when short form doesn't apply)
  { op:[0xFF], ops:[OK.RM16], modrm:'rm=r1', modrmReg:0 },
  { op:[0xFF], ops:[OK.RM32], modrm:'rm=r1', modrmReg:0 },
]);
INSN_TABLE.set('DEC', [
  // Short form: 0x48+reg for all 16-bit registers (BITS 16) or 32-bit (BITS 32)
  { op:[0x48], ops:[OK.R16], modrm:null, opReg:true },
  { op:[0x48], ops:[OK.R32], modrm:null, opReg:true },
  // Long form for r/m8
  { op:[0xFE], ops:[OK.RM8], modrm:'rm=r1', modrmReg:1 },
  // Long form for r/m16, r/m32
  { op:[0xFF], ops:[OK.RM16], modrm:'rm=r1', modrmReg:1 },
  { op:[0xFF], ops:[OK.RM32], modrm:'rm=r1', modrmReg:1 },
]);

// ── NOT / NEG ──
INSN_TABLE.set('NOT', [
  { op:[0xF6], ops:[OK.RM8], modrm:'rm=r1', modrmReg:2 },
  { op:[0xF7], ops:[OK.RM16], modrm:'rm=r1', modrmReg:2 },
  { op:[0xF7], ops:[OK.RM32], modrm:'rm=r1', modrmReg:2 },
]);
INSN_TABLE.set('NEG', [
  { op:[0xF6], ops:[OK.RM8], modrm:'rm=r1', modrmReg:3 },
  { op:[0xF7], ops:[OK.RM16], modrm:'rm=r1', modrmReg:3 },
  { op:[0xF7], ops:[OK.RM32], modrm:'rm=r1', modrmReg:3 },
]);

// ── MUL / IMUL / DIV / IDIV ──
INSN_TABLE.set('MUL', [
  { op:[0xF6], ops:[OK.RM8], modrm:'rm=r1', modrmReg:4 },
  { op:[0xF7], ops:[OK.RM16], modrm:'rm=r1', modrmReg:4 },
  { op:[0xF7], ops:[OK.RM32], modrm:'rm=r1', modrmReg:4 },
]);
INSN_TABLE.set('IMUL', [
  // Single-operand: IMUL r/m
  { op:[0xF6], ops:[OK.RM8], modrm:'rm=r1', modrmReg:5 },
  { op:[0xF7], ops:[OK.RM16], modrm:'rm=r1', modrmReg:5 },
  { op:[0xF7], ops:[OK.RM32], modrm:'rm=r1', modrmReg:5 },
  // Two-operand: IMUL r16, r/m16
  { op:[0x0F, 0xAF], ops:[OK.R16, OK.RM16], modrm:'reg=r1,rm=r2' },
  { op:[0x0F, 0xAF], ops:[OK.R32, OK.RM32], modrm:'reg=r1,rm=r2' },
  // Three-operand: IMUL r, r/m, imm8
  { op:[0x6B], ops:[OK.R16, OK.RM16, OK.IMM8], modrm:'reg=r1,rm=r2' },
  { op:[0x6B], ops:[OK.R32, OK.RM32, OK.IMM8], modrm:'reg=r1,rm=r2' },
  // Three-operand: IMUL r, r/m, imm16/32
  { op:[0x69], ops:[OK.R16, OK.RM16, OK.IMM16], modrm:'reg=r1,rm=r2' },
  { op:[0x69], ops:[OK.R32, OK.RM32, OK.IMM32], modrm:'reg=r1,rm=r2' },
]);
INSN_TABLE.set('DIV', [
  { op:[0xF6], ops:[OK.RM8], modrm:'rm=r1', modrmReg:6 },
  { op:[0xF7], ops:[OK.RM16], modrm:'rm=r1', modrmReg:6 },
  { op:[0xF7], ops:[OK.RM32], modrm:'rm=r1', modrmReg:6 },
]);
INSN_TABLE.set('IDIV', [
  { op:[0xF6], ops:[OK.RM8], modrm:'rm=r1', modrmReg:7 },
  { op:[0xF7], ops:[OK.RM16], modrm:'rm=r1', modrmReg:7 },
  { op:[0xF7], ops:[OK.RM32], modrm:'rm=r1', modrmReg:7 },
]);

// ── LEA ──
INSN_TABLE.set('LEA', [
  { op:[0x8D], ops:[OK.R16, OK.MEM], modrm:'reg=r1,rm=r2' },
  { op:[0x8D], ops:[OK.R32, OK.MEM], modrm:'reg=r1,rm=r2' },
]);

// ── MOVSX / MOVZX ──
INSN_TABLE.set('MOVSX', [
  { op:[0x0F, 0xBE], ops:[OK.R16, OK.RM8], modrm:'reg=r1,rm=r2' },
  { op:[0x0F, 0xBE], ops:[OK.R32, OK.RM8], modrm:'reg=r1,rm=r2' },
  { op:[0x0F, 0xBF], ops:[OK.R32, OK.RM16], modrm:'reg=r1,rm=r2' },
]);
INSN_TABLE.set('MOVZX', [
  { op:[0x0F, 0xB6], ops:[OK.R16, OK.RM8], modrm:'reg=r1,rm=r2' },
  { op:[0x0F, 0xB6], ops:[OK.R32, OK.RM8], modrm:'reg=r1,rm=r2' },
  { op:[0x0F, 0xB7], ops:[OK.R32, OK.RM16], modrm:'reg=r1,rm=r2' },
]);

// ── XCHG ──
INSN_TABLE.set('XCHG', [
  { op:[0x86], ops:[OK.RM8, OK.R8], modrm:'reg=r2,rm=r1' },
  { op:[0x87], ops:[OK.RM16, OK.R16], modrm:'reg=r2,rm=r1' },
  { op:[0x87], ops:[OK.RM32, OK.R32], modrm:'reg=r2,rm=r1' },
  // XCHG EAX, reg (opcode 0x90+reg)
  { op:[0x90], ops:[OK.AX, OK.AX], modrm:null, opReg:true },
]);

// ── STRING OPERATIONS ──
INSN_TABLE.set('LODSB', [{ op:[0xAC], ops:[], modrm:null }]);
INSN_TABLE.set('LODSW', [{ op:[0xAD], ops:[], modrm:null }]);
INSN_TABLE.set('LODSD', [{ op:[0xAD], ops:[], modrm:null }]); // 0xAD with REX or 0x66
INSN_TABLE.set('STOSB', [{ op:[0xAA], ops:[], modrm:null }]);
INSN_TABLE.set('STOSW', [{ op:[0xAB], ops:[], modrm:null }]);
INSN_TABLE.set('STOSD', [{ op:[0xAB], ops:[], modrm:null }]);
INSN_TABLE.set('MOVSB', [{ op:[0xA4], ops:[], modrm:null }]);
INSN_TABLE.set('MOVSW', [{ op:[0xA5], ops:[], modrm:null }]);
INSN_TABLE.set('MOVSD', [{ op:[0xA5], ops:[], modrm:null }]);
INSN_TABLE.set('SCASB', [{ op:[0xAE], ops:[], modrm:null }]);
INSN_TABLE.set('SCASW', [{ op:[0xAF], ops:[], modrm:null }]);
INSN_TABLE.set('SCASD', [{ op:[0xAF], ops:[], modrm:null }]);
INSN_TABLE.set('CMPSB', [{ op:[0xA6], ops:[], modrm:null }]);
INSN_TABLE.set('CMPSW', [{ op:[0xA7], ops:[], modrm:null }]);
INSN_TABLE.set('CMPSD', [{ op:[0xA7], ops:[], modrm:null }]);

// ── IRET ──
INSN_TABLE.set('IRET', [{ op:[0xCF], ops:[], modrm:null }]);
INSN_TABLE.set('IRETD', [{ op:[0xCF], ops:[], modrm:null }]);

// ── PUSHA / POPA ──
INSN_TABLE.set('PUSHA', [{ op:[0x60], ops:[], modrm:null }]);
INSN_TABLE.set('POPA', [{ op:[0x61], ops:[], modrm:null }]);
INSN_TABLE.set('PUSHAD', [{ op:[0x60], ops:[], modrm:null }]);
INSN_TABLE.set('POPAD', [{ op:[0x61], ops:[], modrm:null }]);

// ── JC (already in JCC_TABLE above) ──

// ═══════════════════════════════════════════════════════════════════════
// ASSEMBLER — multi-pass engine
// ═══════════════════════════════════════════════════════════════════════


// Extract numeric value from an argument that may be a plain number or {value,tokenStart,tokenEnd}
function argValue(arg) { return (typeof arg === 'object' && arg !== null) ? (arg.value || 0) : (arg || 0); }

// Re-evaluate an expression from its stored token range, using current assembly context
function reparseExpr(tokens, tokenStart, tokenEnd, ctx) {
  if (tokenStart === undefined || tokenEnd === undefined) return 0;
  // parseExpr now returns raw signed/unsigned values — no to32() needed
  return parseExpr(tokens, tokenStart, ctx).value;
}

function assemble(statements, tokens, opts) {
  const { bits, org } = opts;
  let defaultOperandSize = bits; // 16 or 32

  // Pass 1-N: resolve labels, compute sizes, converge
  const MAX_PASSES = 10;
  let prevOutput = null;
  let output = null;
  let labels = new Map();  // name → value
  let equValues = new Map(); // name → value (EQU constants)
  let sectionStart = 0;
  let passLabels = null;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const buf = [];
    // Seed labels from previous pass so forward references have tentative values
    labels = new Map(passLabels || []);
    let here = 0;
    let errorCount = 0;

    function emit(b) {
      if (typeof b === 'number') buf.push(b & 0xFF);
      else if (Array.isArray(b)) { for (const x of b) emit(x); }
      else if (b instanceof Uint8Array || Buffer.isBuffer(b)) {
        for (let i = 0; i < b.length; i++) buf.push(b[i]);
      }
    }

    function evalExpr(exprTokens, ctx) {
      // Dead code — kept as reference. Replaced by reparseExpr + token ranges.
      if (typeof exprTokens === 'number') return exprTokens;
      return 0;
    }

    for (const stmt of statements) {
      // Labels
      if (stmt.type === 'label') {
        // NASM: label value = current here (even if there's nothing after it)
        labels.set(stmt.name, here);
        continue;
      }

      // EQU — only on first pass (constant). Store raw value (no to32).
      if (stmt.type === 'directive' && stmt.dir === 'EQU') {
        if (pass === 0 && stmt.label) {
          equValues.set(stmt.label, argValue(stmt.args[0]));
        }
        continue;
      }

      // BITS — switch operand size
      if (stmt.type === 'directive' && stmt.dir === 'BITS') {
        defaultOperandSize = argValue(stmt.args[0]);
        continue;
      }

      // ORG — set origin. In flat binary, ORG does NOT emit padding.
      if (stmt.type === 'directive' && stmt.dir === 'ORG') {
        const newOrg = argValue(stmt.args[0]);
        here = newOrg;
        if (!sectionStart) sectionStart = newOrg;
        continue;
      }

      // ALIGN — pads with 0x90 (NOP) in code sections, 0x00 in data sections.
      // For flat binary with no explicit SECTION, the default is code section.
      if (stmt.type === 'directive' && stmt.dir === 'ALIGN') {
        const align = (argValue(stmt.args[0]) | 0);
        const fill = 0x90; // code section default (NASM uses NOP fill)
        while (here % align !== 0) { buf.push(fill); here++; }
        continue;
      }

      // TIMES — expand body N times with re-evaluated count each pass
      if (stmt.type === 'directive' && stmt.dir === 'TIMES') {
        const count = Math.max(0, reparseExpr(tokens, stmt.countTokenStart, stmt.countTokenEnd,
          { here, sectionStart, labels, equValues }));
        // Emit body 'count' times. Don't create copies — just re-process the body statements.
        for (let rep = 0; rep < count; rep++) {
          for (const bodyStmt of (stmt.body || [])) {
            // Process each body statement recursively
            if (bodyStmt.type === 'label') {
              labels.set(bodyStmt.name, here);
            } else if (bodyStmt.type === 'directive') {
              // Handle simple directives inline
              if (bodyStmt.dir === 'DB') {
                for (const arg of (bodyStmt.args || [])) {
                  const val = (arg.kind === 'expr') ? reparseExpr(tokens, arg.tokenStart, arg.tokenEnd, {here, sectionStart, labels, equValues}) : argValue(arg);
                  buf.push(val & 0xFF); here++;
                }
              } else if (bodyStmt.dir === 'DW') {
                for (const arg of (bodyStmt.args || [])) {
                  const val = (arg.kind === 'expr') ? reparseExpr(tokens, arg.tokenStart, arg.tokenEnd, {here, sectionStart, labels, equValues}) : argValue(arg);
                  buf.push(val & 0xFF, (val >>> 8) & 0xFF); here += 2;
                }
              } else if (bodyStmt.dir === 'DD') {
                for (const arg of (bodyStmt.args || [])) {
                  const val = (arg.kind === 'expr') ? reparseExpr(tokens, arg.tokenStart, arg.tokenEnd, {here, sectionStart, labels, equValues}) : argValue(arg);
                  buf.push(val & 0xFF, (val >>> 8) & 0xFF, (val >>> 16) & 0xFF, (val >>> 24) & 0xFF); here += 4;
                }
              } else if (bodyStmt.dir === 'DQ') {
                for (const arg of (bodyStmt.args || [])) {
                  const val = (arg.kind === 'expr') ? reparseExpr(tokens, arg.tokenStart, arg.tokenEnd, {here, sectionStart, labels, equValues}) : argValue(arg);
                  for (let b = 0; b < 8; b++) { buf.push((val >>> (b * 8)) & 0xFF); here++; }
                }
              }
            }
          }
        }
        continue;
      }

      // Data directives
      if (stmt.type === 'directive') {
        const { dir, args } = stmt;
        const sizes = { DB:1, DW:2, DD:4, DQ:8, DT:10 };
        if (sizes[dir]) {
          const esize = sizes[dir];
          for (const arg of args) {
            if (arg.kind === 'str') {
              for (let c = 0; c < arg.value.length; c++) {
                buf.push(arg.value.charCodeAt(c));
                here++;
              }
            } else if (arg.kind === 'expr') {
              // Re-evaluate expression — raw value (no to32)
              const val = (arg.tokenStart !== undefined)
                ? reparseExpr(tokens, arg.tokenStart, arg.tokenEnd, {here, sectionStart, labels, equValues})
                : (arg.value || 0);
              // For DQ/DT with raw text, use BigInt for full 64-bit precision
              const rawText = arg.text || '';
              if (esize >= 8 && rawText && typeof BigInt !== 'undefined') {
                let bigVal;
                try {
                  if (rawText.startsWith('0x')) bigVal = BigInt(rawText);
                  else if (rawText.startsWith('$')) bigVal = BigInt('0x' + rawText.slice(1));
                  else if (rawText.startsWith('0b')) bigVal = BigInt(rawText);
                  else bigVal = BigInt(val);
                } catch (_) { bigVal = BigInt(val); }
                for (let b = 0; b < esize; b++) {
                  buf.push(Number(bigVal & 0xFFn));
                  bigVal >>= 8n;
                  here++;
                }
              } else {
                for (let b = 0; b < esize; b++) {
                  buf.push((val >>> (b * 8)) & 0xFF);
                  here++;
                }
              }
            }
          }
          continue;
        }
        if (dir === 'RESB' || dir === 'RESW' || dir === 'RESD' || dir === 'RESQ') {
          const resSizes = { RESB:1, RESW:2, RESD:4, RESQ:8 };
          const esize = resSizes[dir];
          const count = (argValue(args[0]) || 0) * esize;
          for (let b = 0; b < count; b++) { buf.push(0); here++; }
          continue;
        }
        continue;
      }

      // Instruction
      if (stmt.type === 'insn') {
        const encodings = INSN_TABLE.get(stmt.mnemonic);
        if (!encodings) {
          console.error(`${opts.filename}: error: unrecognized mnemonic '${stmt.mnemonic}'`);
          errorCount++;
          continue;
        }

        // Re-evaluate operands once (shared by all encoding candidates)
        const resolvedOps = stmt.ops.map(op => {
          if (op.kind === 'farptr') {
            // Re-evaluate far pointer segment and offset — raw values (no to32)
            const seg = op.segTokenStart !== undefined
              ? reparseExpr(tokens, op.segTokenStart, op.segTokenEnd, {here, sectionStart, labels, equValues})
              : op.seg;
            const off = op.offTokenStart !== undefined
              ? reparseExpr(tokens, op.offTokenStart, op.offTokenEnd, {here, sectionStart, labels, equValues})
              : op.off;
            return { ...op, seg, off };
          }
          if (op.kind === 'mem' && op.parts) {
            // Resolve memory displacement: if single label token, look it up
            let disp = op.disp || 0;
            if (op.parts.length === 1 && op.parts[0].type === TOKEN.ID) {
              const name = op.parts[0].value;
              if (labels.has(name)) disp = labels.get(name);
              else if (equValues.has(name)) disp = equValues.get(name);
            }
            return { ...op, disp };
          }
          if (op.tokenStart !== undefined) {
            // reparseExpr returns raw value (signed or unsigned depending on context) — no to32()
            const val = reparseExpr(tokens, op.tokenStart, op.tokenEnd, {here, sectionStart, labels, equValues});
            return { ...op, value: val };
          }
          return op;
        });

        // Find best encoding: try all matches, pick shortest valid one
        let bestResult = null;
        for (const enc of encodings) {
          if (!matchOperands(stmt.ops, enc.ops, defaultOperandSize)) continue;
          const candidate = encodeInstruction(enc, resolvedOps, here, labels, equValues, sectionStart, defaultOperandSize);
          if (candidate.error) continue;
          if (!bestResult || candidate.bytes.length < bestResult.bytes.length) {
            bestResult = candidate;
          }
        }
        if (!bestResult) {
          console.error(`${opts.filename}: error: no valid encoding found for '${stmt.mnemonic}' with ${stmt.ops.length} operand(s)`);
          errorCount++;
          continue;
        }
        emit(bestResult.bytes);
        here += bestResult.bytes.length;
        continue;
      }
    }

    // Check convergence
    output = new Uint8Array(buf);
    if (prevOutput && output.length === prevOutput.length) {
      // Same size — check if labels stabilized too
      let stable = true;
      if (passLabels) {
        for (const [name, val] of labels) {
          if (passLabels.get(name) !== val) { stable = false; break; }
        }
      }
      if (stable) break;
    }
    prevOutput = output;
    passLabels = labels;

    if (errorCount > 0) {
      console.error(`${errorCount} errors during pass ${pass + 1}`);
      break;
    }
  }

  return output;
}

function matchOperands(ops, encOps, defaultSize) {
  if (ops.length !== encOps.length) return false;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const ek = encOps[i];

    switch (ek) {
      case OK.R8:
        if (op.kind !== 'reg' || op.bits !== 8 || op.seg || op.cr || op.dr) return false;
        break;
      case OK.R16:
        if (op.kind !== 'reg' || op.bits !== 16 || op.seg || op.cr || op.dr) return false;
        break;
      case OK.R32:
        if (op.kind !== 'reg' || op.bits !== 32 || op.seg || op.cr || op.dr) return false;
        break;
      case OK.RM8:
        if (op.kind === 'reg' && op.bits === 8 && !op.seg && !op.cr && !op.dr) break;
        if (op.kind === 'mem' && (!op.size || op.size === 'BYTE')) break;
        return false;
      case OK.RM16:
        if (op.kind === 'reg' && op.bits === 16 && !op.seg && !op.cr && !op.dr) break;
        if (op.kind === 'mem' && (!op.size || op.size === 'WORD')) break;
        return false;
      case OK.RM32:
        if (op.kind === 'reg' && op.bits === 32 && !op.seg && !op.cr && !op.dr) break;
        if (op.kind === 'mem' && (!op.size || op.size === 'DWORD')) break;
        return false;
      case OK.IMM8:
        if (op.kind === 'imm' || op.kind === 'str') break;
        return false;
      case OK.IMM16:
      case OK.IMM32:
        if (op.kind === 'imm' || op.kind === 'str') break;
        return false;
      case OK.SREG:
        if (op.kind === 'reg' && op.seg) break;
        return false;
      case OK.CR:
        if (op.kind === 'reg' && op.cr) break;
        return false;
      case OK.DR:
        if (op.kind === 'reg' && op.dr) break;
        return false;
      case OK.AL:
        if (op.kind === 'reg' && op.name === 'AL') break;
        return false;
      case OK.AX:
        if (op.kind === 'reg' && (op.name === 'AX' || op.name === 'EAX')) {
          // Register bit-width must match encoding's immediate width.
          // OK.AX is paired with either IMM16 or IMM32 in the encoding entry.
          // We check encOps[i+1] to enforce the match.
          const nextEk = encOps[i + 1];
          if (nextEk === OK.IMM16 && op.bits !== 16) return false;
          if (nextEk === OK.IMM32 && op.bits !== 32) return false;
          break;
        }
        return false;
      case OK.EAX:
        if (op.kind === 'reg' && op.name === 'EAX') break;
        return false;
      case OK.CL:
        if (op.kind === 'reg' && op.name === 'CL') break;
        return false;
      case OK.DX:
        if (op.kind === 'reg' && op.name === 'DX') break;
        return false;
      case OK.REL8:
      case OK.REL1632:
        if (op.kind === 'imm') break;
        return false;
      case OK.MEM:
        // Moffs forms (A0-A3) only match direct-address memory (no base/index regs)
        if (op.kind === 'mem' && !op.base && !op.index) break;
        return false;
      case OK.ONE:
        if (op.kind === 'imm' && op.value === 1) break;
        return false;
      case OK.FARPTR:
        if (op.kind === 'farptr') break;
        return false;
      default:
        return false;
    }
  }
  return true;
}

function encodeInstruction(enc, ops, here, labels, equValues, sectionStart, defaultSize) {
  const bytes = [];
  let opcodeDone = false;

  // Operand size prefix: 0x66 toggles default operand size (16↔32)
	// In BITS 16: instructions operate on 16-bit by default, 0x66 gives 32-bit
	// In BITS 32: instructions operate on 32-bit by default, 0x66 gives 16-bit
	// Exception: MOV Sreg,r/m has fixed 16-bit r/m — 0x66 prefix is illegal here
	let needOsizePrefix = false;
	const isSregDst = enc.ops[0] === OK.SREG;
	const hasCR = enc.ops.some(k => k === OK.CR);
	if (!isSregDst && !hasCR) {
	    for (const op of ops) {
	      if (op.kind === 'reg') {
	        if (op.bits === 32 && defaultSize === 16) needOsizePrefix = true;
	        if (op.bits === 16 && defaultSize === 32) needOsizePrefix = true;
	      }
	    }
	    if (enc.ops.some(k => k === OK.R32 || k === OK.RM32) && defaultSize === 16) needOsizePrefix = true;
	    if (enc.ops.some(k => k === OK.R16 || k === OK.RM16) && defaultSize === 32) needOsizePrefix = true;
	}

	if (needOsizePrefix) bytes.push(0x66);

  // Opcode
  const opBytes = [...enc.op];
  // If opReg, add register code to last opcode byte
  if (enc.opReg) {
    const regOp = ops.find(o => o.kind === 'reg');
    if (regOp) {
      opBytes[opBytes.length - 1] += (regOp.code & 0x07);
    }
  }
  // If opSeg, add segment register code to last opcode byte
  if (enc.opSeg) {
    const segOp = ops.find(o => o.kind === 'reg' && o.seg);
    if (segOp) {
      opBytes[opBytes.length - 1] += (segOp.code & 0x07);
    }
  }
  for (const b of opBytes) bytes.push(b);

  // ═══════════════════════════════════════════════════════════════════
  // ModR/M + SIB + displacement encoding
  // ═══════════════════════════════════════════════════════════════════

  // 16-bit addressing mode: rm field from (base, index) pair
  function encodeMem16(b, idx, disp, regCode) {
    let rm, mod = 0;
    const bn = b ? b.name : null;
    const in_ = idx ? idx.name : null;

    if (!bn && !in_) {
      // Direct address: mod=00, rm=110(6), disp16 follows
      return { modrm: ((regCode & 7) << 3) | 0x06,
               sib: null,
               dispBytes: [disp & 0xFF, (disp >>> 8) & 0xFF] };
    }

    // Lookup rm from (base, index) pair
    const rm16 = { 'BX_SI':0, 'BX_DI':1, 'BP_SI':2, 'BP_DI':3,
                   '_SI':4, '_DI':5, 'BP_':6, 'BX_':7 };
    const key = (bn || '') + '_' + (in_ || '');
    rm = rm16[key] !== undefined ? rm16[key] : 6;

    // mod field from displacement
    // Use signed value for range check (to32 would make negatives unsigned)
    const d = disp || 0;
    if (d !== 0) mod = (d >= -128 && d <= 127) ? 1 : 2;
    // [BP] without displacement: mod=00 is illegal (rm=110=direct address).
    // Force mod=1 with disp8=0.
    if (bn === 'BP' && !in_ && mod === 0) mod = 1;

    const dispBytes = [];
    if (mod === 1) dispBytes.push(d & 0xFF);
    else if (mod === 2) dispBytes.push(d & 0xFF, (d >>> 8) & 0xFF);

    return { modrm: (mod << 6) | ((regCode & 7) << 3) | rm,
             sib: null, dispBytes };
  }

  // 32-bit addressing mode
  function encodeMem32(b, idx, scale, disp, regCode) {
    let rm, mod = 0, sib = null;
    // Use signed value for range check
    const dRaw = disp || 0;
    if (dRaw !== 0) mod = (dRaw >= -128 && dRaw <= 127) ? 1 : 2;

    if (!b && !idx) {
      // Direct address: mod=00, rm=101(5), disp32
      const du = to32(dRaw);
      return { modrm: ((regCode & 7) << 3) | 0x05, sib: null,
               dispBytes: [du & 0xFF, (du >>> 8) & 0xFF, (du >>> 16) & 0xFF, (du >>> 24) & 0xFF] };
    }

    // NASM optimization: [idx*2] → [idx + idx*1] to avoid disp32
    if (!b && idx && scale === 2) {
      b = idx; // duplicate index as base
      scale = 1;
    }

    // [EBP] or SIB.base=5 with mod=00 means "no base, disp32".
    // Force mod=1 with disp8=0 when EBP is actually the base with no disp.
    if (b && b.code === 5 && mod === 0 && dRaw === 0) mod = 1;

    if (b && !idx) {
      // Base-only
      if (b.code === 4) {
        // ESP requires SIB (no direct rm encoding for ESP base-only)
        rm = 4; sib = (0 << 6) | (4 << 3) | 4;
      } else {
        rm = b.code;
      }
    } else {
      // Has index (and optionally base): SIB required
      rm = 4;
      const sc = scale || 1;
      const scBits = sc === 2 ? 1 : sc === 4 ? 2 : sc === 8 ? 3 : 0;
      const idxCode = idx ? (idx.code & 7) : 4;
      const baseCode = b ? (b.code & 7) : 5;
      sib = (scBits << 6) | (idxCode << 3) | baseCode;
      if (!b) mod = 0; // no base: disp32 follows
    }

    const du = to32(dRaw);
    const dispBytes = [];
    if (mod === 1) dispBytes.push(du & 0xFF);
    else if (mod === 2) dispBytes.push(du & 0xFF, (du >>> 8) & 0xFF, (du >>> 16) & 0xFF, (du >>> 24) & 0xFF);
    else if (mod === 0 && rm === 4 && sib !== null && (sib & 7) === 5)
      dispBytes.push(du & 0xFF, (du >>> 8) & 0xFF, (du >>> 16) & 0xFF, (du >>> 24) & 0xFF);

    return { modrm: (mod << 6) | ((regCode & 7) << 3) | rm, sib, dispBytes };
  }

  // ── Build ModR/M byte ──
  if (enc.modrm) {
    let modrm = 0, sib = null, dispBytes = [];

    // reg field (bits 5-3). r1/r2 are 1-indexed operand references.
    let regCode = enc.modrmReg !== undefined ? (enc.modrmReg & 7) : 0;
    if (enc.modrm.includes('reg=')) {
      const m = enc.modrm.match(/reg=r(\d)/);
      if (m) {
        const opIdx = parseInt(m[1]) - 1;
        const op = ops[opIdx];
        if (op && op.kind === 'reg') regCode = (op.code || 0) & 7;
      }
    }

    // rm field (bits 2-0)
    if (enc.modrm.includes('rm=')) {
      const m = enc.modrm.match(/rm=r(\d)/);
      if (m) {
        const opIdx = parseInt(m[1]) - 1;
        const op = ops[opIdx];
        if (op && op.kind === 'reg') {
          // Register-direct: mod=11, reg from regCode, rm from register code
          modrm = 0xC0 | ((regCode & 7) << 3) | ((op.code || 0) & 7);
        } else if (op && op.kind === 'mem') {
          const dp = op.disp || 0; // signed value — encodeMem* handles to32 internally
          const r = defaultSize === 16
            ? encodeMem16(op.base, op.index, dp, regCode)
            : encodeMem32(op.base, op.index, op.scale, dp, regCode);
          modrm = r.modrm; sib = r.sib; dispBytes = r.dispBytes;
        } else if (op && op.kind === 'imm') {
          // Direct address (moffs-like)
          const v = to32(op.value || 0);
          if (defaultSize === 16) {
            modrm = ((regCode & 7) << 3) | 0x06;
            dispBytes = [v & 0xFF, (v >>> 8) & 0xFF];
          } else {
            modrm = ((regCode & 7) << 3) | 0x05;
            dispBytes = [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
          }
        }
      }
    } else {
      modrm = (regCode & 7) << 3;
    }

    bytes.push(modrm & 0xFF);
    if (sib !== null) bytes.push(sib & 0xFF);
    for (const b of dispBytes) bytes.push(b);
  } else {
    // No ModR/M — check for moffs/direct-address memory operand (A0-A3 forms)
    const memOpMoffs = ops.find(o => o.kind === 'mem' && !o.base && !o.index);
    if (memOpMoffs) {
      const addr = to32(memOpMoffs.disp || 0);
      if (defaultSize === 16) {
        bytes.push(addr & 0xFF, (addr >>> 8) & 0xFF);
      } else {
        bytes.push(addr & 0xFF, (addr >>> 8) & 0xFF, (addr >>> 16) & 0xFF, (addr >>> 24) & 0xFF);
      }
    }
  }

  // Immediate and relative displacements
  for (let i = 0; i < enc.ops.length; i++) {
    const ek = enc.ops[i];
    const op = ops[i];

    if (ek === OK.REL8) {
      // 8-bit signed relative displacement
      const target = to32(op.value);
      const instrLen = bytes.length + 1; // +1 for the disp8 byte itself
      const disp = (target - (here + instrLen)) | 0; // signed 32-bit
      // Must fit in signed 8-bit [-128, 127]
      if (disp < -128 || disp > 127) return { error: 'rel8 overflow' };
      bytes.push(disp & 0xFF);
    } else if (ek === OK.REL1632) {
      // 16-bit or 32-bit signed relative displacement
      const target = to32(op.value);
      const dispSize = defaultSize === 16 ? 2 : 4;
      const instrLen = bytes.length + dispSize;
      const disp = to32(target - (here + instrLen));
      if (dispSize === 2) {
        bytes.push(disp & 0xFF, (disp >>> 8) & 0xFF);
      } else {
        bytes.push(disp & 0xFF, (disp >>> 8) & 0xFF, (disp >>> 16) & 0xFF, (disp >>> 24) & 0xFF);
      }
    } else if (ek === OK.IMM8) {
      const v = to32(op.value);
      // For sign-extended imm8 forms (opcode 0x83), value must fit in signed byte.
      // Use signed 32-bit interpretation: (v | 0) converts to signed int.
      if (enc.op[0] === 0x83) {
        const sv = v | 0;
        if (sv < -128 || sv > 127) return { error: 'imm8 sign-extended overflow' };
      }
      bytes.push(v & 0xFF);
    } else if (ek === OK.IMM16) {
      const v = to32(op.value);
      bytes.push(v & 0xFF, (v >>> 8) & 0xFF);
    } else if (ek === OK.IMM32) {
      const v = to32(op.value);
      bytes.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
    } else if (ek === OK.FARPTR) {
      // Far pointer: offset first, then segment
      const off = to32(op.off);
      const seg = to32(op.seg) & 0xFFFF;
      if (defaultSize === 16) {
        bytes.push(off & 0xFF, (off >>> 8) & 0xFF);
      } else {
        bytes.push(off & 0xFF, (off >>> 8) & 0xFF, (off >>> 16) & 0xFF, (off >>> 24) & 0xFF);
      }
      bytes.push(seg & 0xFF, (seg >>> 8) & 0xFF);
    }
  }

  return { bytes };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// PREPROCESSOR — %define substitution (source-text level, pre-tokenizer)
// ═══════════════════════════════════════════════════════════════════════

function preprocess(src) {
  const defines = new Map(); // name → replacement text
  const lines = src.split('\n');
  const result = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.trimStart();

    // %define NAME value
    const dm = trimmed.match(/^%define\s+([a-zA-Z_?@][a-zA-Z0-9_$#~.?@]*)\s+(.*)$/);
    if (dm) {
      defines.set(dm[1], dm[2].trim());
      result.push(''); // preserve line numbering
      continue;
    }

    // Skip other % directives silently (preserve line count)
    if (trimmed.startsWith('%')) {
      result.push('');
      continue;
    }

    // Substitute defines — split on string quotes, only replace outside strings
    let processed = line;
    if (defines.size > 0) {
      // Split by string delimiters: even segments = outside strings, odd = inside
      const segments = processed.split(/('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/);
      for (let s = 0; s < segments.length; s++) {
        // Even indices are outside strings; odd are string contents
        if (s % 2 === 0) {
          for (const [name, replacement] of defines) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('\\b' + escaped + '\\b', 'g');
            segments[s] = segments[s].replace(re, replacement);
          }
        }
      }
      processed = segments.join('');
    }
    result.push(processed);
  }
  return result.join('\n');
}

function main() {
  const cli = parseCli(process.argv);
  const fs = require('fs');
  const path = require('path');

  const rawSrc = fs.readFileSync(cli.input, 'utf8');
  const filename = path.basename(cli.input);

  // Preprocess %define macros (word-boundary substitution, skip inside strings)
  const src = preprocess(rawSrc);

  // Tokenize
  const tokens = tokenize(src, filename);

  // Parse
  const statements = parse(tokens, filename);

  // Determine BITS from statements (default 16)
  let bits = 16;
  let org = 0;
  for (const stmt of statements) {
    if (stmt.type === 'directive' && stmt.dir === 'BITS') {
      bits = stmt.args[0];
      break;
    }
    if (stmt.type === 'directive' && stmt.dir === 'ORG') {
      org = stmt.args[0];
    }
  }

  // Assemble
  const output = assemble(statements, tokens, { bits, org, filename });

  // Write output
  if (cli.output) {
    fs.writeFileSync(cli.output, output);
  } else {
    // Write to stdout
    process.stdout.write(Buffer.from(output));
  }
}

main();
