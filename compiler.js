#!/usr/bin/env node
(() => {
"use strict";

// ====================
// Lexer
// ====================

const Lexer = (() => {

// String interning - returns the same string reference for equal strings
const internPool = new Map();
function intern(str) {
  let s = internPool.get(str);
  if (s !== undefined) return s;
  internPool.set(str, str);
  return str;
}

// Token kinds
const TokenKind = Object.freeze({
  EOS: "EOS",
  NEWLINE: "NEWLINE",
  IDENT: "IDENT",
  PP_NUMBER: "PP_NUMBER",
  STRING: "STRING",
  CHAR: "CHAR",
  PUNCT: "PUNCT",
  KEYWORD: "KEYWORD",
  INT: "INT",
  FLOAT: "FLOAT",
  PLACEMARKER: "PLACEMARKER",
});

// Keywords
const Keyword = Object.freeze({
  AUTO: "auto",
  BREAK: "break",
  CASE: "case",
  CHAR: "char",
  CONST: "const",
  CONTINUE: "continue",
  DEFAULT: "default",
  DO: "do",
  DOUBLE: "double",
  ELSE: "else",
  ENUM: "enum",
  EXTERN: "extern",
  FLOAT: "float",
  FOR: "for",
  GOTO: "goto",
  IF: "if",
  INT: "int",
  LONG: "long",
  REGISTER: "register",
  RETURN: "return",
  SHORT: "short",
  SIGNED: "signed",
  SIZEOF: "sizeof",
  STATIC: "static",
  STRUCT: "struct",
  SWITCH: "switch",
  TYPEDEF: "typedef",
  UNION: "union",
  UNSIGNED: "unsigned",
  VOID: "void",
  VOLATILE: "volatile",
  WHILE: "while",
  // C99
  INLINE: "inline",
  RESTRICT: "restrict",
  // C11
  GENERIC: "_Generic",
  STATIC_ASSERT: "_Static_assert",
  NORETURN: "_Noreturn",
  ALIGNOF: "_Alignof",
  ALIGNAS: "_Alignas",
  THREAD_LOCAL: "_Thread_local",
  // C23
  TYPEOF: "typeof",
  TYPEOF_UNQUAL: "typeof_unqual",
  // Extensions
  BOOL: "_Bool",
  X_IMPORT: "__import",
  X_BUILTIN_VA_START: "__builtin_va_start",
  X_BUILTIN_VA_ARG: "__builtin_va_arg",
  X_BUILTIN_VA_END: "__builtin_va_end",
  X_BUILTIN_VA_COPY: "__builtin_va_copy",
  X_BUILTIN_UNREACHABLE: "__builtin_unreachable",
  X_BUILTIN_ABORT: "__builtin_abort",
  X_BUILTIN_EXPECT: "__builtin_expect",
  X_MEMORY_SIZE: "__memory_size",
  X_MEMORY_GROW: "__memory_grow",
  X_BUILTIN: "__builtin",
  X_ATTRIBUTE: "__attribute__",
  X_REQUIRE_SOURCE: "__require_source",
  X_EXPORT: "__export",
  X_MINSTACK: "__minstack",
  X_WASM: "__wasm",
  X_EXCEPTION: "__exception",
  X_TRY: "__try",
  X_CATCH: "__catch",
  X_THROW: "__throw",
  X_EXTERNREF: "__externref",
  X_REFEXTERN: "__refextern",
  X_STRUCT_GC: "__struct",
  X_ARRAY_GC: "__array",
  X_STRUCT_NEW: "__struct_new",
  X_NEW: "__new",
  X_ARRAY_NEW: "__array_new",
  X_REF_IS_NULL: "__ref_is_null",
  X_REF_EQ: "__ref_eq",
  X_REF_NULL: "__ref_null",
  X_REF_TEST: "__ref_test",
  X_REF_TEST_NULL: "__ref_test_null",
  X_ARRAY_LEN: "__array_len",
  X_ARRAY_OF: "__array_of",
  X_EXTENDS: "__extends",
  X_REF_CAST: "__ref_cast",
  X_REF_CAST_NULL: "__ref_cast_null",
  X_ARRAY_FILL: "__array_fill",
  X_ARRAY_COPY: "__array_copy",
  X_EQREF: "__eqref",
  X_REF_AS_EXTERN: "__ref_as_extern",
  X_REF_AS_EQ: "__ref_as_eq",
  X_CAST: "__cast",
});

// Punctuation
const Punct = Object.freeze({
  // Single-character
  LBRACK: 0, RBRACK: 1, LPAREN: 2, RPAREN: 3, LBRACE: 4, RBRACE: 5,
  DOT: 6, AMP: 7, STAR: 8, PLUS: 9, MINUS: 10, TILDE: 11,
  BANG: 12, SLASH: 13, PCT: 14, LT: 15, GT: 16, CARET: 17,
  PIPE: 18, QMARK: 19, COLON: 20, SEMI: 21, EQ: 22, COMMA: 23, HASH: 24,
  // Two-character
  ARROW: 25, PLUSPLUS: 26, MINUSMINUS: 27, LSHIFT: 28, RSHIFT: 29,
  LE: 30, GE: 31, EQEQ: 32, NE: 33, AMPAMP: 34, PIPEPIPE: 35,
  STAR_EQ: 36, SLASH_EQ: 37, PCT_EQ: 38, PLUS_EQ: 39, MINUS_EQ: 40,
  AMP_EQ: 41, CARET_EQ: 42, PIPE_EQ: 43, HASH_HASH: 44,
  // Three-character
  LSHIFT_EQ: 45, RSHIFT_EQ: 46, ELLIPSIS: 47,
});

// String prefix for string/char literals
const StringPrefix = Object.freeze({
  NONE: 0,
  PREFIX_L: 1,
  PREFIX_u: 2,
  PREFIX_U: 3,
  PREFIX_u8: 4,
});

class TokenFlags {
  constructor() {
    this.atBol = false;
    this.hasSpace = false;
    this.isUnsigned = false;
    this.isLong = false;
    this.isLongLong = false;
    this.isFloat = false;
    this.isDecimal = false;
    this.stringPrefix = StringPrefix.NONE;
    Object.seal(this);
  }
}

// Loc — source location with start/end span.
//
// Back-compat: .line/.column/.filename getters delegate to .start, so legacy
// reads (e.g. `loc.line`) still work after construction sites switch from
// plain `{filename,line}` literals to Loc instances.
class Loc {
  constructor(filename, startLine, startColumn, endLine, endColumn) {
    this.filename = filename;
    this.start = { line: startLine || 0, column: startColumn || 0 };
    this.end = {
      line: endLine || startLine || 0,
      column: endColumn || startColumn || 0,
    };
    Object.freeze(this.start);
    Object.freeze(this.end);
    Object.freeze(this);
  }
  get line() { return this.start.line; }
  get column() { return this.start.column; }
  static fromTok(tok) {
    if (!tok) return new Loc('<generated>', 0, 0, 0, 0);
    const col = tok.column || 0;
    return new Loc(tok.filename || '<generated>', tok.line || 0, col, tok.line || 0, col);
  }
  static generated() { return new Loc('<generated>', 0, 0, 0, 0); }
  // Span over additional locs. All must share the same filename.
  join(...locs) {
    let start = this.start, end = this.end;
    for (const o of locs) {
      if (!o) continue;
      if (o.filename !== this.filename) continue; // ignore foreign locs
      if (o.start.line < start.line || (o.start.line === start.line && o.start.column < start.column)) start = o.start;
      if (o.end.line > end.line || (o.end.line === end.line && o.end.column > end.column)) end = o.end;
    }
    return new Loc(this.filename, start.line, start.column, end.line, end.column);
  }
}

class Token {
  constructor(filename, line, column, kind, text) {
    this.filename = filename;
    this.line = line;
    this.column = column;
    this.kind = kind;
    this.text = text;
    // Value union — only one is meaningful depending on kind
    this.integer = 0; // BigInt for INT tokens (set during post-processing)
    this.floating = 0; // number for FLOAT tokens
    this.keyword = null; // Keyword value for KEYWORD tokens
    this.punct = 0; // Punct value for PUNCT tokens
    this.flags = new TokenFlags();
    Object.seal(this);
  }

  atIdent(ident) {
    return this.kind === TokenKind.IDENT && this.text === ident;
  }

  atPunct(p) {
    return this.kind === TokenKind.PUNCT && this.punct === p;
  }

  atKeyword(kw) {
    return this.kind === TokenKind.KEYWORD && this.keyword === kw;
  }
}

class LexError {
  constructor(message, filename, line) {
    this.message = message;
    this.filename = filename;
    this.line = line;
    Object.seal(this);
  }
}

class LexResult {
  constructor() {
    this.tokens = [];
    this.errors = [];
    this.warnings = [];
    Object.seal(this);
  }
}

// Character classification helpers (string-based, used outside lexer)
function isSpace(c) {
  return c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "\n";
}

function isIdentStart(c) {
  return (
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$"
  );
}

function isDigit(c) {
  return c >= "0" && c <= "9";
}

function isIdentPart(c) {
  return isIdentStart(c) || isDigit(c);
}

function isPpNumberPart(c) {
  return isIdentPart(c) || c === ".";
}

// Byte-based classification helpers (used in lexer on Uint8Array)
function isSpaceB(b) {
  return b === 0x20 || b === 0x09 || b === 0x0D || b === 0x0C || b === 0x0B || b === 0x0A;
  //       space       tab         \r          \f          \v          \n
}
function isIdentStartB(b) {
  return (b >= 0x61 && b <= 0x7A) || (b >= 0x41 && b <= 0x5A) || b === 0x5F || b === 0x24;
  //       a-z                        A-Z                        _           $
}
function isDigitB(b) { return b >= 0x30 && b <= 0x39; }
function isIdentPartB(b) { return isIdentStartB(b) || isDigitB(b); }
function isPpNumberPartB(b) { return isIdentPartB(b) || b === 0x2E; /* . */ }

function isxdigit(c) {
  return (
    (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")
  );
}

function hexVal(c) {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 0x30;
  if (c >= "a" && c <= "f") return 10 + c.charCodeAt(0) - 0x61;
  if (c >= "A" && c <= "F") return 10 + c.charCodeAt(0) - 0x41;
  return 0;
}

// ====================
// Raw lexer (phase 1)
// ====================

function lex(filename, source, lineOffsets) {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const bytes = textEncoder.encode(source);
  const n = bytes.length;
  const result = new LexResult();
  let i = 0,
    line = 1;
  let lineStart = 0; // byte index of start of current line
  let j = 0; // token start byte index
  let savedLine = 1,
    savedColumn = 1;
  let lastTokenWasNewline = true;
  let bol = true,
    space = false;
  // lineOffsets, if provided, maps a spliced-byte-offset to "how many
  // extra original-source lines were swallowed by `\<NL>` splices up to
  // that point". We add this to savedLine when emitting each token so
  // diagnostics report the line in the un-spliced source.
  const _lineOffsets = lineOffsets || null;

  function decodeText(start, end) {
    return textDecoder.decode(bytes.subarray(start, end));
  }

  function mark() {
    j = i;
    savedLine = line;
    savedColumn = i - lineStart + 1;
  }

  function peek(k = 0) {
    return i + k < n ? bytes[i + k] : 0;
  }

  // Byte constants for readability
  const NL = 0x0A, CR = 0x0D, TAB = 0x09, SPC = 0x20;
  const SLASH = 0x2F, STAR = 0x2A, HASH = 0x23, BSLASH = 0x5C;
  const DQUOTE = 0x22, SQUOTE = 0x27, DOT = 0x2E;
  const LT = 0x3C, GT = 0x3E, EQ = 0x3D, BANG = 0x21;
  const PLUS = 0x2B, MINUS = 0x2D, AMP = 0x26, PIPE = 0x7C;
  const CARET = 0x5E, PCT = 0x25, TILDE = 0x7E, QMARK = 0x3F;
  const COLON = 0x3A, SEMI = 0x3B, COMMA = 0x2C;
  const LPAREN = 0x28, RPAREN = 0x29, LBRACK = 0x5B, RBRACK = 0x5D;
  const LBRACE = 0x7B, RBRACE = 0x7D;
  const CH_L = 0x4C, CH_U = 0x55, CH_u = 0x75, CH_8 = 0x38;
  const CH_e = 0x65, CH_E = 0x45, CH_p = 0x70, CH_P = 0x50;

  function isPunctByte(b) {
    switch (b) {
      case LBRACK: case RBRACK: case LPAREN: case RPAREN:
      case LBRACE: case RBRACE: case DOT: case AMP:
      case STAR: case PLUS: case MINUS: case TILDE:
      case BANG: case SLASH: case PCT: case LT:
      case GT: case CARET: case PIPE: case QMARK:
      case COLON: case SEMI: case EQ: case COMMA:
      case HASH:
        return true;
      default: return false;
    }
  }
  function tryPunct() {
    let p, len = 1;
    switch (peek()) {
      case LBRACK: p = Punct.LBRACK; break;
      case RBRACK: p = Punct.RBRACK; break;
      case LPAREN: p = Punct.LPAREN; break;
      case RPAREN: p = Punct.RPAREN; break;
      case LBRACE: p = Punct.LBRACE; break;
      case RBRACE: p = Punct.RBRACE; break;
      case TILDE: p = Punct.TILDE; break;
      case QMARK: p = Punct.QMARK; break;
      case SEMI: p = Punct.SEMI; break;
      case COMMA: p = Punct.COMMA; break;
      case DOT:
        if (peek(1) === DOT && peek(2) === DOT) { p = Punct.ELLIPSIS; len = 3; }
        else { p = Punct.DOT; }
        break;
      case PLUS:
        if (peek(1) === PLUS) { p = Punct.PLUSPLUS; len = 2; }
        else if (peek(1) === EQ) { p = Punct.PLUS_EQ; len = 2; }
        else { p = Punct.PLUS; }
        break;
      case MINUS:
        if (peek(1) === GT) { p = Punct.ARROW; len = 2; }
        else if (peek(1) === MINUS) { p = Punct.MINUSMINUS; len = 2; }
        else if (peek(1) === EQ) { p = Punct.MINUS_EQ; len = 2; }
        else { p = Punct.MINUS; }
        break;
      case STAR:
        if (peek(1) === EQ) { p = Punct.STAR_EQ; len = 2; }
        else { p = Punct.STAR; }
        break;
      case SLASH:
        if (peek(1) === EQ) { p = Punct.SLASH_EQ; len = 2; }
        else { p = Punct.SLASH; }
        break;
      case PCT:
        if (peek(1) === EQ) { p = Punct.PCT_EQ; len = 2; }
        else { p = Punct.PCT; }
        break;
      case LT:
        if (peek(1) === LT) {
          if (peek(2) === EQ) { p = Punct.LSHIFT_EQ; len = 3; }
          else { p = Punct.LSHIFT; len = 2; }
        } else if (peek(1) === EQ) { p = Punct.LE; len = 2; }
        else { p = Punct.LT; }
        break;
      case GT:
        if (peek(1) === GT) {
          if (peek(2) === EQ) { p = Punct.RSHIFT_EQ; len = 3; }
          else { p = Punct.RSHIFT; len = 2; }
        } else if (peek(1) === EQ) { p = Punct.GE; len = 2; }
        else { p = Punct.GT; }
        break;
      case EQ:
        if (peek(1) === EQ) { p = Punct.EQEQ; len = 2; }
        else { p = Punct.EQ; }
        break;
      case BANG:
        if (peek(1) === EQ) { p = Punct.NE; len = 2; }
        else { p = Punct.BANG; }
        break;
      case AMP:
        if (peek(1) === AMP) { p = Punct.AMPAMP; len = 2; }
        else if (peek(1) === EQ) { p = Punct.AMP_EQ; len = 2; }
        else { p = Punct.AMP; }
        break;
      case PIPE:
        if (peek(1) === PIPE) { p = Punct.PIPEPIPE; len = 2; }
        else if (peek(1) === EQ) { p = Punct.PIPE_EQ; len = 2; }
        else { p = Punct.PIPE; }
        break;
      case CARET:
        if (peek(1) === EQ) { p = Punct.CARET_EQ; len = 2; }
        else { p = Punct.CARET; }
        break;
      case COLON: p = Punct.COLON; break;
      case HASH:
        if (peek(1) === HASH) { p = Punct.HASH_HASH; len = 2; }
        else { p = Punct.HASH; }
        break;
      default: return false;
    }
    mark();
    advance(len);
    addToken(TokenKind.PUNCT);
    result.tokens[result.tokens.length - 1].punct = p;
    return true;
  }

  function advance(count = 1) { i += count; }
  function advanceLine() { ++line; lineStart = i; }

  function addToken(kind, textOverride) {
    const adjLine = _lineOffsets ? savedLine + lineOffsetAt(_lineOffsets, j) : savedLine;
    const tok = new Token(
      filename,
      adjLine,
      savedColumn,
      kind,
      textOverride !== undefined ? textOverride : decodeText(j, i)
    );
    tok.flags.atBol = bol;
    tok.flags.hasSpace = space;
    result.tokens.push(tok);
    lastTokenWasNewline = kind === TokenKind.NEWLINE;
    bol = false;
    space = false;
  }

  while (i < n && result.errors.length === 0) {
    // Whitespace and comments
    if (bytes[i] === NL && !lastTokenWasNewline) {
      mark();
      addToken(TokenKind.NEWLINE);
      advance();
      advanceLine();
      bol = true;
      space = false;
      continue;
    }
    if (isSpaceB(bytes[i])) {
      if (bytes[i] === NL) { advance(); advanceLine(); }
      else { advance(); }
      space = true;
      continue;
    }
    if (peek() === SLASH && peek(1) === SLASH) {
      while (i < n && bytes[i] !== NL) {
        advance();
      }
      continue;
    }
    if (peek() === SLASH && peek(1) === STAR) {
      advance(2);
      while (i < n && !(peek() === STAR && peek(1) === SLASH)) {
        if (bytes[i] === NL) { advance(); advanceLine(); }
        else { advance(); }
      }
      if (i < n) {
        advance(2);
      } else {
        result.errors.push(
          new LexError("Unterminated comment", filename, line)
        );
      }
      continue;
    }

    mark();

    // String and character literals (including prefixed: L, u, U, u8)
    {
      let prefix = StringPrefix.NONE;
      let isLiteral = false;
      if (bytes[i] === DQUOTE || bytes[i] === SQUOTE) {
        isLiteral = true;
      } else if (bytes[i] === CH_L && (peek(1) === DQUOTE || peek(1) === SQUOTE)) {
        prefix = StringPrefix.PREFIX_L;
        advance();
        isLiteral = true;
      } else if (bytes[i] === CH_U && (peek(1) === DQUOTE || peek(1) === SQUOTE)) {
        prefix = StringPrefix.PREFIX_U;
        advance();
        isLiteral = true;
      } else if (bytes[i] === CH_u) {
        if (peek(1) === SQUOTE || peek(1) === DQUOTE) {
          prefix = StringPrefix.PREFIX_u;
          advance();
          isLiteral = true;
        } else if (peek(1) === CH_8 && peek(2) === DQUOTE) {
          prefix = StringPrefix.PREFIX_u8;
          advance(2);
          isLiteral = true;
        }
      }
      if (isLiteral) {
        const quoteChar = bytes[i];
        if (prefix === StringPrefix.PREFIX_u8 && quoteChar === SQUOTE) {
          result.errors.push(
            new LexError(
              "u8 prefix is not valid for character literals",
              filename,
              line
            )
          );
        }
        advance();
        while (i < n && bytes[i] !== quoteChar) {
          if (bytes[i] === BSLASH) {
            advance(2);
          } else {
            advance();
          }
        }
        if (i < n) {
          advance(); // closing " or '
          const kind =
            quoteChar === DQUOTE ? TokenKind.STRING : TokenKind.CHAR;
          addToken(kind);
          result.tokens[result.tokens.length - 1].flags.stringPrefix = prefix;
        } else {
          result.errors.push(
            new LexError("Unterminated string literal", filename, line)
          );
        }
        continue;
      }
    }

    // Identifiers
    if (isIdentStartB(bytes[i])) {
      advance();
      while (isIdentPartB(peek())) {
        advance();
      }
      addToken(TokenKind.IDENT);
      continue;
    }

    // Preprocessor numbers
    if (isDigitB(bytes[i]) || (bytes[i] === DOT && isDigitB(peek(1)))) {
      advance();
      while (isPpNumberPartB(peek())) {
        const c1 = peek();
        const c2 = peek(1);
        if (
          (c1 === CH_e || c1 === CH_E || c1 === CH_p || c1 === CH_P) &&
          (c2 === PLUS || c2 === MINUS)
        ) {
          advance();
        }
        advance();
      }
      addToken(TokenKind.PP_NUMBER);
      continue;
    }

    // C99 digraphs
    {
      const d0 = peek(),
        d1 = peek(1);
      let handled = false;
      function addDigraph(len, canon, punctId) {
        advance(len);
        const tok = new Token(
          filename,
          savedLine,
          savedColumn,
          TokenKind.PUNCT,
          canon
        );
        tok.flags.atBol = bol;
        tok.flags.hasSpace = space;
        tok.punct = punctId;
        result.tokens.push(tok);
        lastTokenWasNewline = false;
        bol = false;
        space = false;
        handled = true;
      }
      if (d0 === PCT && d1 === COLON) {
        if (peek(2) === PCT && peek(3) === COLON) {
          addDigraph(4, "##", Punct.HASH_HASH);
        } else {
          addDigraph(2, "#", Punct.HASH);
        }
      } else if (d0 === LT && d1 === COLON) {
        addDigraph(2, "[", Punct.LBRACK);
      } else if (d0 === LT && d1 === PCT) {
        addDigraph(2, "{", Punct.LBRACE);
      } else if (d0 === COLON && d1 === GT) {
        addDigraph(2, "]", Punct.RBRACK);
      } else if (d0 === PCT && d1 === GT) {
        addDigraph(2, "}", Punct.RBRACE);
      }
      if (handled) continue;
    }

    // Punctuation
    if (tryPunct()) continue;

    // Unknown character
    let msg = "Unexpected character: '";
    while (i < n && !isSpaceB(bytes[i]) && !isPunctByte(bytes[i])) {
      msg += String.fromCharCode(bytes[i]);
      advance();
    }
    msg += "'";
    result.errors.push(new LexError(msg, filename, line));
  }

  mark();
  addToken(TokenKind.EOS);

  return result;
}

// ====================
// Escape sequence helpers
// ====================

// Unescape one character from a string/char literal.
// `pos` is an object { i: number } used as a mutable cursor into `text`.
// Returns the unescaped byte value (0-255 for narrow, codepoint for wide).
function unescape(text, pos, end) {
  if (pos.i >= end) return 0;

  if (text[pos.i] === "\\") {
    pos.i++; // skip backslash
    if (pos.i >= end) return 0;

    switch (text[pos.i]) {
      case "n":
        pos.i++;
        return 0x0a;
      case "t":
        pos.i++;
        return 0x09;
      case "r":
        pos.i++;
        return 0x0d;
      case "b":
        pos.i++;
        return 0x08;
      case "f":
        pos.i++;
        return 0x0c;
      case "v":
        pos.i++;
        return 0x0b;
      case "a":
        pos.i++;
        return 0x07;
      case "\\":
        pos.i++;
        return 0x5c;
      case "'":
        pos.i++;
        return 0x27;
      case '"':
        pos.i++;
        return 0x22;
      case "x": {
        // Hex: \xHH... (greedy per C11 standard)
        pos.i++;
        let val = 0;
        while (pos.i < end && isxdigit(text[pos.i])) {
          val = (val << 4) | hexVal(text[pos.i++]);
        }
        return val;
      }
      case "u": // \uXXXX
      case "U": {
        // \UXXXXXXXX
        const len = text[pos.i] === "u" ? 4 : 8;
        pos.i++;
        let val = 0;
        for (let k = 0; k < len && pos.i < end && isxdigit(text[pos.i]); ++k) {
          val = (val << 4) | hexVal(text[pos.i++]);
        }
        return val;
      }
      default:
        // Octal: \0, \012, \377, etc.
        if (text[pos.i] >= "0" && text[pos.i] <= "7") {
          let val = text.charCodeAt(pos.i++) - 0x30;
          for (
            let k = 0;
            k < 2 && pos.i < end && text[pos.i] >= "0" && text[pos.i] <= "7";
            ++k
          ) {
            val = (val << 3) | (text.charCodeAt(pos.i++) - 0x30);
          }
          return val;
        }
        // Fallback for unknown escapes
        return text.charCodeAt(pos.i++);
    }
  }

  // Raw character (may be multi-byte for non-ASCII)
  const cp = text.codePointAt(pos.i);
  pos.i += cp > 0xffff ? 2 : 1;
  return cp;
}

// Decode one UTF-8 codepoint from a string (JavaScript strings are UTF-16,
// so we use codePointAt which handles surrogate pairs).
function decodeCodepoint(text, pos, end) {
  if (pos.i >= end) return 0;
  const cp = text.codePointAt(pos.i);
  // Advance past the code point (may be 2 UTF-16 code units for astral planes)
  pos.i += cp > 0xffff ? 2 : 1;
  return cp;
}

// Unescape one character/codepoint from a string literal.
// For escape sequences, delegates to unescape().
// For raw source characters, decodes a full codepoint.
function unescapeCodepoint(text, pos, end) {
  if (text[pos.i] === "\\") return unescape(text, pos, end);
  return decodeCodepoint(text, pos, end);
}

// Encode a Unicode codepoint as UTF-16LE bytes, appending to output array.
function encodeUtf16LE(cp, out) {
  if (cp <= 0xffff) {
    out.push(cp & 0xff);
    out.push((cp >> 8) & 0xff);
  } else {
    const adj = cp - 0x10000;
    const hi = 0xd800 + (adj >> 10);
    const lo = 0xdc00 + (adj & 0x3ff);
    out.push(hi & 0xff);
    out.push((hi >> 8) & 0xff);
    out.push(lo & 0xff);
    out.push((lo >> 8) & 0xff);
  }
}

// Encode a Unicode codepoint as UTF-8 bytes, appending to output array.
function encodeUtf8(cp, out) {
  if (cp <= 0x7f) {
    out.push(cp);
  } else if (cp <= 0x7ff) {
    out.push(0xc0 | (cp >> 6));
    out.push(0x80 | (cp & 0x3f));
  } else if (cp <= 0xffff) {
    out.push(0xe0 | (cp >> 12));
    out.push(0x80 | ((cp >> 6) & 0x3f));
    out.push(0x80 | (cp & 0x3f));
  } else {
    out.push(0xf0 | (cp >> 18));
    out.push(0x80 | ((cp >> 12) & 0x3f));
    out.push(0x80 | ((cp >> 6) & 0x3f));
    out.push(0x80 | (cp & 0x3f));
  }
}

// Encode a Unicode codepoint as UTF-32LE bytes, appending to output array.
function encodeUtf32LE(cp, out) {
  out.push(cp & 0xff);
  out.push((cp >> 8) & 0xff);
  out.push((cp >> 16) & 0xff);
  out.push((cp >> 24) & 0xff);
}

// ====================
// Keyword map
// ====================

const KEYWORD_MAP = new Map([
  ["auto", Keyword.AUTO],
  ["break", Keyword.BREAK],
  ["case", Keyword.CASE],
  ["char", Keyword.CHAR],
  ["const", Keyword.CONST],
  ["continue", Keyword.CONTINUE],
  ["default", Keyword.DEFAULT],
  ["do", Keyword.DO],
  ["double", Keyword.DOUBLE],
  ["else", Keyword.ELSE],
  ["enum", Keyword.ENUM],
  ["extern", Keyword.EXTERN],
  ["float", Keyword.FLOAT],
  ["for", Keyword.FOR],
  ["goto", Keyword.GOTO],
  ["if", Keyword.IF],
  ["int", Keyword.INT],
  ["long", Keyword.LONG],
  ["register", Keyword.REGISTER],
  ["return", Keyword.RETURN],
  ["short", Keyword.SHORT],
  ["signed", Keyword.SIGNED],
  ["sizeof", Keyword.SIZEOF],
  ["static", Keyword.STATIC],
  ["struct", Keyword.STRUCT],
  ["switch", Keyword.SWITCH],
  ["typedef", Keyword.TYPEDEF],
  ["union", Keyword.UNION],
  ["unsigned", Keyword.UNSIGNED],
  ["void", Keyword.VOID],
  ["volatile", Keyword.VOLATILE],
  ["while", Keyword.WHILE],
  ["inline", Keyword.INLINE],
  ["restrict", Keyword.RESTRICT],
  ["_Generic", Keyword.GENERIC],
  ["_Static_assert", Keyword.STATIC_ASSERT],
  ["_Noreturn", Keyword.NORETURN],
  ["_Alignof", Keyword.ALIGNOF],
  ["_Alignas", Keyword.ALIGNAS],
  ["_Thread_local", Keyword.THREAD_LOCAL],
  ["typeof", Keyword.TYPEOF],
  ["typeof_unqual", Keyword.TYPEOF_UNQUAL],
  ["__typeof", Keyword.TYPEOF],
  ["__typeof__", Keyword.TYPEOF],
  ["_Bool", Keyword.BOOL],
  ["__import", Keyword.X_IMPORT],
  ["__builtin_va_start", Keyword.X_BUILTIN_VA_START],
  ["__builtin_va_arg", Keyword.X_BUILTIN_VA_ARG],
  ["__builtin_va_end", Keyword.X_BUILTIN_VA_END],
  ["__builtin_va_copy", Keyword.X_BUILTIN_VA_COPY],
  ["__builtin_unreachable", Keyword.X_BUILTIN_UNREACHABLE],
  ["__builtin_abort", Keyword.X_BUILTIN_ABORT],
  ["__builtin_expect", Keyword.X_BUILTIN_EXPECT],
  ["__memory_size", Keyword.X_MEMORY_SIZE],
  ["__memory_grow", Keyword.X_MEMORY_GROW],
  ["__builtin", Keyword.X_BUILTIN],
  ["__require_source", Keyword.X_REQUIRE_SOURCE],
  ["__export", Keyword.X_EXPORT],
  ["__minstack", Keyword.X_MINSTACK],
  ["__wasm", Keyword.X_WASM],
  ["__exception", Keyword.X_EXCEPTION],
  ["__try", Keyword.X_TRY],
  ["__catch", Keyword.X_CATCH],
  ["__throw", Keyword.X_THROW],
  ["__externref", Keyword.X_EXTERNREF],
  ["__refextern", Keyword.X_REFEXTERN],
  ["__struct", Keyword.X_STRUCT_GC],
  ["__array", Keyword.X_ARRAY_GC],
  ["__struct_new", Keyword.X_STRUCT_NEW],
  ["__new", Keyword.X_NEW],
  ["__array_new", Keyword.X_ARRAY_NEW],
  ["__ref_is_null", Keyword.X_REF_IS_NULL],
  ["__ref_eq", Keyword.X_REF_EQ],
  ["__ref_null", Keyword.X_REF_NULL],
  ["__ref_test", Keyword.X_REF_TEST],
  ["__ref_test_null", Keyword.X_REF_TEST_NULL],
  ["__array_len", Keyword.X_ARRAY_LEN],
  ["__array_of", Keyword.X_ARRAY_OF],
  ["__extends", Keyword.X_EXTENDS],
  ["__ref_cast", Keyword.X_REF_CAST],
  ["__ref_cast_null", Keyword.X_REF_CAST_NULL],
  ["__array_fill", Keyword.X_ARRAY_FILL],
  ["__array_copy", Keyword.X_ARRAY_COPY],
  ["__eqref", Keyword.X_EQREF],
  ["__ref_as_extern", Keyword.X_REF_AS_EXTERN],
  ["__ref_as_eq", Keyword.X_REF_AS_EQ],
  ["__cast", Keyword.X_CAST],
  ["__attribute__", Keyword.X_ATTRIBUTE],
  ["__attribute", Keyword.X_ATTRIBUTE],
]);

// ====================
// Tokenize (phase 1 + post-processing, without preprocessor)
// ====================

// Parse a floating-point literal, including C hex floats (0x1.8p3).
// JS parseFloat doesn't handle hex floats, so we do it manually.
function parseHexFloat(text) {
  // Try standard parseFloat first (handles decimal floats)
  if (!(text.length >= 2 && text[0] === "0" && (text[1] === "x" || text[1] === "X"))) {
    return parseFloat(text);
  }
  // Hex float: 0xHHH.HHHpEEE
  const pIdx = text.indexOf("p") !== -1 ? text.indexOf("p") : text.indexOf("P");
  if (pIdx === -1) return NaN; // hex float requires p/P exponent
  const mantissaStr = text.substring(2, pIdx); // after "0x"
  const expStr = text.substring(pIdx + 1);
  const exp = expStr.length > 0 ? parseInt(expStr, 10) : 0;
  const dotIdx = mantissaStr.indexOf(".");
  let mantissa;
  if (dotIdx === -1) {
    mantissa = parseInt(mantissaStr, 16);
  } else {
    const intPart = mantissaStr.substring(0, dotIdx);
    const fracPart = mantissaStr.substring(dotIdx + 1);
    mantissa = (intPart.length > 0 ? parseInt(intPart, 16) : 0) +
      (fracPart.length > 0 ? parseInt(fracPart, 16) / Math.pow(16, fracPart.length) : 0);
  }
  return mantissa * Math.pow(2, exp);
}

// Post-process a LexResult: strip newlines, resolve keywords, convert numbers/chars.
// In the full compiler this also runs the preprocessor between lex() and post-processing.
// For now, the preprocessor step is omitted — call postProcess(lex(...)) directly.
function postProcess(lexResult) {
  if (lexResult.errors.length > 0) return lexResult;

  // Strip NEWLINE tokens
  lexResult.tokens = lexResult.tokens.filter(
    (t) => t.kind !== TokenKind.NEWLINE
  );

  for (const t of lexResult.tokens) {
    // (A) IDENT -> KEYWORD
    if (t.kind === TokenKind.IDENT) {
      const kw = KEYWORD_MAP.get(t.text);
      if (kw !== undefined) {
        t.kind = TokenKind.KEYWORD;
        t.keyword = kw;
      }
    }
    // (B) PP_NUMBER -> INT or FLOAT
    else if (t.kind === TokenKind.PP_NUMBER) {
      const text = t.text;
      const isHex =
        text.length >= 2 &&
        text[0] === "0" &&
        (text[1] === "x" || text[1] === "X");
      const isHexFloat =
        isHex && (text.indexOf("p") !== -1 || text.indexOf("P") !== -1);
      let isDouble =
        text.indexOf(".") !== -1 ||
        isHexFloat ||
        (!isHex && (text.indexOf("e") !== -1 || text.indexOf("E") !== -1));
      let isLongLong = false;
      let isLong = false;
      let isFloat = false;
      let isUnsigned = false;

      // Parse suffixes from the end
      for (let si = text.length - 1; si > 0; --si) {
        const c = text[si];
        if (c === "u" || c === "U") {
          isUnsigned = true;
        } else if (c === "l" || c === "L") {
          if (isLong || isLongLong) {
            isLongLong = true;
            isLong = false;
          } else {
            isLong = true;
          }
        } else if ((c === "f" || c === "F") && (!isHex || isHexFloat)) {
          isFloat = true;
        } else {
          break;
        }
      }

      t.flags.isUnsigned = isUnsigned;
      t.flags.isLong = isLong;
      t.flags.isLongLong = isLongLong;
      t.flags.isFloat = isFloat;

      if (isFloat || isDouble) {
        t.kind = TokenKind.FLOAT;
        // Strip type suffixes before parsing
        let floatText = text;
        while (floatText.length > 0) {
          const last = floatText[floatText.length - 1];
          if (last === "f" || last === "F" || last === "l" || last === "L") {
            floatText = floatText.substring(0, floatText.length - 1);
          } else {
            break;
          }
        }
        t.floating = parseHexFloat(floatText);
        if (isNaN(t.floating)) {
          lexResult.errors.push(
            new LexError(
              "Invalid numeric literal: " + text,
              t.filename,
              t.line
            )
          );
        }
      } else {
        t.kind = TokenKind.INT;
        // Parse integer: handles 0x (hex), 0o/0 (octal), decimal
        let numText = text;
        // Strip suffixes
        while (numText.length > 0) {
          const last = numText[numText.length - 1];
          if (
            last === "u" ||
            last === "U" ||
            last === "l" ||
            last === "L"
          ) {
            numText = numText.substring(0, numText.length - 1);
          } else {
            break;
          }
        }
        try {
          if (numText === "0") {
            t.integer = 0n;
          } else if (
            numText.length >= 2 &&
            numText[0] === "0" &&
            (numText[1] === "x" || numText[1] === "X")
          ) {
            // Hex
            t.integer = BigInt(numText);
          } else if (
            numText.length >= 2 &&
            numText[0] === "0" &&
            (numText[1] === "b" || numText[1] === "B")
          ) {
            // Binary (C23 / GCC extension)
            t.integer = BigInt(numText);
          } else if (numText[0] === "0" && numText.length > 1) {
            // Octal (C-style: leading 0)
            t.integer = BigInt("0o" + numText.substring(1));
          } else {
            t.integer = BigInt(numText);
            t.flags.isDecimal = true;
          }
        } catch {
          lexResult.errors.push(
            new LexError(
              "Invalid numeric literal: " + text,
              t.filename,
              t.line
            )
          );
        }
      }
    }
    // (C) Resolve CHAR -> INT
    else if (t.kind === TokenKind.CHAR) {
      const text = t.text;
      let start = 0;
      if (text[start] === "L" || text[start] === "U") start++;
      else if (text[start] === "u") start++;
      start++; // Skip opening '
      const end = text.length - 1; // Skip trailing '

      const isWideChar =
        t.flags.stringPrefix === StringPrefix.PREFIX_L ||
        t.flags.stringPrefix === StringPrefix.PREFIX_u ||
        t.flags.stringPrefix === StringPrefix.PREFIX_U;

      const pos = { i: start };
      const codepoint = isWideChar
        ? unescapeCodepoint(text, pos, end)
        : unescape(text, pos, end);
      t.kind = TokenKind.INT;
      t.integer = BigInt(codepoint);
    }
  }

  return lexResult;
}

// Translation phase 2: splice lines by removing backslash-newline sequences.
// Must be applied before lexing (matches C++ readFile() behavior).
//
// Returns { spliced, lineOffsets }. `lineOffsets` is a sorted array of
// pairs `[splicedOffset, extraLines]` recording how many original lines
// were swallowed BEFORE that point in the spliced output. The lexer
// adds `extraLines` to each token's line number so diagnostics still
// point at the original source line. For sources with no splices,
// `lineOffsets` is `null` (zero-overhead fast path).
function spliceLines(source) {
  if (source.indexOf("\\\n") === -1) return { spliced: source, lineOffsets: null };
  let spliced = "";
  const lineOffsets = [];
  let skipped = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\" && i + 1 < source.length && source[i + 1] === "\n") {
      i++; // skip both '\' and '\n'
      skipped++;
      lineOffsets.push([spliced.length, skipped]);
    } else {
      spliced += source[i];
    }
  }
  return { spliced, lineOffsets };
}

// Look up the line-number offset that applies at `splicedOffset` in a
// previously-spliced source. Binary searches a sorted `lineOffsets`
// array of `[splicedOffset, extraLines]` pairs. Returns 0 if the table
// is null/empty or the offset precedes any splice.
function lineOffsetAt(lineOffsets, splicedOffset) {
  if (!lineOffsets || lineOffsets.length === 0) return 0;
  let lo = 0, hi = lineOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineOffsets[mid][0] <= splicedOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : lineOffsets[lo - 1][1];
}

// ====================
// Preprocessor
// ====================

class PPRegistry {
  constructor() {
    this.defines = new Map(); // Map<string, string|null> — name -> value (null = defined but no value)
    this.prelude = "";        // Preprocessor source processed before every translation unit
    this.includePaths = [];   // string[]
    this.sourceBuffers = new Map(); // Map<string, string> — path -> content cache
    this.onceGuards = new Set();    // Set<string> — files with #pragma once
    this.standardHeaders = new Map(); // Map<string, string> — header name -> content
    this.fileReader = null;   // function(path) -> string|null — callback to read files
  }

  loadFile(path) {
    if (this.sourceBuffers.has(path)) return this.sourceBuffers.get(path);
    if (!this.fileReader) return null;
    const content = this.fileReader(path);
    if (content === null) return null;
    this.sourceBuffers.set(path, content);
    return content;
  }
}

function preprocess(filename, initialTokens, ppRegistry) {
  const result = new LexResult();
  const output = [];
  const macros = new Map(); // Map<string, Macro>
  const ifStack = [];       // {active: bool, anyBranchRan: bool}[]
  const includeStack = [filename];

  // --- 1. SEED REGISTRY MACROS ---
  for (const [name, val] of ppRegistry.defines) {
    const m = { isFunctionLike: false, isVariadic: false, params: [], replacement: [] };
    if (val !== null) {
      const lexRes = lex(name, val);
      for (const t of lexRes.tokens) {
        if (t.kind !== TokenKind.EOS) m.replacement.push(t);
      }
    }
    macros.set(name, m);
  }

  // --- 1b. PROCESS PRELUDE ---
  if (ppRegistry.prelude) {
    const preludeLex = lex("<prelude>", ppRegistry.prelude);
    const preludeTokens = preludeLex.tokens.filter(t => t.kind !== TokenKind.EOS);
    initialTokens = [...preludeTokens, ...initialTokens];
  }

  function isActive() {
    return ifStack.length === 0 || ifStack[ifStack.length - 1].active;
  }

  // Compute __DATE__ and __TIME__ once (frozen at translation start per C standard)
  const now = new Date();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const day = now.getDate();
  const dateStr = `"${months[now.getMonth()]} ${day < 10 ? " " : ""}${day} ${now.getFullYear()}"`;
  const pad2 = n => n < 10 ? "0" + n : "" + n;
  const timeStr = `"${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}"`;

  function tryExpandBuiltinMacro(tok) {
    if (tok.atIdent("__LINE__")) {
      tok.kind = TokenKind.PP_NUMBER;
      tok.text = intern(String(tok.line));
      return true;
    }
    if (tok.atIdent("__FILE__")) {
      tok.kind = TokenKind.STRING;
      tok.text = intern('"' + tok.filename + '"');
      return true;
    }
    if (tok.atIdent("__DATE__")) {
      tok.kind = TokenKind.STRING;
      tok.text = intern(dateStr);
      return true;
    }
    if (tok.atIdent("__TIME__")) {
      tok.kind = TokenKind.STRING;
      tok.text = intern(timeStr);
      return true;
    }
    return false;
  }

  // --- 2. CENTRALIZED EXPANSION HELPER ---
  function expand(tokens, hideset) {
    const expanded = [];
    for (let i = 0; i < tokens.length; ++i) {
      const t = tokens[i];

      // Special handling for the 'defined' operator
      if (t.atIdent("defined")) {
        let hasParens = false;
        let nextIdx = i + 1;
        if (nextIdx < tokens.length && tokens[nextIdx].atPunct(Punct.LPAREN)) {
          hasParens = true;
          nextIdx++;
        }
        if (nextIdx < tokens.length && tokens[nextIdx].kind === TokenKind.IDENT) {
          const operand = tokens[nextIdx];
          const isDefined = macros.has(operand.text);
          const resultTok = cloneToken(t);
          resultTok.kind = TokenKind.PP_NUMBER;
          resultTok.text = isDefined ? "1" : "0";
          expanded.push(resultTok);
          i = nextIdx;
          if (hasParens && i + 1 < tokens.length && tokens[i + 1].atPunct(Punct.RPAREN)) {
            i++;
          }
          continue;
        }
      }

      // Handle __FILE__ / __LINE__ / __DATE__ / __TIME__
      if (t.atIdent("__LINE__") || t.atIdent("__FILE__") ||
          t.atIdent("__DATE__") || t.atIdent("__TIME__")) {
        const tok = cloneToken(t);
        tryExpandBuiltinMacro(tok);
        expanded.push(tok);
        continue;
      }

      // Normal expansion logic
      if (t.kind === TokenKind.IDENT && macros.has(t.text) && !hideset.has(t.text)) {
        const m = macros.get(t.text);
        if (!m.isFunctionLike) {
          const nextHideset = new Set(hideset);
          nextHideset.add(t.text);
          const relocated = m.replacement.map(tok => {
            const c = cloneToken(tok);
            c.filename = t.filename;
            c.line = t.line;
            c.column = t.column;
            return c;
          });
          const replacement = expand(relocated, nextHideset);
          expanded.push(...replacement);
        } else {
          // Function-style macro: need to check for '(' and collect arguments
          let argStart = i + 1;
          while (argStart < tokens.length && tokens[argStart].kind === TokenKind.NEWLINE)
            argStart++;
          if (argStart < tokens.length && tokens[argStart].atPunct(Punct.LPAREN)) {
            const args = [];
            let currentArg = [];
            let parenDepth = 1;
            let j = argStart + 1;

            while (j < tokens.length && parenDepth > 0) {
              const argTok = tokens[j];
              if (argTok.kind === TokenKind.NEWLINE) {
                // Skip newlines inside macro arguments
              } else if (argTok.atPunct(Punct.LPAREN)) {
                parenDepth++;
                currentArg.push(argTok);
              } else if (argTok.atPunct(Punct.RPAREN)) {
                parenDepth--;
                if (parenDepth > 0) currentArg.push(argTok);
              } else if (argTok.atPunct(Punct.COMMA) && parenDepth === 1) {
                args.push(currentArg);
                currentArg = [];
              } else {
                currentArg.push(argTok);
              }
              j++;
            }
            if (currentArg.length > 0 || args.length > 0) {
              args.push(currentArg);
            }

            // Build parameter-to-argument maps
            const paramMap = new Map();
            const rawParamMap = new Map();
            for (let p = 0; p < m.params.length && p < args.length; ++p) {
              rawParamMap.set(m.params[p], args[p]);
              paramMap.set(m.params[p], expand(args[p], new Set(hideset)));
            }
            if (m.isVariadic) {
              const vaRaw = [];
              const vaArgs = [];
              for (let p = m.params.length; p < args.length; ++p) {
                if (p > m.params.length) {
                  const comma = new Token(null, 0, 0, TokenKind.PUNCT, intern(","));
                  comma.punct = Punct.COMMA;
                  vaRaw.push(comma);
                  vaArgs.push(comma);
                }
                vaRaw.push(...args[p]);
                vaArgs.push(...expand(args[p], new Set(hideset)));
              }
              rawParamMap.set("__VA_ARGS__", [...vaRaw]);
              paramMap.set("__VA_ARGS__", [...vaArgs]);
              // GNU extension: named variadic param also gets all variadic args
              if (m.variadicName) {
                rawParamMap.set(m.variadicName, vaRaw);
                paramMap.set(m.variadicName, vaArgs);
              }
            }

            // Helper: check if position ri is adjacent to ## in replacement list
            function isAdjacentToPaste(ri) {
              if (ri > 0 && m.replacement[ri - 1].atPunct(Punct.HASH_HASH)) return true;
              if (ri + 1 < m.replacement.length && m.replacement[ri + 1].atPunct(Punct.HASH_HASH)) return true;
              return false;
            }

            // Substitute parameters in replacement list
            const substituted = [];
            for (let ri = 0; ri < m.replacement.length; ++ri) {
              const repTok = m.replacement[ri];

              // Handle # stringification operator
              if (repTok.atPunct(Punct.HASH) && ri + 1 < m.replacement.length &&
                  m.replacement[ri + 1].kind === TokenKind.IDENT &&
                  rawParamMap.has(m.replacement[ri + 1].text)) {
                ri++;
                const rawTokens = rawParamMap.get(m.replacement[ri].text);
                let str = '"';
                for (let ai = 0; ai < rawTokens.length; ++ai) {
                  if (ai > 0 && rawTokens[ai].flags.hasSpace) str += ' ';
                  for (const c of rawTokens[ai].text) {
                    if (c === '"' || c === '\\') str += '\\';
                    str += c;
                  }
                }
                str += '"';
                const strTok = cloneToken(repTok);
                strTok.kind = TokenKind.STRING;
                strTok.text = intern(str);
                substituted.push(strTok);
                continue;
              }

              if (repTok.kind === TokenKind.IDENT && paramMap.has(repTok.text)) {
                const adjPaste = isAdjacentToPaste(ri);
                const map = adjPaste ? rawParamMap : paramMap;
                const argTokens = map.get(repTok.text);
                if (argTokens.length === 0 && adjPaste) {
                  const pm = cloneToken(repTok);
                  pm.kind = TokenKind.PLACEMARKER;
                  pm.text = "";
                  substituted.push(pm);
                } else {
                  substituted.push(...argTokens);
                }
              } else {
                substituted.push(repTok);
              }
            }

            // Token pasting (##) pass
            for (let si = 0; si < substituted.length;) {
              if (substituted[si].atPunct(Punct.HASH_HASH) && si > 0 && si + 1 < substituted.length) {
                const left = substituted[si - 1];
                const right = substituted[si + 1];
                if (left.kind === TokenKind.PLACEMARKER && right.kind === TokenKind.PLACEMARKER) {
                  substituted.splice(si, 2);
                } else if (left.kind === TokenKind.PLACEMARKER) {
                  substituted[si - 1] = right;
                  substituted.splice(si, 2);
                } else if (right.kind === TokenKind.PLACEMARKER) {
                  substituted.splice(si, 2);
                } else {
                  const merged = left.text + right.text;
                  const mergedSym = intern(merged);
                  const lexed = lex(left.filename, mergedSym);
                  if (lexed.tokens.length > 0 && lexed.tokens[0].kind !== TokenKind.EOS) {
                    const newTok = cloneToken(lexed.tokens[0]);
                    newTok.filename = left.filename;
                    newTok.line = left.line;
                    newTok.column = left.column;
                    substituted[si - 1] = newTok;
                    substituted.splice(si, 2);
                  } else {
                    si++;
                  }
                }
              } else {
                si++;
              }
            }

            // Remove surviving placemarker tokens
            for (let si = substituted.length - 1; si >= 0; si--) {
              if (substituted[si].kind === TokenKind.PLACEMARKER) substituted.splice(si, 1);
            }

            // Update replacement token locations to invocation site (clone to avoid mutating shared tokens)
            for (let si = 0; si < substituted.length; si++) {
              substituted[si] = cloneToken(substituted[si]);
              substituted[si].filename = t.filename;
              substituted[si].line = t.line;
              substituted[si].column = t.column;
            }

            // Recursively expand with macro in hideset
            const nextHideset = new Set(hideset);
            nextHideset.add(t.text);
            const expandedResult = expand(substituted, nextHideset);
            expanded.push(...expandedResult);

            // Advance past the macro invocation
            i = j - 1; // -1 because loop will increment
          } else {
            // Function-like macro not followed by '(' - don't expand
            expanded.push(t);
          }
        }
      } else {
        expanded.push(t);
      }
    }
    return expanded;
  }

  // --- 3. PRATT-STYLE EXPRESSION EVALUATOR ---
  function evaluateExpression(line) {
    const ZERO = new ConstEval.Item(0n, ConstEval.SIGNED);
    let pos = 0;
    function peek() { return pos < line.length ? line[pos] : null; }
    function consume() { return line[pos++]; }

    function getPrecedence(t) {
      if (!t || t.kind !== TokenKind.PUNCT) return 0;
      if (t.atPunct(Punct.QMARK)) return 1;
      if (t.atPunct(Punct.PIPEPIPE)) return 2;
      if (t.atPunct(Punct.AMPAMP)) return 3;
      if (t.atPunct(Punct.PIPE)) return 4;
      if (t.atPunct(Punct.CARET)) return 5;
      if (t.atPunct(Punct.AMP)) return 6;
      if (t.atPunct(Punct.EQEQ) || t.atPunct(Punct.NE)) return 7;
      if (t.atPunct(Punct.LT) || t.atPunct(Punct.GT) || t.atPunct(Punct.LE) || t.atPunct(Punct.GE)) return 8;
      if (t.atPunct(Punct.LSHIFT) || t.atPunct(Punct.RSHIFT)) return 9;
      if (t.atPunct(Punct.PLUS) || t.atPunct(Punct.MINUS)) return 10;
      if (t.atPunct(Punct.STAR) || t.atPunct(Punct.SLASH) || t.atPunct(Punct.PCT)) return 11;
      return 0;
    }

    const punctToOp = (p) => {
      if (p.atPunct(Punct.PLUS)) return "+"; if (p.atPunct(Punct.MINUS)) return "-";
      if (p.atPunct(Punct.STAR)) return "*"; if (p.atPunct(Punct.SLASH)) return "/";
      if (p.atPunct(Punct.PCT)) return "%"; if (p.atPunct(Punct.AMP)) return "&";
      if (p.atPunct(Punct.PIPE)) return "|"; if (p.atPunct(Punct.CARET)) return "^";
      if (p.atPunct(Punct.LSHIFT)) return "<<"; if (p.atPunct(Punct.RSHIFT)) return ">>";
      if (p.atPunct(Punct.EQEQ)) return "=="; if (p.atPunct(Punct.NE)) return "!=";
      if (p.atPunct(Punct.LT)) return "<"; if (p.atPunct(Punct.GT)) return ">";
      if (p.atPunct(Punct.LE)) return "<="; if (p.atPunct(Punct.GE)) return ">=";
      if (p.atPunct(Punct.AMPAMP)) return "&&"; if (p.atPunct(Punct.PIPEPIPE)) return "||";
      return null;
    };

    function parseBinary(minPrec) {
      const t = consume();
      if (!t) return ZERO;

      let left;
      if (t.kind === TokenKind.PP_NUMBER) {
        left = ConstEval.itemFromPPNumber(t.text);
      } else if (t.atPunct(Punct.BANG)) {
        left = ConstEval.unary("!", parseBinary(12));
      } else if (t.atPunct(Punct.MINUS)) {
        left = ConstEval.unary("-", parseBinary(12));
      } else if (t.atPunct(Punct.PLUS)) {
        left = ConstEval.unary("+", parseBinary(12));
      } else if (t.atPunct(Punct.TILDE)) {
        left = ConstEval.unary("~", parseBinary(12));
      } else if (t.atPunct(Punct.LPAREN)) {
        left = parseBinary(0);
        const next = peek();
        if (next && next.atPunct(Punct.RPAREN)) consume();
      } else if (t.kind === TokenKind.CHAR) {
        let s = 0;
        if (t.text[s] === "L" || t.text[s] === "U" || t.text[s] === "u") s++;
        s++;
        const e = t.text.length - 1;
        const p = { i: s };
        left = new ConstEval.Item(s < e ? BigInt(unescape(t.text, p, e)) : 0n, ConstEval.SIGNED);
      } else if (t.kind === TokenKind.IDENT) {
        left = ZERO;
      } else if (t.kind === TokenKind.INT) {
        left = new ConstEval.Item(t.integer, t.flags.isUnsigned ? ConstEval.UNSIGNED : ConstEval.SIGNED);
      } else {
        left = ZERO;
      }

      while (true) {
        const op = peek();
        const prec = getPrecedence(op);
        if (prec <= minPrec) break;
        consume();

        if (op.atPunct(Punct.QMARK)) {
          const thenVal = parseBinary(0);
          const next = peek();
          if (next && next.atPunct(Punct.COLON)) consume();
          const elseVal = parseBinary(prec);
          left = left.value !== 0n ? thenVal : elseVal;
          continue;
        }

        const right = parseBinary(prec);
        left = ConstEval.binary(punctToOp(op), left, right);
      }
      return left;
    }

    return parseBinary(0).value;
  }

  // --- 4. INCLUDE RESOLUTION ---
  function resolveAndLex(target, currentFile) {
    const lastSlash = Math.max(currentFile.lastIndexOf("/"), currentFile.lastIndexOf("\\"));
    const baseDir = lastSlash >= 0 ? currentFile.substring(0, lastSlash + 1) : "";

    const searchPaths = [baseDir + target];
    for (const p of ppRegistry.includePaths) {
      let path = p;
      if (path.length > 0 && path[path.length - 1] !== "/" && path[path.length - 1] !== "\\")
        path += "/";
      searchPaths.push(path + target);
    }

    for (const fullPath of searchPaths) {
      const content = ppRegistry.loadFile(fullPath);
      if (content !== null) {
        const resolved = intern(fullPath);
        const { spliced, lineOffsets } = spliceLines(content);
        return { lexResult: lex(resolved, spliced, lineOffsets), resolvedFile: resolved };
      }
    }

    // Fallback to standard library headers
    if (ppRegistry.standardHeaders.has(target)) {
      const resolved = intern(target);
      return { lexResult: lex(resolved, ppRegistry.standardHeaders.get(target)), resolvedFile: resolved };
    }

    return null;
  }

  // rescanTrailingMacros: if expansion result ends with a function-like macro
  // name and source has '(' next, collect args and re-expand
  function rescanTrailingMacros(expanded, state) {
    while (expanded.length > 0 && !state.atEnd && state.peek().atPunct(Punct.LPAREN)) {
      const last = expanded[expanded.length - 1];
      if (last.kind !== TokenKind.IDENT || !macros.has(last.text) ||
          !macros.get(last.text).isFunctionLike)
        break;
      const combined = [...expanded];
      combined.push(state.consume()); // '('
      let depth = 1;
      while (!state.atEnd && depth > 0) {
        if (state.peek().atPunct(Punct.LPAREN)) depth++;
        else if (state.peek().atPunct(Punct.RPAREN)) depth--;
        combined.push(state.consume());
      }
      expanded.length = 0;
      expanded.push(...expand(combined, new Set()));
    }
  }

  // --- 5. CORE PROCESSING ---
  function processTokens(state) {
    let lineOffset = 0;
    let fileOverride = null;

    function emitToken(tok) {
      if (lineOffset || fileOverride) {
        tok = cloneToken(tok);
        tok.line = tok.line + lineOffset;
        if (fileOverride) tok.filename = fileOverride;
      }
      output.push(tok);
    }

    while (!state.atEnd) {
      const t = state.peek();

      if (t.atPunct(Punct.HASH) && t.flags.atBol) {
        state.consume();
        if (state.atEnd || state.peek().kind === TokenKind.NEWLINE) continue;

        const dir = state.consume();

        if (dir.atIdent("ifdef") || dir.atIdent("ifndef") || dir.atIdent("if")) {
          let condition = false;
          if (dir.atIdent("ifdef") || dir.atIdent("ifndef")) {
            if (!state.atEnd && state.peek().kind === TokenKind.IDENT) {
              const name = state.consume();
              condition = macros.has(name.text);
              if (dir.atIdent("ifndef")) condition = !condition;
            }
          } else { // #if
            const lineTokens = [];
            while (!state.atEnd && state.peek().kind !== TokenKind.NEWLINE) {
              lineTokens.push(state.consume());
            }
            const expandedTokens = expand(lineTokens, new Set());
            condition = evaluateExpression(expandedTokens) !== 0n;
          }
          const parentActive = isActive();
          ifStack.push({ active: parentActive && condition, anyBranchRan: condition });
        } else if (dir.atIdent("elif")) {
          if (ifStack.length === 0) {
            result.errors.push(new LexError("#elif without #if", state.currentFile, dir.line));
          } else {
            const lineTokens = [];
            while (!state.atEnd && state.peek().kind !== TokenKind.NEWLINE) {
              lineTokens.push(state.consume());
            }
            const expandedTokens = expand(lineTokens, new Set());
            const condition = evaluateExpression(expandedTokens) !== 0n;
            const top = ifStack[ifStack.length - 1];
            const parentActive = ifStack.length > 1 ? ifStack[ifStack.length - 2].active : true;
            top.active = parentActive && !top.anyBranchRan && condition;
            if (top.active) top.anyBranchRan = true;
          }
        } else if (dir.atIdent("else")) {
          if (ifStack.length === 0) {
            result.errors.push(new LexError("#else without #if", state.currentFile, dir.line));
          } else {
            const top = ifStack[ifStack.length - 1];
            const parentActive = ifStack.length > 1 ? ifStack[ifStack.length - 2].active : true;
            top.active = parentActive && !top.anyBranchRan;
            top.anyBranchRan = true;
          }
        } else if (dir.atIdent("endif")) {
          if (ifStack.length === 0) {
            result.errors.push(new LexError("#endif without #if", state.currentFile, dir.line));
          } else {
            ifStack.pop();
          }
        } else if (isActive()) {
          if (dir.atIdent("define")) {
            if (!state.atEnd && state.peek().kind === TokenKind.IDENT) {
              const nameTok = state.consume();
              const m = { isFunctionLike: false, isVariadic: false, variadicName: "", params: [], replacement: [] };
              if (!state.atEnd && state.peek().atPunct(Punct.LPAREN) && !state.peek().flags.hasSpace) {
                m.isFunctionLike = true;
                state.consume(); // '('
                while (!state.atEnd && !state.peek().atPunct(Punct.RPAREN)) {
                  if (state.peek().atPunct(Punct.ELLIPSIS)) {
                    m.isVariadic = true;
                    state.consume();
                    break;
                  }
                  if (state.peek().kind === TokenKind.IDENT) {
                    const name = state.consume().text;
                    // GNU extension: "name..." is a named variadic param
                    if (!state.atEnd && state.peek().atPunct(Punct.ELLIPSIS)) {
                      m.isVariadic = true;
                      m.variadicName = name;
                      state.consume(); // consume "..."
                      break;
                    }
                    m.params.push(name);
                  }
                  if (!state.atEnd && state.peek().atPunct(Punct.COMMA)) state.consume();
                }
                if (!state.atEnd) state.consume(); // ')'
              }
              while (!state.atEnd && state.peek().kind !== TokenKind.NEWLINE)
                m.replacement.push(state.consume());
              macros.set(nameTok.text, m);
            }
          } else if (dir.atIdent("undef")) {
            if (!state.atEnd && state.peek().kind === TokenKind.IDENT) {
              const name = state.consume();
              macros.delete(name.text);
            }
          } else if (dir.atIdent("include")) {
            if (!state.atEnd) {
              const lineTokens = [];
              while (!state.atEnd && state.peek().kind !== TokenKind.NEWLINE) {
                lineTokens.push(state.consume());
              }
              let tokensToUse = lineTokens;
              if (tokensToUse.length > 0 && tokensToUse[0].kind !== TokenKind.STRING &&
                  !tokensToUse[0].atPunct(Punct.LT)) {
                tokensToUse = expand(tokensToUse, new Set());
              }
              let rawPath;
              if (tokensToUse.length === 0) {
                result.errors.push(new LexError("Empty #include directive", state.currentFile, dir.line));
                // skip to newline
                while (!state.atEnd && state.peek().kind !== TokenKind.NEWLINE) state.consume();
                if (!state.atEnd) state.consume();
                continue;
              } else if (tokensToUse[0].kind === TokenKind.STRING) {
                const sv = tokensToUse[0].text;
                rawPath = sv.substring(1, sv.length - 1);
              } else if (tokensToUse[0].atPunct(Punct.LT)) {
                rawPath = "";
                for (let ti = 1; ti < tokensToUse.length; ++ti) {
                  if (tokensToUse[ti].atPunct(Punct.GT)) break;
                  rawPath += tokensToUse[ti].text;
                }
              } else {
                result.errors.push(new LexError("Expected string or <...> in #include", state.currentFile, dir.line));
                while (!state.atEnd && state.peek().kind !== TokenKind.NEWLINE) state.consume();
                if (!state.atEnd) state.consume();
                continue;
              }
              const includeRes = resolveAndLex(rawPath, state.currentFile);
              if (!includeRes) {
                result.errors.push(new LexError("Could not find include file: " + rawPath,
                    state.currentFile, dir.line));
              } else if (ppRegistry.onceGuards.has(includeRes.resolvedFile)) {
                // #pragma once: skip
              } else {
                let circular = false;
                for (const s of includeStack) {
                  if (s === includeRes.resolvedFile) circular = true;
                }
                if (circular) {
                  result.warnings.push(new LexError("Circular include detected", state.currentFile, dir.line));
                } else {
                  includeStack.push(includeRes.resolvedFile);
                  const toks = includeRes.lexResult.tokens;
                  const nextState = makePPState(includeRes.resolvedFile, toks, 0, toks.length);
                  processTokens(nextState);
                  includeStack.pop();
                }
              }
            }
          } else if (dir.atIdent("warning") || dir.atIdent("error")) {
            let msg = "";
            while (!state.atEnd && state.peek().kind !== TokenKind.NEWLINE) {
              if (msg.length > 0) msg += " ";
              msg += state.consume().text;
            }
            if (dir.atIdent("error")) {
              result.errors.push(new LexError(msg, state.currentFile, dir.line));
            }
          } else if (dir.atIdent("line")) {
            if (!state.atEnd && state.peek().kind === TokenKind.PP_NUMBER) {
              const numTok = state.consume();
              const newLine = parseInt(numTok.text, 10);
              lineOffset = newLine - dir.line - 1;
              if (!state.atEnd && state.peek().kind === TokenKind.STRING) {
                const sv = state.consume().text;
                if (sv.length >= 2 && sv[0] === '"' && sv[sv.length - 1] === '"') {
                  fileOverride = intern(sv.substring(1, sv.length - 1));
                }
              }
            }
          } else if (dir.atIdent("pragma")) {
            if (!state.atEnd && state.peek().atIdent("once")) {
              state.consume();
              ppRegistry.onceGuards.add(state.currentFile);
            }
            // Other pragmas silently ignored
          }
          // else: unknown directive (silently ignored, per C standard)
        }

        // Skip until end of line to finish processing the directive
        while (!state.atEnd && state.peek().kind !== TokenKind.NEWLINE) state.consume();
        if (!state.atEnd) state.consume(); // consume NEWLINE
        continue;
      }

      if (isActive()) {
        // Handle __FILE__ / __LINE__ / __DATE__ / __TIME__
        if (t.atIdent("__LINE__") || t.atIdent("__FILE__") ||
            t.atIdent("__DATE__") || t.atIdent("__TIME__")) {
          let tok = cloneToken(state.consume());
          if (lineOffset) tok.line = tok.line + lineOffset;
          if (fileOverride) tok.filename = fileOverride;
          tryExpandBuiltinMacro(tok);
          output.push(tok);
          continue;
        }
        // C99 _Pragma operator
        if (t.atIdent("_Pragma") && !state.atEnd) {
          state.consume();
          if (state.peek().atPunct(Punct.LPAREN)) {
            state.consume();
            if (!state.atEnd && state.peek().kind === TokenKind.STRING) {
              let content = state.consume().text;
              if (content.length >= 2 && content[0] === '"' && content[content.length - 1] === '"') {
                content = content.substring(1, content.length - 1);
              }
              if (!state.atEnd && state.peek().atPunct(Punct.RPAREN)) {
                state.consume();
              }
              if (content === "once") {
                ppRegistry.onceGuards.add(state.currentFile);
              }
            }
          }
          continue;
        }
        if (t.kind === TokenKind.IDENT && macros.has(t.text)) {
          const m = macros.get(t.text);
          if (m.isFunctionLike) {
            const invocation = [];
            invocation.push(state.consume()); // macro name
            if (!state.atEnd && state.peek().atPunct(Punct.LPAREN)) {
              invocation.push(state.consume()); // '('
              let parenDepth = 1;
              while (!state.atEnd && parenDepth > 0) {
                const argTok = state.peek();
                if (argTok.atPunct(Punct.LPAREN)) parenDepth++;
                else if (argTok.atPunct(Punct.RPAREN)) parenDepth--;
                invocation.push(state.consume());
              }
              const expandedTokens = expand(invocation, new Set());
              rescanTrailingMacros(expandedTokens, state);
              for (const et of expandedTokens) emitToken(et);
            } else {
              emitToken(invocation[0]);
            }
          } else {
            // Object-like macro: consume BEFORE rescan
            state.consume();
            const expandedTokens = expand([t], new Set());
            rescanTrailingMacros(expandedTokens, state);
            for (const et of expandedTokens) emitToken(et);
          }
        } else if (t.kind !== TokenKind.NEWLINE) {
          emitToken(state.consume());
        } else {
          state.consume();
        }
      } else {
        state.consume();
      }
    }
  }

  const initialState = makePPState(filename, initialTokens, 0, initialTokens.length);
  processTokens(initialState);

  result.tokens = output;
  return result;
}

// PPState helper — wraps an array of tokens with a cursor
function makePPState(currentFile, tokens, start, end) {
  let idx = start;
  return {
    currentFile,
    get atEnd() { return idx >= end || tokens[idx].kind === TokenKind.EOS; },
    peek() { return tokens[idx]; },
    consume() { return tokens[idx++]; },
  };
}

// Clone a Token (shallow copy)
function cloneToken(t) {
  const c = new Token(t.filename, t.line, t.column, t.kind, t.text);
  c.integer = t.integer;
  c.floating = t.floating;
  c.keyword = t.keyword;
  c.punct = t.punct;
  c.flags = new TokenFlags();
  c.flags.atBol = t.flags.atBol;
  c.flags.hasSpace = t.flags.hasSpace;
  c.flags.isUnsigned = t.flags.isUnsigned;
  c.flags.isLong = t.flags.isLong;
  c.flags.isLongLong = t.flags.isLongLong;
  c.flags.isFloat = t.flags.isFloat;
  c.flags.isDecimal = t.flags.isDecimal;
  c.flags.stringPrefix = t.flags.stringPrefix;
  return c;
}

// Convenience: splice + lex + preprocess + post-process
function tokenize(filename, source, ppRegistry) {
  const { spliced, lineOffsets } = spliceLines(source);
  const lexResult = lex(filename, spliced, lineOffsets);
  if (lexResult.errors.length > 0) return lexResult;
  if (ppRegistry) {
    const ppResult = preprocess(filename, lexResult.tokens, ppRegistry);
    if (ppResult.errors.length > 0) return ppResult;
    return postProcess(ppResult);
  }
  return postProcess(lexResult);
}

// ====================
// Token formatting
// ====================

function formatToken(t) {
  let s = `${t.filename}:${t.line}:${t.column} ${t.kind} ${JSON.stringify(t.text)}`;
  if (t.kind === TokenKind.INT) {
    s += ` ${t.integer}`;
    if (t.flags.isUnsigned) s += "u";
    if (t.flags.isLongLong) s += "ll";
    else if (t.flags.isLong) s += "l";
  } else if (t.kind === TokenKind.FLOAT) {
    // Print float as hex bytes for exact comparison with C++
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = t.floating;
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
    s += ` ${hex}`;
    if (t.flags.isFloat) s += "f";
    else if (t.flags.isLong) s += "l";
  } else if (t.kind === TokenKind.KEYWORD) {
    s += ` ${t.keyword}`;
  } else if (t.kind === TokenKind.STRING) {
    const prefixNames = { 1: "L", 2: "u", 3: "U", 4: "u8" };
    if (t.flags.stringPrefix !== StringPrefix.NONE) {
      s += ` prefix=${prefixNames[t.flags.stringPrefix]}`;
    }
  }
  return s;
}

return {
  intern, TokenKind, Keyword, Punct, StringPrefix, TokenFlags, Token, Loc, LexError, LexResult,
  lex, unescape, decodeCodepoint, unescapeCodepoint, encodeUtf16LE, encodeUtf32LE,
  parseHexFloat, postProcess, spliceLines, PPRegistry, preprocess, cloneToken,
  tokenize, formatToken, encodeUtf8,
};
})();

// ====================
// Parser — Type System
// ====================

const Types = (() => {

const TagKind = Object.freeze({
  STRUCT: "struct", UNION: "union", ENUM: "enum",
  GC_STRUCT: "gc_struct",
});

const StorageClass = Object.freeze({
  NONE: "none", AUTO: "auto", REGISTER: "register",
  STATIC: "static", EXTERN: "extern", TYPEDEF: "typedef", IMPORT: "import",
});

const AllocClass = Object.freeze({ REGISTER: "register", MEMORY: "memory" });

const LabelKind = Object.freeze({ FORWARD: "forward", LOOP: "loop", BOTH: "both" });

const IntrinsicKind = Object.freeze({
  VA_START: "va_start", VA_ARG: "va_arg", VA_END: "va_end", VA_COPY: "va_copy",
  MEMORY_SIZE: "memory_size", MEMORY_GROW: "memory_grow",
  MEMORY_COPY: "memory_copy", MEMORY_FILL: "memory_fill",
  HEAP_BASE: "heap_base", ALLOCA: "alloca", UNREACHABLE: "unreachable",
  REF_IS_NULL: "ref_is_null", REF_EQ: "ref_eq", REF_NULL: "ref_null",
  REF_TEST: "ref_test", REF_TEST_NULL: "ref_test_null",
  REF_CAST: "ref_cast", REF_CAST_NULL: "ref_cast_null",
  ARRAY_LEN: "array_len", GC_NEW_ARRAY: "gc_new_array",
  ARRAY_FILL: "array_fill", ARRAY_COPY: "array_copy",
  REF_AS_EXTERN: "ref_as_extern", REF_AS_EQ: "ref_as_eq",
  CAST: "cast",
});

const BopStr = Object.freeze({
  ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%",
  EQ: "==", NE: "!=", LT: "<", GT: ">", LE: "<=", GE: ">=",
  LAND: "&&", LOR: "||", BAND: "&", BOR: "|", BXOR: "^", SHL: "<<", SHR: ">>",
  ASSIGN: "=", ADD_ASSIGN: "+=", SUB_ASSIGN: "-=", MUL_ASSIGN: "*=",
  DIV_ASSIGN: "/=", MOD_ASSIGN: "%=", BAND_ASSIGN: "&=", BOR_ASSIGN: "|=",
  BXOR_ASSIGN: "^=", SHL_ASSIGN: "<<=", SHR_ASSIGN: ">>=",
});

const UopStr = Object.freeze({
  OP_POS: "+", OP_NEG: "-", OP_LNOT: "!", OP_BNOT: "~",
  OP_DEREF: "*", OP_ADDR: "&",
  OP_PRE_INC: "++pre", OP_PRE_DEC: "--pre",
  OP_POST_INC: "post++", OP_POST_DEC: "post--",
});

// Type system: an abstract base + per-kind subclasses.
//
// Identity comparison by reference. The factory functions below ensure
// canonical instances (one PointerType per pointee, one ArrayType per
// (elem, size), etc.), so `t1 === t2` is meaningful for structural equality.
//
// To narrow a type, use `instanceof XType` for parametric/aggregate kinds
// (`PointerType`, `ArrayType`, `TagType`, `GCStructHeapType`, ...) or `===`
// identity against the singletons (`t === Types.TINT`, `t === Types.TVOID`,
// etc.) for primitive and ref-singleton kinds. Predicate methods on
// `TypeInfo` (`isInteger`, `isPointer`, `isVoid`, ...) wrap the common ones.
class TypeInfo {
  constructor(size, align, isComplete) {
    this.size = size;
    this.align = align;
    this.isComplete = isComplete;
    this.isConst = false;
    this.isVolatile = false;
    // Cache slots that can hang on any type:
    //   _pointer        — `T *` for this T
    //   _constVariant   — `const T` (or its non-const sibling)
    //   _volatileVariant — `volatile T` (or its non-volatile sibling)
    //   _arrayCache     — Map<size, ArrayType> for arrays of this element type
    //   _funcTypeCache  — nested Map for function types with this return type
    //   _gcArrayCache   — single GCArrayType for this element type
    this._pointer = null;
    this._constVariant = null;
    this._volatileVariant = null;
    this._arrayCache = null;
    this._funcTypeCache = null;
    this._gcArrayCache = null;
  }

  // ------------- Field accessors --------------------------------------
  // Most kind-specific data (baseType, arraySize, returnType, paramTypes,
  // tagName, tagDecl, ...) lives only on the subclass that uses it. Generic
  // code typically guards with a kind/instanceof check before reading. The
  // getters below are intentionally not defined on the base — accessing them
  // on a type that doesn't carry the field returns `undefined`, which the
  // existing `?.` / `||` patterns at call sites handle gracefully.
  getBaseType()   { return this.baseType; }
  getReturnType() { return this.returnType; }
  getParamTypes() { return this.paramTypes || []; }

  // ------------- Predicates ---------------------------------------------
  // Defaults are false on the abstract base; the relevant subclass overrides.
  // E.g. `isInteger()` is true on IntegerType, `isFloatingPoint()` on
  // FloatingType, `isVoid()` on VoidType, etc.
  isInteger()    { return false; }
  isUnsigned()   { return false; }
  isFloatingPoint() { return false; }
  isArithmetic() { return this.isInteger() || this.isFloatingPoint(); }
  isScalar()     { return this.isArithmetic() || this.isPointer(); }
  isPointer()    { return false; }
  isArray()      { return false; }
  isFunction()   { return false; }
  isVoid()       { return false; }
  isDivergent()  { return false; }
  isTag()        { return false; }
  isStruct()     { return false; }
  isUnion()      { return false; }
  isEnum()       { return false; }
  isAggregate()  { return false; }
  isRef()        { return false; }
  isGCRef()      { return false; }
  isGCStruct()       { return false; }
  isGCStructHeap()   { return false; }
  isGCStructRefOrHeap() { return this.isGCStruct() || this.isGCStructHeap(); }
  isGCArray()    { return false; }
  // Normalize a GC struct (heap or ref) to its heap form. Returns null for
  // non-GC-struct types. Refs delegate metadata (tagDecl, parentType,
  // isComplete) to their heap, so most ref-form code never needs this.
  gcHeap()       { return null; }
  // True for any concrete GC type that has a wasm type index — heap form
  // structs, ref form structs (which share the heap's index), and GC arrays.
  // Codegen uses this at entry points (cToWasmType / getBinaryWasmType) to
  // dispatch to `getOrCreateGCWasmTypeIdx`.
  isWasmGCType() { return false; }

  // ------------- Qualifiers ---------------------------------------------
  // Per-subclass clone — used by toggleConst/toggleVolatile to construct a
  // sibling with flipped qualifier. Each subclass implements this so the
  // sibling carries the right kind-specific fields.
  _cloneForQualifier() { throw new Error(`${this.constructor.name}._cloneForQualifier not implemented`); }

  toggleConst() {
    if (this._constVariant) return this._constVariant;
    const c = this._cloneForQualifier();
    c.isConst = !this.isConst;
    c.isVolatile = this.isVolatile;
    c._constVariant = this;
    this._constVariant = c;
    c._volatileVariant = this._volatileVariant?._constVariant || null;
    return c;
  }
  addConst()    { return this.isConst ? this : this.toggleConst(); }
  removeConst() { return this.isConst ? this.toggleConst() : this; }

  toggleVolatile() {
    if (this._volatileVariant) return this._volatileVariant;
    const v = this._cloneForQualifier();
    v.isVolatile = !this.isVolatile;
    v.isConst = this.isConst;
    v._volatileVariant = this;
    this._volatileVariant = v;
    return v;
  }
  addVolatile() { return this.isVolatile ? this : this.toggleVolatile(); }

  removeQualifiers() {
    let t = this;
    if (t.isConst) t = t.toggleConst();
    if (t.isVolatile) t = t.toggleVolatile();
    return t;
  }

  // ------------- Conversions / construction -----------------------------
  // Standard `T → T*`. ArrayType.decay() produces `T*` from `T[]`,
  // FunctionType.decay() produces `Fn*`. Others return self.
  decay() { return this; }

  // `T → T*`. Default builds a PointerType. GC kinds override.
  pointer() {
    if (this._pointer) return this._pointer;
    const p = new PointerType(this);
    this._pointer = p;
    return p;
  }

  // ------------- Pretty-printing / structural compare -------------------
  toString() {
    let out = "";
    if (this.isConst) out += "const ";
    if (this.isVolatile) out += "volatile ";
    out += this._toString();
    return out;
  }
  // Subclass override: kind-specific spelling without qualifiers.
  // Subclasses must implement; the abstract base intentionally throws.
  _toString() { throw new Error(`${this.constructor.name}._toString not implemented`); }

  // Top-level structural equality. Common shape: same class, same qualifiers,
  // then per-subclass `_eqStructure`. Identity (===) short-circuits since
  // factories canonicalize.
  isCompatibleWith(other, _seen) {
    if (this === other) return true;
    if (!other || this.constructor !== other.constructor) return false;
    if (this.isConst !== other.isConst || this.isVolatile !== other.isVolatile) return false;
    return this._eqStructure(other, _seen);
  }
  // Subclass override: structural comparison given matching class + qualifiers.
  // Default true — singleton primitives that reach here are equal because
  // identity already matched above.
  _eqStructure(_other, _seen) { return true; }
}

// Most primitive numeric types (BOOL/CHAR/INT/FLOAT/...) and the special
// non-numeric singletons (VOID/AUTO/DIVERGENT/UNKNOWN). All have fixed
// size+align and no kind-specific fields.
// Abstract: any type that doesn't carry kind-specific structure (no
// baseType, no params, no fields). Subclasses are the concrete primitive
// categories: IntegerType, FloatingType, VoidType, AutoType, UnknownType,
// DivergentType. They share the trivial qualifier-clone idiom — each
// concrete subclass is also the cloning factory for its own kind.
class PrimitiveType extends TypeInfo {
  constructor(size, align, isComplete) {
    super(size, align, isComplete);
  }
  // Two primitive instances of the same class but different identity (e.g.
  // TINT vs TUINT — both IntegerType, distinct singletons) are NOT
  // compatible. The base `isCompatibleWith` short-circuits true on identity,
  // so reaching `_eqStructure` means they're different — return false.
  _eqStructure(_other, _seen) { return false; }
}

// Integer types: bool, char, signed/unsigned char/short/int/long/long long.
// `isSigned` distinguishes the signedness of a given width. `name` is the C
// spelling used by `toString()` (e.g. `"int"`, `"_Bool"`, `"unsigned long"`).
class IntegerType extends PrimitiveType {
  constructor(name, size, align, isSigned) {
    super(size, align, true);
    this.name = name;
    this.isSigned = isSigned;
    Object.seal(this);
  }
  isInteger()  { return true; }
  isUnsigned() { return !this.isSigned; }
  _toString()  { return this.name; }
  _cloneForQualifier() { return new IntegerType(this.name, this.size, this.align, this.isSigned); }
}

// Floating-point types: float, double, long double.
class FloatingType extends PrimitiveType {
  constructor(name, size, align) {
    super(size, align, true);
    this.name = name;
    Object.seal(this);
  }
  isFloatingPoint() { return true; }
  _toString() { return this.name; }
  _cloneForQualifier() { return new FloatingType(this.name, this.size, this.align); }
}

// `void`. Singleton; carried through pointer types as `void *` etc.
// Has size/align of 0 and isComplete = false (cannot be a value type).
class VoidType extends PrimitiveType {
  constructor() {
    super(0, 0, false);
    Object.seal(this);
  }
  isVoid()    { return true; }
  _toString() { return "void"; }
  _cloneForQualifier() { return new VoidType(); }
}

// C23 `auto`: parser sentinel during decl-spec, replaced with the inferred
// type once the initializer is known. Identity-compared (`t === TAUTO`).
class AutoType extends PrimitiveType {
  constructor() {
    super(0, 0, false);
    Object.seal(this);
  }
  _toString() { return "auto"; }
  _cloneForQualifier() { return new AutoType(); }
}

// `unknown` — placeholder for "no type known yet" in early parse stages.
// Identity-compared sentinel.
class UnknownType extends PrimitiveType {
  constructor() {
    super(0, 0, false);
    Object.seal(this);
  }
  _toString() { return "unknown"; }
  _cloneForQualifier() { return new UnknownType(); }
}

// Bottom type for error recovery. Operations that combine types
// (usual-arithmetic, computeBinaryType, maybeImplicitCast) treat any
// divergent operand as absorbing — the result is divergent.
class DivergentType extends PrimitiveType {
  constructor() {
    super(0, 0, false);
    Object.seal(this);
  }
  isDivergent() { return true; }
  _toString()   { return "divergent"; }
  _cloneForQualifier() { return new DivergentType(); }
}

// `T *` — a C pointer to T. Always 4 bytes (wasm32).
class PointerType extends TypeInfo {
  constructor(baseType) {
    super(4, 4, true);
    this.baseType = baseType;
    Object.seal(this);
  }
  isPointer() { return true; }
  _toString() { return "*" + this.baseType.toString(); }
  _eqStructure(other, seen) { return this.baseType.isCompatibleWith(other.baseType, seen); }
  _cloneForQualifier() { return new PointerType(this.baseType); }
}

// `T[N]` — a C array of N elements of T (linear memory). N=0 marks an
// incomplete array (e.g., `extern int a[];`).
class ArrayType extends TypeInfo {
  constructor(baseType, size) {
    super(baseType.size * size, baseType.align, size > 0);
    this.baseType = baseType;
    this.arraySize = size;
    Object.seal(this);
  }
  isArray() { return true; }
  isAggregate() { return true; }
  decay() { return this.baseType.pointer(); }
  _toString() { return "[" + this.arraySize + "]" + this.baseType.toString(); }
  _eqStructure(other, seen) {
    if (!this.baseType.isCompatibleWith(other.baseType, seen)) return false;
    return this.arraySize === 0 || other.arraySize === 0 || this.arraySize === other.arraySize;
  }
  _cloneForQualifier() { return new ArrayType(this.baseType, this.arraySize); }
}

// Function type `R(P0, P1, ...)` (with optional `...` and "unspecified
// params" for the `f()` form vs `f(void)`).
class FunctionType extends TypeInfo {
  constructor(returnType, paramTypes, isVarArg, hasUnspecifiedParams) {
    super(0, 0, true);
    this.returnType = returnType;
    this.paramTypes = paramTypes;
    this.isVarArg = !!isVarArg;
    this.hasUnspecifiedParams = !!hasUnspecifiedParams;
    Object.seal(this);
  }
  isFunction() { return true; }
  decay() { return this.pointer(); }
  _toString() {
    let out = "(";
    if (this.paramTypes) {
      out += this.paramTypes.map(p => p.toString()).join(", ");
      if (this.isVarArg) out += ", ...";
    }
    return out + ")" + this.returnType.toString();
  }
  _eqStructure(other, seen) {
    if (!this.returnType.isCompatibleWith(other.returnType, seen)) return false;
    const a = this.paramTypes || [], b = other.paramTypes || [];
    if (this.hasUnspecifiedParams || other.hasUnspecifiedParams) return true;
    if (this.isVarArg !== other.isVarArg) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!a[i].isCompatibleWith(b[i], seen)) return false;
    }
    return true;
  }
  _cloneForQualifier() {
    return new FunctionType(this.returnType, this.paramTypes, this.isVarArg, this.hasUnspecifiedParams);
  }
}

// Linear-memory aggregates: `struct`, `union`, `enum`. `tagDecl` is the
// AST.DTag with members (filled in once the body is parsed).
class TagType extends TypeInfo {
  constructor(tagKind, tagName, size, align) {
    super(size, align, false);
    this.tagKind = tagKind;
    this.tagName = tagName;
    this.tagDecl = null;
    Object.seal(this);
  }
  isTag()    { return true; }
  isStruct() { return this.tagKind === TagKind.STRUCT; }
  isUnion()  { return this.tagKind === TagKind.UNION; }
  isEnum()   { return this.tagKind === TagKind.ENUM; }
  isAggregate() { return this.isStruct() || this.isUnion(); }
  _toString() { return this.tagKind + " " + this.tagName; }
  _eqStructure(other, _seen) {
    if (this.tagKind !== other.tagKind) return false;
    if (this.tagName === other.tagName) return true;
    return this.tagName?.startsWith("__anon_") && other.tagName?.startsWith("__anon_");
  }
  _cloneForQualifier() {
    const c = new TagType(this.tagKind, this.tagName, this.size, this.align);
    c.isComplete = this.isComplete;
    c.tagDecl = this.tagDecl;
    return c;
  }
}

// `__struct Foo` — the named heap-allocated GC struct *type entity*. NOT a
// value type. Carries `tagDecl` (members), `parentType` (single inheritance
// link), and lazily produces its ref form via `pointer()`.
class GCStructHeapType extends TypeInfo {
  constructor(tagName) {
    super(0, 0, false);
    this.tagKind = TagKind.GC_STRUCT;
    this.tagName = tagName;
    this.tagDecl = null;       // set when struct definition is parsed
    this.parentType = null;    // GCStructHeapType | null
    Object.seal(this);
  }
  isGCStructHeap() { return true; }
  isWasmGCType()   { return true; }
  gcHeap() { return this; }
  // First `*` converts heap → ref form. The ref shares the heap as its
  // `baseType`, and looks up tagDecl/parentType/isComplete via that link.
  pointer() {
    if (this._pointer) return this._pointer;
    const ref = new GCStructRefType(this);
    this._pointer = ref;
    return ref;
  }
  _toString() { return "__struct " + this.tagName; }
  _eqStructure(other, _seen) {
    if (!this.isComplete || !other.isComplete) return false;
    if (_seen) {
      for (const [a, b] of _seen) {
        if ((a === this && b === other) || (a === other && b === this)) return true;
      }
    }
    const seen = _seen ? _seen.concat([[this, other]]) : [[this, other]];
    const am = this.tagDecl.members, bm = other.tagDecl.members;
    if (am.length !== bm.length) return false;
    for (let i = 0; i < am.length; i++) {
      if (!am[i].type.isCompatibleWith(bm[i].type, seen)) return false;
    }
    return true;
  }
  _cloneForQualifier() {
    const c = new GCStructHeapType(this.tagName);
    c.tagDecl = this.tagDecl;
    c.parentType = this.parentType;
    c.isComplete = this.isComplete;
    return c;
  }
}

// `__struct Foo *` — a value-typed GC reference. Holds only a back-link to
// its heap; tagDecl / parentType / isComplete are read through getters so
// they always reflect the current heap state (no sync required when a
// forward-declared struct gets defined later).
class GCStructRefType extends TypeInfo {
  constructor(heap) {
    super(0, 0, heap.isComplete);
    this._heap = heap;
    Object.seal(this);
  }
  get baseType()   { return this._heap; }   // legacy alias for codegen
  get tagName()    { return this._heap.tagName; }
  get tagKind()    { return this._heap.tagKind; }
  get tagDecl()    { return this._heap.tagDecl; }
  get parentType() { return this._heap.parentType; }
  // ref form's completeness mirrors heap (heap may transition false → true
  // after a forward-declared struct gets defined).
  get isComplete() { return this._heap.isComplete; }
  set isComplete(_v) { /* derived from heap; ignore writes */ }
  isRef()      { return true; }
  isGCRef()    { return true; }
  isGCStruct() { return true; }
  isWasmGCType() { return true; }
  gcHeap()     { return this._heap; }
  // `*` on a ref form is rejected at the parser; we return null as a
  // sentinel for any callers that didn't add the explicit guard.
  pointer() { return null; }
  _toString() { return "__struct " + this._heap.tagName + " *"; }
  // Two refs are compatible iff their heaps are. Recurses via baseType.
  _eqStructure(other, seen) { return this._heap.isCompatibleWith(other._heap, seen); }
  _cloneForQualifier() { return new GCStructRefType(this._heap); }
}

// `__array(T)` — a GC-managed array with element type T. Self-referential
// `*` is rejected (arrays don't take the pointer-form sugar — they're
// already references by design).
class GCArrayType extends TypeInfo {
  constructor(elementType) {
    super(0, 0, true);
    this.baseType = elementType;
    Object.seal(this);
  }
  isRef()     { return true; }
  isGCRef()   { return true; }
  isGCArray() { return true; }
  isWasmGCType() { return true; }
  pointer()   { return this; }   // collapse — `__array(T) *` is rejected at parser
  _toString() { return "__array(" + this.baseType.toString() + ")"; }
  _eqStructure(other, seen) { return this.baseType.isCompatibleWith(other.baseType, seen); }
  _cloneForQualifier() { return new GCArrayType(this.baseType); }
}

// `__externref` (nullable) and `__refextern` (non-nullable) — opaque host
// references. Singletons.
class ExternRefType extends TypeInfo {
  constructor() { super(0, 0, false); Object.seal(this); }
  isRef() { return true; }
  // Historically the spelling has been the bare wasm name (no `__` prefix).
  // Several test diagnostics check this string verbatim — keep it.
  _toString() { return "externref"; }
  _cloneForQualifier() { return new ExternRefType(); }
}
class RefExternType extends TypeInfo {
  constructor() { super(0, 0, false); Object.seal(this); }
  isRef() { return true; }
  _toString() { return "refextern"; }
  _cloneForQualifier() { return new RefExternType(); }
}

// `__eqref` — the GC-universe top type (eq lattice). Singleton.
class EqRefType extends TypeInfo {
  constructor() { super(0, 0, true); Object.seal(this); }
  isRef()   { return true; }
  isGCRef() { return true; }
  pointer() { return this; }   // collapse — `__eqref *` is meaningless
  _toString() { return "__eqref"; }
  _cloneForQualifier() { return new EqRefType(); }
}

// Primitive type singletons. Each is an instance of the concrete subclass
// (IntegerType / FloatingType / VoidType / etc.). All are sealed via the
// subclass constructor.
const TUNKNOWN = new UnknownType();
const TVOID = new VoidType();
const TDIVERGENT = new DivergentType();
const TBOOL   = new IntegerType("_Bool",          1, 1, /* isSigned */ false);
// `char` signedness is implementation-defined in C; we treat plain char as
// signed (matching most platforms and the existing isUnsigned() behavior).
const TCHAR   = new IntegerType("char",           1, 1, true);
const TSCHAR  = new IntegerType("signed char",    1, 1, true);
const TUCHAR  = new IntegerType("unsigned char",  1, 1, false);
const TSHORT  = new IntegerType("short",          2, 2, true);
const TUSHORT = new IntegerType("unsigned short", 2, 2, false);
const TINT    = new IntegerType("int",            4, 4, true);
const TUINT   = new IntegerType("unsigned int",   4, 4, false);
const TLONG   = new IntegerType("long",           4, 4, true);
const TULONG  = new IntegerType("unsigned long",  4, 4, false);
const TLLONG  = new IntegerType("long long",      8, 8, true);
const TULLONG = new IntegerType("unsigned long long", 8, 8, false);
const TFLOAT   = new FloatingType("float",       4, 4);
const TDOUBLE  = new FloatingType("double",      8, 8);
const TLDOUBLE = new FloatingType("long double", 8, 8);
const TEXTERNREF = new ExternRefType();
const TREFEXTERN = new RefExternType();
const TEQREF = new EqRefType();
const TAUTO = new AutoType();

// Type construction caches
function arrayOf(elemType, size) {
  if (!elemType._arrayCache) elemType._arrayCache = new Map();
  if (elemType._arrayCache.has(size)) return elemType._arrayCache.get(size);
  const t = new ArrayType(elemType, size);
  elemType._arrayCache.set(size, t);
  return t;
}

function functionType(retType, paramTypes, isVarArg, hasUnspecifiedParams = false) {
  // Cache by type identity (matching C++ which keys by Info* pointers)
  let map = retType._funcTypeCache;
  if (!map) { map = new Map(); retType._funcTypeCache = map; }
  for (const pt of paramTypes) {
    let next = map.get(pt);
    if (!next) { next = new Map(); map.set(pt, next); }
    map = next;
  }
  const key = (isVarArg ? 1 : 0) | (hasUnspecifiedParams ? 2 : 0);
  if (map.has(key)) return map.get(key);
  const t = new FunctionType(retType, paramTypes, isVarArg, hasUnspecifiedParams);
  map.set(key, t);
  return t;
}

// Tag type cache: tagKind+name -> TagType
function getOrCreateTagType(tagTypeCache, tagKind, name) {
  const key = tagKind + ":" + name;
  if (tagTypeCache.has(key)) return tagTypeCache.get(key);
  const isEnum = tagKind === TagKind.ENUM;
  const size = isEnum ? 4 : 0;
  const align = isEnum ? 4 : 0;
  const t = new TagType(tagKind, name, size, align);
  tagTypeCache.set(key, t);
  return t;
}

// Walk a type and report every GC_STRUCT_HEAP that appears in a value-position
// slot (the type itself, pointer/array bases, GC array element, function
// return / parameter types). Heap forms are only legal as the type-arg of
// `__new`, `__ref_test`, `__ref_cast`, `__ref_null`, `__extends`, and inside
// struct definitions — not as values. The ref form `__struct Foo *` is the
// value spelling.
function validateNoHeapInValueType(type, errorFn) {
  const seen = new Set();
  const walk = (t) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    const u = t.removeQualifiers();
    if (u.isGCStructHeap()) {
      errorFn(`'${u.toString()}' (heap form) cannot appear as a value type — use the ref form '${u.toString()} *'`);
      return;
    }
    if (u.isPointer() || u.isArray() || u.isGCArray()) walk(u.baseType);
    else if (u.isFunction()) {
      walk(u.returnType);
      for (const pt of (u.paramTypes || [])) walk(pt);
    }
  };
  walk(type);
}

// GC struct type cache: name -> GCStructHeapType.
// Returns the heap form. The ref form (`__struct Foo *`) is created lazily via
// `.pointer()`. Heap forms appear only in heap-type positions (struct
// definitions, intrinsic type-args). Values (vars, fields, params) use the
// ref form.
function getOrCreateGCStructType(gcStructTypeCache, name) {
  if (gcStructTypeCache.has(name)) return gcStructTypeCache.get(name);
  const t = new GCStructHeapType(name);
  gcStructTypeCache.set(name, t);
  return t;
}

// GC array type cache: keyed by element type identity (stored on element's _gcArrayCache)
function gcArrayOf(elementType) {
  if (elementType._gcArrayCache) return elementType._gcArrayCache;
  const t = new GCArrayType(elementType);
  elementType._gcArrayCache = t;
  return t;
}

function computeStructLayout(members, isPacked = false) {
  let size = 0;
  let maxAlign = 1;
  // Bitfield packing state
  let bfBitsUsed = 0;
  let bfUnitSize = 0;
  let bfUnitType = null;
  let inBitField = false;

  for (const m of members) {
    const naturalAlign = isPacked ? 1 : (m.type.align || 1);
    const mAlign = m.requestedAlignment > 0 ? Math.max(naturalAlign, m.requestedAlignment) : naturalAlign;
    const mSize = m.type.size;
    if (mAlign > maxAlign) maxAlign = mAlign;

    if (m.bitWidth >= 0) {
      const bw = m.bitWidth;
      const unitBits = mSize * 8;

      if (bw === 0) {
        // Zero-width bitfield: finish current unit
        if (inBitField) { size += bfUnitSize; inBitField = false; bfBitsUsed = 0; }
        size = (size + mAlign - 1) & ~(mAlign - 1);
        continue;
      }

      // Bit-fields share a storage unit only if they have the same primitive
      // type (including signedness — `int : 4` and `unsigned : 4` go in
      // separate units). Identity comparison on removeQualifiers handles that:
      // each integer flavor is a unique singleton.
      if (inBitField && m.type.removeQualifiers() === bfUnitType.removeQualifiers() &&
          bfBitsUsed + bw <= unitBits) {
        // Fits in current storage unit
        m.bitOffset = bfBitsUsed;
        m.byteOffset = size;
        bfBitsUsed += bw;
      } else {
        // Finish previous unit if any
        if (inBitField) size += bfUnitSize;
        // Start new storage unit
        size = (size + mAlign - 1) & ~(mAlign - 1);
        m.bitOffset = 0;
        m.byteOffset = size;
        bfBitsUsed = bw;
        bfUnitSize = mSize;
        bfUnitType = m.type;
        inBitField = true;
      }
    } else {
      // Regular (non-bitfield) member: finish any pending bitfield unit
      if (inBitField) { size += bfUnitSize; inBitField = false; bfBitsUsed = 0; }
      size = (size + mAlign - 1) & ~(mAlign - 1);
      m.byteOffset = size;
      size += mSize;
    }
  }
  // Finish any trailing bitfield unit
  if (inBitField) size += bfUnitSize;
  // Final struct size aligned to struct alignment
  if (maxAlign > 0) size = (size + maxAlign - 1) & ~(maxAlign - 1);
  return { size, align: maxAlign };
}

function computeUnionLayout(members, isPacked = false) {
  let maxSize = 0;
  let maxAlign = 1;
  for (const m of members) {
    m.byteOffset = 0;
    if (m.type.size > maxSize) maxSize = m.type.size;
    const mAlign = isPacked ? 1 : (m.type.align || 1);
    if (mAlign > maxAlign) maxAlign = mAlign;
  }
  if (maxAlign > 0) maxSize = Math.ceil(maxSize / maxAlign) * maxAlign;
  return { size: maxSize, align: maxAlign };
}

// Matches CC's computeUnaryType exactly (compiler.cc ~line 10055)
function computeUnaryType(op, operandType) {
  switch (op) {
    case "OP_LNOT": return TINT;
    case "OP_ADDR": return operandType.pointer();
    case "OP_DEREF":
      if (operandType.isPointer()) return operandType.baseType;
      if (operandType.isArray()) return operandType.baseType;
      return TUNKNOWN;
    case "OP_POS":
    case "OP_NEG":
    case "OP_BNOT":
      if (operandType.isInteger() && operandType.size < TINT.size) {
        return TINT;
      }
      return operandType;
    case "OP_PRE_INC":
    case "OP_PRE_DEC":
    case "OP_POST_INC":
    case "OP_POST_DEC": return operandType;
    default: return operandType;
  }
}

// Truncate a constant BigInt value to fit the given C type's width (C99 §6.3.1.3).
function truncateConstInt(v, type) {
  type = type.removeQualifiers();
  if (type === TCHAR || type === TSCHAR) return BigInt.asIntN(8, v);
  if (type === TUCHAR) return BigInt.asUintN(8, v);
  if (type === TSHORT) return BigInt.asIntN(16, v);
  if (type === TUSHORT) return BigInt.asUintN(16, v);
  if (type === TINT || type === TLONG) return BigInt.asIntN(32, v);
  if (type === TUINT || type === TULONG) return BigInt.asUintN(32, v);
  if (type === TLLONG) return BigInt.asIntN(64, v);
  if (type === TULLONG) return BigInt.asUintN(64, v);
  if (type === TBOOL) return v !== 0n ? 1n : 0n;
  return v;  // pointer: no truncation needed
}

function usualArithmeticConversions(a, b) {
  // C99 6.3.1.8: strip qualifiers so 'const double' matches TDOUBLE etc.
  a = a.removeQualifiers();
  b = b.removeQualifiers();
  // Divergent absorbs — the result of mixing in a recovery type stays
  // divergent so further operations don't blow up either.
  if (a.isDivergent() || b.isDivergent()) return TDIVERGENT;
  if (a.isFloatingPoint() || b.isFloatingPoint()) {
    if (a === TLDOUBLE || b === TLDOUBLE) return TLDOUBLE;
    if (a === TDOUBLE || b === TDOUBLE) return TDOUBLE;
    return TFLOAT;
  }
  // Integer promotions: char, short, bool → int
  const promote = (t) => {
    if (t === TCHAR || t === TSCHAR || t === TUCHAR || t === TSHORT || t === TUSHORT || t === TBOOL)
      return TINT;
    return t;
  };
  a = promote(a);
  b = promote(b);
  if (a === b) return a;
  // C99 §6.3.1.8: rank by size, then handle signed/unsigned conflicts.
  const isU = (t) => t === TUINT || t === TULONG || t === TULLONG;
  const toU = (t) => {
    if (t === TINT) return TUINT;
    if (t === TLONG) return TULONG;
    if (t === TLLONG) return TULLONG;
    return t;
  };
  const aU = isU(a), bU = isU(b);
  const aSize = a.size, bSize = b.size;
  // Same signedness: higher rank (larger size) wins
  if (aU === bU) return aSize >= bSize ? a : b;
  // Different signedness
  const signedT = aU ? b : a;
  const unsignedT = aU ? a : b;
  const sSize = signedT.size, uSize = unsignedT.size;
  if (uSize >= sSize) return unsignedT;
  if (sSize > uSize) return signedT;
  return toU(signedT);
}

return {
  TagKind, StorageClass, AllocClass, LabelKind,
  IntrinsicKind, BopStr, UopStr,
  TypeInfo,
  PrimitiveType, IntegerType, FloatingType,
  VoidType, AutoType, UnknownType, DivergentType,
  PointerType, ArrayType, FunctionType, TagType,
  GCStructHeapType, GCStructRefType, GCArrayType,
  ExternRefType, RefExternType, EqRefType,
  TUNKNOWN, TVOID, TBOOL, TCHAR, TSCHAR, TUCHAR, TSHORT, TUSHORT,
  TINT, TUINT, TLONG, TULONG, TLLONG, TULLONG, TFLOAT, TDOUBLE, TLDOUBLE, TEXTERNREF, TREFEXTERN, TEQREF, TAUTO,
  TDIVERGENT,
  arrayOf, functionType, getOrCreateTagType,
  getOrCreateGCStructType, gcArrayOf, validateNoHeapInValueType,
  computeStructLayout, computeUnionLayout, computeUnaryType,
  usualArithmeticConversions, truncateConstInt,
};
})();

// ====================
// ConstEval — typed integer constant arithmetic
// ====================
// Wraps a BigInt value + C type so that signedness and width are preserved
// through arithmetic, comparisons, and bitwise ops. Used by the preprocessor
// (#if expressions operate at intmax_t/uintmax_t per C99 §6.10.1) and
// available for constEvalInt / inliner migration later.
const ConstEval = (() => {
const { TINT, TUINT, TLLONG, TULLONG, truncateConstInt, usualArithmeticConversions } = Types;

class Item {
  constructor(value, type) {
    this.value = truncateConstInt(value, type);
    this.type = type;
  }
}

function isUnsigned(type) {
  return type === TUINT || type === Types.TULONG || type === TULLONG
      || type === Types.TUCHAR || type === Types.TUSHORT;
}

function itemFromPPNumber(text) {
  let unsigned = false;
  let longlong = false;
  let end = text.length;
  for (let i = text.length - 1; i > 0; --i) {
    const c = text[i];
    if (c === "u" || c === "U") { unsigned = true; end = i; }
    else if (c === "l" || c === "L") { if (i > 1 && (text[i-1] === "l" || text[i-1] === "L")) { longlong = true; end = --i; } else { end = i; } }
    else break;
  }
  const numText = text.substring(0, end);
  let value;
  try {
    if (numText.length >= 2 && numText[0] === "0" && (numText[1] === "x" || numText[1] === "X"))
      value = BigInt(numText);
    else if (numText.length >= 2 && numText[0] === "0" && /^[0-7]+$/.test(numText))
      value = BigInt("0o" + numText);
    else
      value = BigInt(numText);
  } catch { value = 0n; }
  let type;
  if (unsigned && longlong) type = TULLONG;
  else if (unsigned) type = TUINT;
  else if (longlong) type = TLLONG;
  else type = TINT;
  if (!unsigned && isUnsigned(type) === false) {
    const truncated = truncateConstInt(value, type);
    if (truncated < 0n && value >= 0n) {
      type = (type === TLLONG) ? TULLONG : TUINT;
    }
  }
  return new Item(value, type);
}

function promote(item) {
  if (item.type === Types.TCHAR || item.type === Types.TSCHAR || item.type === Types.TUCHAR
      || item.type === Types.TSHORT || item.type === Types.TUSHORT || item.type === Types.TBOOL)
    return new Item(item.value, TINT);
  return item;
}

function unary(op, a) {
  a = promote(a);
  switch (op) {
    case "~": case "OP_BNOT": return new Item(~a.value, a.type);
    case "-": case "OP_NEG": return new Item(-a.value, a.type);
    case "+": case "OP_POS": return a;
    case "!": case "OP_LNOT": return new Item(a.value === 0n ? 1n : 0n, TINT);
    default: return null;
  }
}

function binary(op, a, b) {
  a = promote(a); b = promote(b);
  const rt = usualArithmeticConversions(a.type, b.type);
  const lv = truncateConstInt(a.value, rt);
  const rv = truncateConstInt(b.value, rt);
  switch (op) {
    case "+": case "ADD": return new Item(lv + rv, rt);
    case "-": case "SUB": return new Item(lv - rv, rt);
    case "*": case "MUL": return new Item(lv * rv, rt);
    case "/": case "DIV": return rv !== 0n ? new Item(lv / rv, rt) : null;
    case "%": case "MOD": return rv !== 0n ? new Item(lv % rv, rt) : null;
    case "&": case "BAND": return new Item(lv & rv, rt);
    case "|": case "BOR": return new Item(lv | rv, rt);
    case "^": case "BXOR": return new Item(lv ^ rv, rt);
    case "<<": case "SHL": return new Item(lv << rv, rt);
    case ">>": case "SHR": return new Item(lv >> rv, rt);
    case "==": case "EQ": return new Item(lv === rv ? 1n : 0n, TINT);
    case "!=": case "NE": return new Item(lv !== rv ? 1n : 0n, TINT);
    case "<": case "LT": return new Item(lv < rv ? 1n : 0n, TINT);
    case ">": case "GT": return new Item(lv > rv ? 1n : 0n, TINT);
    case "<=": case "LE": return new Item(lv <= rv ? 1n : 0n, TINT);
    case ">=": case "GE": return new Item(lv >= rv ? 1n : 0n, TINT);
    case "&&": case "LAND": return new Item((lv !== 0n && rv !== 0n) ? 1n : 0n, TINT);
    case "||": case "LOR": return new Item((lv !== 0n || rv !== 0n) ? 1n : 0n, TINT);
    default: return null;
  }
}

return { Item, itemFromPPNumber, unary, binary, isUnsigned, promote, SIGNED: TLLONG, UNSIGNED: TULLONG };
})();

// ====================
// Diagnostics pool
// ====================
//
// Shared error/warning sink. Set by `withDiag(sink, fn)` for the duration
// of `fn()`, after which `_currentDiag` is restored. Anywhere downstream
// — parser, AST builders, codegen — can call `reportError`/`reportWarning`
// without threading a context through.
//
// `fatalError` reports and throws `FatalDiag`. The caller's `withDiag`
// scope catches it and the error is already in the sink.

let _currentDiag = null;

class FatalDiag {}

function withDiag(sink, fn) {
  const saved = _currentDiag;
  _currentDiag = sink;
  try { return fn(); } finally { _currentDiag = saved; }
}

function reportError(loc, msg) {
  if (!_currentDiag) throw new Error(`reportError("${msg}") called outside withDiag scope`);
  _currentDiag.errors.push(new Lexer.LexError(msg, loc.filename, loc.line));
}

function reportWarning(loc, msg) {
  if (!_currentDiag) throw new Error(`reportWarning("${msg}") called outside withDiag scope`);
  _currentDiag.warnings.push(new Lexer.LexError(msg, loc.filename, loc.line));
}

// Reports the error and throws FatalDiag. The active `withDiag` scope
// catches it; downstream parsing of the current translation unit halts
// but the error is preserved in the sink.
function fatalError(loc, msg) {
  reportError(loc, msg);
  throw new FatalDiag();
}

// ====================
// AST
// ====================

const AST = (() => {

class Scope {
  constructor() { this.stack = [new Map()]; }
  push() { this.stack.push(new Map()); }
  pop() { this.stack.pop(); }
  set(name, value) {
    const top = this.stack[this.stack.length - 1];
    if (top.has(name)) return false;
    top.set(name, value);
    return true;
  }
  replace(name, value) {
    // Replace in whatever scope level it exists, or set in top
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].has(name)) { this.stack[i].set(name, value); return; }
    }
    this.stack[this.stack.length - 1].set(name, value);
  }
  get(name) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].has(name)) return this.stack[i].get(name);
    }
    return undefined;
  }
  has(name) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].has(name)) return true;
    }
    return false;
  }
  hasInCurrentScope(name) {
    return this.stack[this.stack.length - 1].has(name);
  }
  getInCurrentScope(name) {
    return this.stack[this.stack.length - 1].get(name);
  }
  getLevel(name) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].has(name)) return i;
    }
    return -1;
  }
}

// ====================
// AST Node Classes
// ====================

let nextDeclId = 1;

// TreeBag: a tree-shaped read-only set/multiset. Each node owns an
// array of items (not a Set — guc.js uses Set, but the user prefers
// arrays for insertion-order traversal and lower constant overhead),
// and references its children's bags. Items are NEVER copied into
// ancestors: iteration / `has` walk the children tree on demand, so
// memory stays O(N) regardless of depth.
//
// Used as a structural-share container for bubble-up metadata on Expr
// and Stmt. A node's `referencedFunctions` (or any future bag) is
// computed once at construction as `new TreeBag(ownItems, ...children
// .map(c => c.bag))` — no eager union, no rebuild on subtree change.
//
// Suitable for one-shot iteration / membership tests. If a caller
// queries the same bag many times, snapshot the iteration result.
class TreeBag {
  constructor(own, ...children) {
    this._own = (own && own.length > 0) ? own.slice() : null;
    this._children = children.filter(c => c.size > 0);
    let n = this._own ? this._own.length : 0;
    for (const c of this._children) n += c.size;
    this.size = n;
    Object.freeze(this._children);
    Object.freeze(this);
  }
  *[Symbol.iterator]() {
    if (this._own) yield* this._own;
    for (const child of this._children) yield* child;
  }
  has(value) {
    if (this._own && this._own.includes(value)) return true;
    for (const child of this._children) if (child.has(value)) return true;
    return false;
  }
  forEach(fn) { for (const item of this) fn(item); }
}
const _EMPTY_TREE_BAG = new TreeBag(null);

// Linearity (substructural typing, à la guc.js):
//   LINEAR        — must be evaluated in source order (side effects, traps,
//                   memory reads/writes, control flow). Cannot be discarded
//                   without losing observable behavior.
//   AFFINE        — has identity (allocation, address-take). Can be discarded
//                   if unused, but cannot be duplicated/reordered.
//   UNRESTRICTED  — pure, deterministic, no identity. Can be discarded,
//                   duplicated, or reordered freely.
// Optimizers consult this to decide whether a transform is safe.
const Linearity = Object.freeze({
  LINEAR: 'LINEAR', AFFINE: 'AFFINE', UNRESTRICTED: 'UNRESTRICTED',
});
const _LINEARITY_RANK = { UNRESTRICTED: 0, AFFINE: 1, LINEAR: 2 };
function _rankToLinearity(r) {
  return r === 2 ? 'LINEAR' : r === 1 ? 'AFFINE' : 'UNRESTRICTED';
}
// Join an op's intrinsic linearity with the linearity of children. The
// result is the strictest of (opLinearity, child1.linearity, ...) — a
// node is UNRESTRICTED iff its op is pure AND every child is too.
// Tolerates null/undefined children (some construction phases use partial
// child lists, e.g. EInitList during normalizeInitList).
function joinLinearity(opLinearity, ...children) {
  let rank = _LINEARITY_RANK[opLinearity];
  for (const c of children) {
    if (!c) continue;
    const r = _LINEARITY_RANK[c.linearity];
    if (r > rank) rank = r;
  }
  return _rankToLinearity(rank);
}

// --- Base classes ---
// The base Expr constructor takes a `children` array (in evaluation
// order) and an `opLinearity` (the intrinsic linearity of this op,
// before child contributions). The base computes `this.linearity` by
// joining opLinearity with the children's linearities — subclasses
// just declare what kind of op they are; bubble-up is automatic.
//
// Children are walkable via `this.children` (used by walkExpr / generic
// rewriters). Subclasses additionally store named field aliases (`left`,
// `right`, `operand`, `base`, `index`, etc.) for ergonomic access from
// codegen and other consumers — these alias the same expression objects.
class Expr {
    constructor(loc, type, children, opLinearity) {
      if (!loc) {
        throw new Error(`Expr: loc is required (use Lexer.Loc.fromTok / Loc.generated for synthesized nodes)`);
      }
      this.loc = loc;
      this.type = type;
      this.children = children;
      this.linearity = joinLinearity(opLinearity, ...children);
    }
    // Bubble-up bags are computed on demand from current children.
    // The getter form (rather than a precomputed field) tolerates the
    // seal-only escapees (EInitList, SLabel, SGoto) whose `children`
    // arrays are mutated by post-construction passes — the bag stays
    // consistent with whatever `children` currently looks like.
    // EIdent of a DFunc / DVar overrides to add itself.
    get referencedFunctions() {
      return new TreeBag(null,
        ...this.children.filter(c => c).map(c => c.referencedFunctions));
    }
    get referencedVariables() {
      return new TreeBag(null,
        ...this.children.filter(c => c).map(c => c.referencedVariables));
    }
    get referencedCompoundLiterals() {
      return new TreeBag(null,
        ...this.children.filter(c => c).map(c => c.referencedCompoundLiterals));
    }
    // Case labels can't appear inside expressions — empty by definition.
    get caseBag() { return _EMPTY_TREE_BAG; }
    // Rebuild this node with replaced children, in the same order as
    // `this.children`. Leaf subclasses (no children) inherit this
    // identity-return; non-leaf subclasses must override.
    _withChildren(newChildren) {
      if (newChildren.length === 0) return this;
      throw new Error(
        `${this.constructor.name} must implement _withChildren ` +
        `(node has ${this.children.length} children)`);
    }
  }
  // Stmt parallels Expr: takes a `children` array (mixed Expr and Stmt
  // subtrees in evaluation/control order), exposes generic traversal,
  // and bubbles up `referencedFunctions` from children. Subclasses
  // additionally store named field aliases (`condition`, `body`, etc.)
  // for ergonomic access — same pattern as Expr.
  class Stmt {
    constructor(loc, children = []) {
      if (!loc) {
        throw new Error(`Stmt: loc is required (use Lexer.Loc.fromTok / Loc.generated for synthesized nodes)`);
      }
      this.loc = loc;
      this.children = children;
    }
    // Bubble-up bag, computed on demand. See Expr.referencedFunctions
    // for rationale (handles parser-mutated children arrays cleanly).
    get referencedFunctions() {
      return new TreeBag(null,
        ...this.children.filter(c => c).map(c => c.referencedFunctions));
    }
    get referencedVariables() {
      return new TreeBag(null,
        ...this.children.filter(c => c).map(c => c.referencedVariables));
    }
    get referencedCompoundLiterals() {
      return new TreeBag(null,
        ...this.children.filter(c => c).map(c => c.referencedCompoundLiterals));
    }
    // Case labels visible from this subtree. Bubbles up through all
    // intermediate Stmts; SSwitch overrides to return empty (its inner
    // cases belong to itself, not the enclosing switch). Exprs return
    // empty via Expr.caseBag — case labels can't appear inside expressions.
    get caseBag() {
      return new TreeBag(null,
        ...this.children.filter(c => c).map(c => c.caseBag));
    }
    _withChildren(newChildren) {
      if (newChildren.length === 0) return this;
      throw new Error(
        `${this.constructor.name} must implement _withChildren ` +
        `(node has ${this.children.length} children)`);
    }
  }
  class Decl {
    constructor() {
      this.id = nextDeclId++;
    }
  }

  // --- Decl subclasses ---
  class DVar extends Decl {
    constructor(loc, name, type, storageClass, initExpr) {
      super();
      this.loc = loc; this.name = name; this.type = type;
      this.storageClass = storageClass || Types.StorageClass.NONE;
      this.allocClass = Types.AllocClass.REGISTER;
      this.initExpr = initExpr || null;
      this.definition = null;
      this.bitWidth = -1; this.bitOffset = 0; this.byteOffset = 0;
      this.requestedAlignment = 0;
      Object.seal(this);
    }
  }
  class DFunc extends Decl {
    constructor(loc, name, type, params, storageClass, isInline, body) {
      super();
      this.loc = loc; this.name = name; this.type = type;
      this.parameters = params || [];
      this.storageClass = storageClass || Types.StorageClass.NONE;
      this.isInline = isInline || false;
      this.body = body || null;
      this.staticLocals = []; this.externLocals = []; this.externLocalFuncs = [];
      this.definition = null;
      this.importModule = null; this.importName = null;
      Object.seal(this);
    }
  }
  class DTag extends Decl {
    constructor(loc, tagKind, name, isComplete, members) {
      super();
      this.loc = loc; this.tagKind = tagKind; this.name = name;
      this.isComplete = isComplete || false;
      this.isPacked = false;
      this.members = members || [];
      Object.seal(this);
    }
  }
  // Exception tag declaration. `paramTypes` lists the types of the
  // arguments a `__throw <name>(...)` site supplies and that a
  // `__catch <name>(...)` binding receives. `definition` is the
  // canonical (cross-TU-unified) tag — same chain pattern as DVar/DFunc.
  // Used by SThrow.tag and STryCatch's catch clauses.
  class DExceptionTag extends Decl {
    constructor(loc, name, paramTypes) {
      super();
      this.loc = loc; this.name = name;
      this.paramTypes = paramTypes;
      this.definition = null;
      Object.seal(this);
    }
  }
  class DEnumConst extends Decl {
    constructor(loc, name, value) {
      super();
      this.loc = loc; this.name = name; this.value = value;
      Object.seal(this);
    }
  }

  // --- Expr subclasses ---
  // Linearity assignment recipe:
  //   pure literals (EInt/EFloat/EString) and type-only operators
  //     (sizeof/_Alignof/E[Implicit]Cast/EDecay) → UNRESTRICTED
  //   side-effecting / control-flow / memory-accessing → LINEAR
  //   identity-bearing allocations (EGCNew/ECompoundLiteral) → AFFINE
  //   bubble-from-children for ops where the op itself is pure but a
  //     child might not be (EBinary non-assign, EUnary non-side-effect, etc.)
  class EInt extends Expr {
    constructor(loc, type, value) {
      if (!(type instanceof Types.TypeInfo) || !type.isInteger()) {
        throw new Error(`EInt: type must be integral; got ${type}`);
      }
      if (typeof value !== 'bigint') {
        throw new Error(`EInt: value must be a BigInt; got ${typeof value}`);
      }
      super(loc, type, [], Linearity.UNRESTRICTED);
      this.value = value;
      Object.freeze(this);
    }
  }
  class EFloat extends Expr {
    constructor(loc, type, value) {
      if (!(type instanceof Types.TypeInfo) || !type.isFloatingPoint()) {
        throw new Error(`EFloat: type must be floating-point; got ${type}`);
      }
      if (typeof value !== 'number') {
        throw new Error(`EFloat: value must be a number; got ${typeof value}`);
      }
      super(loc, type, [], Linearity.UNRESTRICTED);
      this.value = value;
      Object.freeze(this);
    }
  }
  class EString extends Expr {
    constructor(loc, type, value) {
      if (!(type instanceof Types.TypeInfo) || !type.isArray()) {
        throw new Error(`EString: type must be an array; got ${type}`);
      }
      // String literal element types: any integer up to 32 bits (CHAR..UINT
      // covers narrow string, wide string, char32_t-style literals).
      const elem = type.baseType;
      if (!elem || !elem.isInteger() || elem.size > 4) {
        throw new Error(`EString: element type must be a character/integer kind suitable for a string literal; got ${type.baseType}`);
      }
      if (!Array.isArray(value)) {
        throw new Error(`EString: value must be an Array of byte numbers; got ${value?.constructor?.name ?? typeof value}`);
      }
      super(loc, type, [], Linearity.UNRESTRICTED);
      this.value = value;
      Object.freeze(this);
    }
  }
  // Variable / function / enum constant reference. Pure UNRESTRICTED at
  // this AST level: the load itself has no side effects, and reading a
  // named decl twice in adjacent positions yields the same value (we
  // don't model volatile, signal handlers, or threads). `decl` is
  // required (use makeIdent for name-based lookup) — get the source
  // identifier via `this.decl.name`.
  class EIdent extends Expr {
    constructor(loc, type, decl) {
      if (!decl) throw new Error(`EIdent: decl is required (use makeIdent for name-based lookup)`);
      super(loc, type, [], Linearity.UNRESTRICTED);
      this.decl = decl;
      Object.freeze(this);
    }
    get name() { return this.decl.name; }
    // A reference to a function (direct or address-take) contributes
    // to the bubble-up bag. Calls go through here too: ECall's callee
    // is an EDecay/EIdent chain whose EIdent adds the DFunc to the bag.
    // Forward declarations have their `definition` field linked to the
    // body-bearing DFunc; we surface that so consumers always see the
    // canonical instance (which is what `unit.{static,defined}Functions`
    // contains).
    get referencedFunctions() {
      if (this.decl instanceof DFunc) {
        return new TreeBag([this.decl.definition || this.decl]);
      }
      return _EMPTY_TREE_BAG;
    }
    get referencedVariables() {
      if (this.decl instanceof DVar) {
        return new TreeBag([this.decl.definition || this.decl]);
      }
      return _EMPTY_TREE_BAG;
    }
  }
  // BinOp / UnOp: single source of truth for op metadata. EBinary /
  // EUnary look up linearity here at construction time and reject
  // unknown op names (catches typos like "ASSING" or stray refactor
  // residue). Other code consults these for diagnostic text and
  // category checks (isAssign, isCompare, etc.) instead of scattering
  // `op === "..."` chains. The flags are fixed properties of the op
  // itself — assignment-ness etc. don't depend on operands.
  const BinOp = Object.freeze({
    ADD:         { text: "+",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    SUB:         { text: "-",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    MUL:         { text: "*",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    DIV:         { text: "/",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    MOD:         { text: "%",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    EQ:          { text: "==",  linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: true,  isLogical: false, isShift: false, isBitwise: false },
    NE:          { text: "!=",  linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: true,  isLogical: false, isShift: false, isBitwise: false },
    LT:          { text: "<",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: true,  isLogical: false, isShift: false, isBitwise: false },
    GT:          { text: ">",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: true,  isLogical: false, isShift: false, isBitwise: false },
    LE:          { text: "<=",  linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: true,  isLogical: false, isShift: false, isBitwise: false },
    GE:          { text: ">=",  linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: true,  isLogical: false, isShift: false, isBitwise: false },
    LAND:        { text: "&&",  linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: true,  isShift: false, isBitwise: false },
    LOR:         { text: "||",  linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: true,  isShift: false, isBitwise: false },
    BAND:        { text: "&",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: false, isBitwise: true },
    BOR:         { text: "|",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: false, isBitwise: true },
    BXOR:        { text: "^",   linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: false, isBitwise: true },
    SHL:         { text: "<<",  linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: true,  isBitwise: false },
    SHR:         { text: ">>",  linearity: Linearity.UNRESTRICTED, isAssign: false, isCompare: false, isLogical: false, isShift: true,  isBitwise: false },
    ASSIGN:      { text: "=",   linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    ADD_ASSIGN:  { text: "+=",  linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    SUB_ASSIGN:  { text: "-=",  linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    MUL_ASSIGN:  { text: "*=",  linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    DIV_ASSIGN:  { text: "/=",  linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    MOD_ASSIGN:  { text: "%=",  linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: false },
    BAND_ASSIGN: { text: "&=",  linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: true },
    BOR_ASSIGN:  { text: "|=",  linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: true },
    BXOR_ASSIGN: { text: "^=",  linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: false, isBitwise: true },
    SHL_ASSIGN:  { text: "<<=", linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: true,  isBitwise: false },
    SHR_ASSIGN:  { text: ">>=", linearity: Linearity.LINEAR,       isAssign: true,  isCompare: false, isLogical: false, isShift: true,  isBitwise: false },
  });
  const UnOp = Object.freeze({
    OP_PRE_INC:  { text: "++",  linearity: Linearity.LINEAR,       isIncDec: true,  isAddr: false, isDeref: false },
    OP_PRE_DEC:  { text: "--",  linearity: Linearity.LINEAR,       isIncDec: true,  isAddr: false, isDeref: false },
    OP_POST_INC: { text: "++",  linearity: Linearity.LINEAR,       isIncDec: true,  isAddr: false, isDeref: false },
    OP_POST_DEC: { text: "--",  linearity: Linearity.LINEAR,       isIncDec: true,  isAddr: false, isDeref: false },
    // Address-take produces identity (the address is observable).
    OP_ADDR:     { text: "&",   linearity: Linearity.AFFINE,       isIncDec: false, isAddr: true,  isDeref: false },
    // Memory read; treated as pure at this level (no volatile model).
    OP_DEREF:    { text: "*",   linearity: Linearity.UNRESTRICTED, isIncDec: false, isAddr: false, isDeref: true },
    OP_POS:      { text: "+",   linearity: Linearity.UNRESTRICTED, isIncDec: false, isAddr: false, isDeref: false },
    OP_NEG:      { text: "-",   linearity: Linearity.UNRESTRICTED, isIncDec: false, isAddr: false, isDeref: false },
    OP_BNOT:     { text: "~",   linearity: Linearity.UNRESTRICTED, isIncDec: false, isAddr: false, isDeref: false },
    OP_LNOT:     { text: "!",   linearity: Linearity.UNRESTRICTED, isIncDec: false, isAddr: false, isDeref: false },
  });

  class EBinary extends Expr {
    constructor(loc, type, op, left, right) {
      const meta = BinOp[op];
      if (!meta) throw new Error(`EBinary: unknown op '${op}' (typo? known: ${Object.keys(BinOp).join(", ")})`);
      super(loc, type, [left, right], meta.linearity);
      this.op = op; this.left = left; this.right = right;
      Object.freeze(this);
    }
    _withChildren([left, right]) { return new EBinary(this.loc, this.type, this.op, left, right); }
  }
  class EUnary extends Expr {
    constructor(loc, type, op, operand) {
      const meta = UnOp[op];
      if (!meta) throw new Error(`EUnary: unknown op '${op}' (typo? known: ${Object.keys(UnOp).join(", ")})`);
      super(loc, type, [operand], meta.linearity);
      this.op = op; this.operand = operand;
      Object.freeze(this);
    }
    _withChildren([operand]) { return new EUnary(this.loc, this.type, this.op, operand); }
  }
  class ETernary extends Expr {
    constructor(loc, type, condition, thenExpr, elseExpr) {
      // Control flow: only one branch evaluates. Conservative LINEAR.
      super(loc, type, [condition, thenExpr, elseExpr], Linearity.LINEAR);
      this.condition = condition; this.thenExpr = thenExpr; this.elseExpr = elseExpr;
      Object.freeze(this);
    }
    _withChildren([condition, thenExpr, elseExpr]) {
      return new ETernary(this.loc, this.type, condition, thenExpr, elseExpr);
    }
  }
  class ECall extends Expr {
    // The result type is the function's return type (after array/function
    // decay on the callee). For "this isn't actually callable" cases the
    // parser also accepts (no separate diagnostic today), fall back to int —
    // some downstream pass will report the real diagnostic.
    //
    // funcDecl is the DFunc that's directly being called, if the callee is
    // a plain identifier resolving to one. For function-pointer expressions,
    // funcDecl is null and the codegen emits an indirect call.
    constructor(loc, callee, args) {
      // The parser wraps the callee in EDecay so callee.type is the
      // decayed pointer-to-function type. Synthesized callers (setjmp/
      // longjmp lowering) do the same.
      const calleeType = callee.type;
      let returnType = Types.TINT;
      if (calleeType.isPointer() &&
          calleeType.baseType.isFunction()) {
        returnType = calleeType.baseType.returnType;
      }
      super(loc, returnType, [callee, ...args], Linearity.LINEAR);
      this.callee = callee;
      this.arguments = args;
      // Look through EDecay so direct calls to a function name still
      // resolve to a DFunc decl (vs. an indirect call through a pointer).
      const inner = callee instanceof EDecay ? callee.operand : callee;
      this.funcDecl = (inner instanceof EIdent && inner.decl instanceof DFunc)
        ? inner.decl : null;
      Object.freeze(this);
    }
    _withChildren([callee, ...args]) { return new ECall(this.loc, callee, args); }
  }
  class ESubscript extends Expr {
    constructor(loc, type, array, index) {
      // Pure indexed read at this level — no side effect, deterministic.
      super(loc, type, [array, index], Linearity.UNRESTRICTED);
      this.array = array; this.index = index;
      Object.freeze(this);
    }
    _withChildren([array, index]) { return new ESubscript(this.loc, this.type, array, index); }
  }
  class EMember extends Expr {
    constructor(loc, type, base, memberDecl) {
      if (!memberDecl) throw new Error(`EMember: memberDecl is required (use makeMember to look up by name)`);
      // Pure field read.
      super(loc, type, [base], Linearity.UNRESTRICTED);
      this.base = base;
      this.memberDecl = memberDecl;
      Object.freeze(this);
    }
    _withChildren([base]) { return new EMember(this.loc, this.type, base, this.memberDecl); }
  }
  class EArrow extends Expr {
    constructor(loc, type, base, memberDecl) {
      if (!memberDecl) throw new Error(`EArrow: memberDecl is required (use makeArrow to look up by name)`);
      // Pure indirect field read.
      super(loc, type, [base], Linearity.UNRESTRICTED);
      this.base = base;
      this.memberDecl = memberDecl;
      Object.freeze(this);
    }
    _withChildren([base]) { return new EArrow(this.loc, this.type, base, this.memberDecl); }
  }
  class ECast extends Expr {
    constructor(loc, type, targetType, expr) {
      super(loc, type, [expr], Linearity.UNRESTRICTED);
      this.targetType = targetType; this.expr = expr;
      Object.freeze(this);
    }
    _withChildren([expr]) { return new ECast(this.loc, this.type, this.targetType, expr); }
  }
  // sizeof / _Alignof don't evaluate their expression operand — children
  // is empty so its linearity doesn't propagate.
  class ESizeofExpr extends Expr {
    constructor(loc, type, expr) {
      super(loc, type, [], Linearity.UNRESTRICTED);
      this.expr = expr;
      Object.freeze(this);
    }
  }
  class ESizeofType extends Expr {
    constructor(loc, type, operandType) {
      super(loc, type, [], Linearity.UNRESTRICTED);
      this.operandType = operandType;
      Object.freeze(this);
    }
  }
  class EAlignofExpr extends Expr {
    constructor(loc, type, expr) {
      super(loc, type, [], Linearity.UNRESTRICTED);
      this.expr = expr;
      Object.freeze(this);
    }
  }
  class EAlignofType extends Expr {
    constructor(loc, type, operandType) {
      super(loc, type, [], Linearity.UNRESTRICTED);
      this.operandType = operandType;
      Object.freeze(this);
    }
  }
  class EComma extends Expr {
    constructor(loc, type, expressions) {
      // Sequencing — each subexpression evaluates in order.
      super(loc, type, expressions, Linearity.LINEAR);
      this.expressions = expressions;
      Object.freeze(this);
    }
    _withChildren(newChildren) { return new EComma(this.loc, this.type, newChildren); }
  }
  // EInitList stays seal-only because normalizeInitList still mutates
  // `unionMemberIndex` in place when designators select a non-default
  // union member during the stack-based traversal. The `.type` mutation
  // was lifted out (normalize returns a fresh EInitList for that), but
  // `unionMemberIndex` writes happen through `top.output` references
  // mid-traversal and would require restructuring the whole walk to
  // remove. Acceptable trade-off — the refactor is bounded but not
  // earned today.
  class EInitList extends Expr {
    constructor(loc, type, elements, designators, unionMemberIndex) {
      super(loc, type, elements, Linearity.UNRESTRICTED);
      this.elements = elements;  // same ref as this.children
      this.designators = designators || [];
      this.unionMemberIndex = unionMemberIndex ?? -1;
      Object.seal(this);
    }
    _withChildren(newChildren) {
      return new EInitList(this.loc, this.type, newChildren, this.designators, this.unionMemberIndex);
    }
  }
  class EIntrinsic extends Expr {
    constructor(loc, type, ikind, args, argType) {
      // Most intrinsics are calls (memory ops, va_arg, etc.).
      super(loc, type, args, Linearity.LINEAR);
      this.intrinsicKind = ikind; this.args = args;
      this.argType = argType || null;
      Object.freeze(this);
    }
    _withChildren(newChildren) {
      return new EIntrinsic(this.loc, this.type, this.intrinsicKind, newChildren, this.argType);
    }
  }
  class EWasm extends Expr {
    constructor(loc, type, args, bytes) {
      super(loc, type, args, Linearity.LINEAR);
      this.args = args; this.bytes = bytes;
      Object.freeze(this);
    }
    _withChildren(newChildren) {
      return new EWasm(this.loc, this.type, newChildren, this.bytes);
    }
  }
  // ECompoundLiteral represents `(T){...}` — an aggregate-typed
  // allocation with observable identity (its storage address is taken).
  // Bubbles itself up via `referencedCompoundLiterals` so codegen can
  // discover all live compound literals from the AST shape rather than
  // a parser-side list — that lets INLINER replace nodes via
  // `_withChildren` without breaking layout (the bag picks up whatever
  // node is current at codegen time).
  class ECompoundLiteral extends Expr {
    constructor(loc, type, initList) {
      // Allocation has identity (the storage's address is observable).
      super(loc, type, [initList], Linearity.AFFINE);
      this.initList = initList;
      Object.freeze(this);
    }
    _withChildren([initList]) { return new ECompoundLiteral(this.loc, this.type, initList); }
    get referencedCompoundLiterals() {
      return new TreeBag([this], this.initList.referencedCompoundLiterals);
    }
  }
  class EImplicitCast extends Expr {
    constructor(loc, type, expr) {
      super(loc, type, [expr], Linearity.UNRESTRICTED);
      this.expr = expr;
      Object.freeze(this);
    }
    _withChildren([expr]) { return new EImplicitCast(this.loc, this.type, expr); }
  }
  // Array→pointer or function→pointer decay. The operand has array or
  // function type; the EDecay node has the corresponding decayed pointer type.
  // Codegen for EDecay just emits the operand (which already produces the
  // base address for arrays / table index for functions).
  class EDecay extends Expr {
    constructor(loc, type, operand) {
      super(loc, type, [operand], Linearity.UNRESTRICTED);
      this.operand = operand;
      Object.freeze(this);
    }
    _withChildren([operand]) { return new EDecay(this.loc, this.type, operand); }
  }
  class EGCNew extends Expr {
    constructor(loc, type, args) {
      // GC allocation produces a fresh ref with identity.
      super(loc, type, args, Linearity.AFFINE);
      this.args = args;
      Object.freeze(this);
    }
    _withChildren(newChildren) { return new EGCNew(this.loc, this.type, newChildren); }
  }

  // --- Stmt subclasses ---
  // Most are frozen at construction. SLabel / SGoto stay seal-only because
  // their fields get filled in during the parser's goto-resolution pass.
  class SExpr extends Stmt {
    constructor(loc, expr) { super(loc, [expr]); this.expr = expr; Object.freeze(this); }
    _withChildren([expr]) { return new SExpr(this.loc, expr); }
  }
  // SDecl bubble-up needs to reach into each DVar's initExpr — the
  // declarations array isn't structurally `children` (DVars aren't
  // Expr/Stmt) but their initializers can reference functions.
  class SDecl extends Stmt {
    constructor(loc, declarations) {
      const initExprs = [];
      for (const d of declarations) {
        if (d instanceof DVar && d.initExpr) initExprs.push(d.initExpr);
      }
      super(loc, initExprs);
      this.declarations = declarations;
      Object.freeze(this);
    }
    _withChildren(_) { return this; /* DVars are mutated in place; children mirror initExprs */ }
  }
  class SCompound extends Stmt {
    constructor(loc, statements, labels) {
      super(loc, statements);
      this.statements = statements;
      this.labels = labels || [];
      Object.freeze(this);
    }
    _withChildren(newChildren) { return new SCompound(this.loc, newChildren, this.labels); }
  }
  class SIf extends Stmt {
    constructor(loc, condition, thenBranch, elseBranch) {
      const kids = [condition, thenBranch];
      if (elseBranch) kids.push(elseBranch);
      super(loc, kids);
      this.condition = condition;
      this.thenBranch = thenBranch;
      this.elseBranch = elseBranch || null;
      Object.freeze(this);
    }
    _withChildren(newChildren) {
      const [cond, then_, else_] = newChildren;
      return new SIf(this.loc, cond, then_, else_ || null);
    }
  }
  class SWhile extends Stmt {
    constructor(loc, condition, body) {
      super(loc, [condition, body]);
      this.condition = condition; this.body = body;
      Object.freeze(this);
    }
    _withChildren([cond, body]) { return new SWhile(this.loc, cond, body); }
  }
  class SDoWhile extends Stmt {
    constructor(loc, body, condition) {
      super(loc, [body, condition]);
      this.body = body; this.condition = condition;
      Object.freeze(this);
    }
    _withChildren([body, cond]) { return new SDoWhile(this.loc, body, cond); }
  }
  class SFor extends Stmt {
    constructor(loc, init, condition, increment, body) {
      const kids = [];
      if (init) kids.push(init);
      if (condition) kids.push(condition);
      if (increment) kids.push(increment);
      kids.push(body);
      super(loc, kids);
      this.init = init || null;
      this.condition = condition || null;
      this.increment = increment || null;
      this.body = body;
      Object.freeze(this);
    }
    // Reconstruct from named slots — the children array's shape varies
    // (3, 4, or 5 slots depending on which optional clauses were present).
    _withChildren(_) {
      throw new Error(`SFor._withChildren: rebuild via the named-arg constructor instead`);
    }
  }
  class SBreak extends Stmt {
    constructor(loc) { super(loc); Object.freeze(this); }
  }
  class SContinue extends Stmt {
    constructor(loc) { super(loc); Object.freeze(this); }
  }
  class SReturn extends Stmt {
    constructor(loc, expr) {
      super(loc, expr ? [expr] : []);
      this.expr = expr || null;
      Object.freeze(this);
    }
    _withChildren(newChildren) {
      return new SReturn(this.loc, newChildren.length > 0 ? newChildren[0] : null);
    }
  }
  class SSwitch extends Stmt {
    constructor(loc, expr, body) {
      super(loc, [expr, body]);
      this.expr = expr; this.body = body;
      Object.freeze(this);
    }
    _withChildren([expr, body]) { return new SSwitch(this.loc, expr, body); }
    // Barrier: case labels inside this switch's body belong to this
    // switch, not the enclosing one. Readers that want this switch's
    // cases read `sw.body.caseBag` directly.
    get caseBag() { return _EMPTY_TREE_BAG; }
  }
  // A case (or default) label in a switch body. Standalone statement —
  // the next statement in the enclosing compound is the case's target
  // (parallel to how SLabel works for goto labels). `lo` / `hi` are
  // BigInts giving the value range (inclusive). For a single-value
  // case (`case 5:`), lo === hi. For a GNU range (`case 0 ... 9:`),
  // lo < hi. For default, isDefault is true and lo/hi are ignored.
  class SCase extends Stmt {
    constructor(loc, lo, hi, isDefault) {
      super(loc);
      this.lo = lo; this.hi = hi; this.isDefault = !!isDefault;
      Object.freeze(this);
    }
    get caseBag() { return new TreeBag([this]); }
  }
  // SGoto and SLabel are seal-only (not frozen) because the parser
  // backfills `target` (when a forward goto's label is later defined)
  // and updates `labelKind` / `hasGotos` as gotos are resolved.
  class SGoto extends Stmt {
    constructor(loc, label) { super(loc); this.label = label; this.target = null; Object.seal(this); }
  }
  class SLabel extends Stmt {
    constructor(loc, name, enclosingBlock) { super(loc); this.name = name; this.enclosingBlock = enclosingBlock || null; this.labelKind = Types.LabelKind.FORWARD; this.hasGotos = false; this.isSwitchLevel = false; Object.seal(this); }
  }
  class SEmpty extends Stmt {
    constructor(loc) { super(loc); Object.freeze(this); }
  }
  // STryCatch's catches are { tag, bindings, body } objects — body is a
  // Stmt and bubbles, so include each catch body in children.
  class STryCatch extends Stmt {
    constructor(loc, tryBody, catches) {
      const kids = [tryBody, ...catches.map(c => c.body)];
      super(loc, kids);
      this.tryBody = tryBody; this.catches = catches;
      Object.freeze(this);
    }
    _withChildren(newChildren) {
      const newTry = newChildren[0];
      const newCatches = this.catches.map((c, i) => ({ ...c, body: newChildren[i + 1] }));
      return new STryCatch(this.loc, newTry, newCatches);
    }
  }
  class SThrow extends Stmt {
    constructor(loc, tag, args) {
      super(loc, args);
      this.tag = tag; this.args = args;
      Object.freeze(this);
    }
    _withChildren(newChildren) { return new SThrow(this.loc, this.tag, newChildren); }
  }

// ---------- AST traversal / rewrite ----------
//
// walkExpr(expr, visit) walks the tree pre-order. The visitor returns:
//   - undefined  → keep recursing into children
//   - some node  → replace this subtree with the returned node (children
//                  of the replacement are NOT visited automatically;
//                  the visitor can call walkExpr on the replacement
//                  recursively if it wants that)
// If any child changed during recursion, the parent is rebuilt via
// `_withChildren(newChildren)`. Identity-preserving on no-change paths,
// so allocation stays O(changed).

function walkExpr(expr, visit) {
  if (!expr) return expr;
  const replaced = visit(expr);
  if (replaced !== undefined) return replaced;
  const kids = expr.children;
  if (!kids || kids.length === 0) return expr;
  let changed = false;
  const newKids = new Array(kids.length);
  for (let i = 0; i < kids.length; i++) {
    const w = walkExpr(kids[i], visit);
    if (w !== kids[i]) changed = true;
    newKids[i] = w;
  }
  return changed ? expr._withChildren(newKids) : expr;
}

// Substitute parameter references in an expression. `paramMap` maps
// DVar instances (the function's parameter decls) to expression
// replacements (the call's argument expressions). Used by the inliner
// to rewrite a function body for substitution at a call site.
function substituteParams(expr, paramMap) {
  return walkExpr(expr, node => {
    if (node instanceof EIdent && node.decl && paramMap.has(node.decl)) {
      return paramMap.get(node.decl);
    }
    return undefined;
  });
}

// ---------- AST builders that apply C semantics ----------
//
// These take "raw" inputs (the things the parser literally has at hand:
// callee + args, op + operands, etc.) and return a node with the
// C-standard conversions already inserted: array/function decay,
// implicit casts to the target type, default-argument promotions, etc.
//
// Constructors stay dumb (no implicit insertions). The make* helpers are
// the canonical place to build correct nodes — useful for the parser, AST
// rewriters, and any future pass that synthesizes calls/binops/etc.
//
// Diagnostics: callers pass a `report(loc, msg)` callback. The helpers
// don't throw — they report and proceed with the best-effort node, so
// callers can decide whether errors are fatal or recoverable.

// True if `srcType` flows into `targetType` under C99 §6.5.16.1
// (simple-assignment compatibility — the "as if by assignment" rules
// the spec invokes for function args, return values, and init exprs).
//
// Covers:
//   - same type (post qualifier strip)
//   - both arithmetic (numeric promotion / narrowing)
//   - target _Bool + source pointer
//   - both pointers, with compatible bases OR either is void*
//   - target pointer + source null-pointer constant
//   - both struct/union of compatible types
//   - ref-target rules (same ref, NPC → ref, arithmetic → __eqref boxing)
//   - divergent absorbs (error recovery)
//
// `expr` is consulted only for the null-pointer-constant cases; pass
// it when the source expression is available, otherwise null.
function isCharType(t) {
  return t === Types.TCHAR || t === Types.TSCHAR || t === Types.TUCHAR;
}

function typesAreAssignmentCompatible(srcType, targetType, expr) {
  const s = srcType.removeQualifiers();
  const t = targetType.removeQualifiers();
  if (s === t) return true;
  // Divergent (parser error recovery) absorbs — don't cascade complaints.
  if (s.isDivergent() || t.isDivergent()) return true;
  // Voids: assignment to void shouldn't happen at well-formed sites,
  // but tolerate so we don't double-error after a real error elsewhere.
  if (s.isVoid() || t.isVoid()) return true;
  // TAUTO is the C23 placeholder type; auto-resolution should have
  // replaced it before we reach a flow site, but `const auto` slips
  // past one branch of the resolver — tolerate it here so the user
  // sees the actual auto-related error rather than a confusing cast
  // error on the placeholder.
  if (s === Types.TAUTO || t === Types.TAUTO) return true;
  // C99 6.5.16.1: arithmetic types convert freely under assignment.
  if (s.isArithmetic() && t.isArithmetic()) return true;
  // _Bool ← any pointer (truthiness).
  if (t === Types.TBOOL && s.isPointer()) return true;
  // Pointers ↔ pointers (C99 6.5.16.1): the target's pointee must carry
  // every qualifier the source's pointee has (you can ADD const, not
  // drop it), and unqualified pointee types must match structurally.
  if (s.isPointer() && t.isPointer()) {
    const sBase = s.baseType, tBase = t.baseType;
    if (sBase.isVoid() || tBase.isVoid()) return true;
    if (sBase.isConst && !tBase.isConst) return false;
    if (sBase.isVolatile && !tBase.isVolatile) return false;
    const su = sBase.removeQualifiers(), tu = tBase.removeQualifiers();
    if (su.isCompatibleWith(tu)) return true;
    if (isCharType(su) && isCharType(tu)) return true;
    return false;
  }
  // Pointer target ← null pointer constant (literal 0, casts of 0).
  if (t.isPointer() && expr && isNullPointerConstant(expr)) return true;
  // Struct/union ← compatible struct/union.
  if ((s.isStruct() || s.isUnion()) && (t.isStruct() || t.isUnion())) {
    return s.isCompatibleWith(t);
  }
  // Ref-target rules. (rejectNonZeroToRef enforces a subset; we mirror
  // it here so the predicate is the single gate.)
  if (t.isRef()) {
    if (s.isRef()) {
      if (s.isCompatibleWith(t)) return true;
      // refextern (non-nullable) widens to externref (nullable). Going
      // the other direction would erase the nullability invariant.
      if (s === Types.TREFEXTERN && t === Types.TEXTERNREF) return true;
      // GC struct inheritance: a Dog ref flows into an Animal ref if
      // Animal is an ancestor in the parentType chain. parentType lives on
      // the heap form, so normalize both sides via gcHeap.
      if (s.isGCStruct() && t.isGCStruct()) {
        const th = t.gcHeap();
        for (let p = s.gcHeap().parentType; p; p = p.parentType) {
          if (p === th) return true;
        }
      }
      // Any GC ref widens to __eqref (top of the GC lattice).
      if (t === Types.TEQREF && (s.isGCStruct() || s.isGCArray())) return true;
      return false;
    }
    if (expr && isNullPointerConstant(expr)) return true;
    if (t === Types.TEQREF && s.isArithmetic()) return true;
    return false;
  }
  // Anything left: ref → non-ref, mismatched aggregates, etc. — reject.
  return false;
}

// True if `t` is legal in a "controlling expression" position
// (C99 §6.8.4.1, §6.8.5.1-3, §6.5.15.2, §6.5.3.3 — `if` / `while` /
// `do-while` / `for` / `?:` / `!`). Standard C requires scalar; we
// extend with refs (compiler extension: `if (gc_ref)` is sugar for
// `__ref_is_null` semantics, just as we already allow `!gc_ref`).
function isBoolContextType(t) {
  const u = t.removeQualifiers();
  return u.isDivergent() || u.isScalar() || u.isRef();
}

// True if `leftType` and `rightType` are a legal operand pair for the
// given binary op. Catches operator-illegal combinations the C standard
// forbids regardless of any implicit conversion (e.g. bitwise ops on
// floats, struct + struct, ptr + ptr). Called from `makeBinary` BEFORE
// the cast/conversion logic — if it fails we report and skip the rest
// to avoid downstream "incompatible types" cascades.
//
// Compound assigns (X_ASSIGN) defer to the underlying op's rules.
// Ref operands are tolerated here — the caller's ref-specific block
// handles them with its own per-op messages.
function typesAreOperandCompatible(op, leftType, rightType) {
  const meta = AST.BinOp[op];
  if (!meta) return true;
  const l = leftType.removeQualifiers();
  const r = rightType.removeQualifiers();
  // Divergent absorbs (parser error recovery).
  if (l.isDivergent() || r.isDivergent()) return true;
  // Refs: defer to the ref-specific handling already in makeBinary.
  if (l.isRef() || r.isRef()) return true;
  // ASSIGN: assignment-compatibility is the relevant rule, checked
  // separately at the call site via typesAreAssignmentCompatible.
  if (op === "ASSIGN") return true;
  // Compound assigns: evaluate as the underlying arithmetic/bitwise op.
  if (meta.isAssign) {
    return typesAreOperandCompatible(op.replace("_ASSIGN", ""), leftType, rightType);
  }
  // Bitwise / shift: integer operands only.
  if (meta.isBitwise || meta.isShift) {
    return l.isInteger() && r.isInteger();
  }
  // Logical && / ||: scalar (testable as bool).
  if (meta.isLogical) return l.isScalar() && r.isScalar();
  // MUL / DIV: both arithmetic. MOD: integer-only (% on float is
  // disallowed; fmod is a function).
  if (op === "MUL" || op === "DIV") return l.isArithmetic() && r.isArithmetic();
  if (op === "MOD") return l.isInteger() && r.isInteger();
  // ADD: both arithmetic, or one pointer/array and one integer.
  if (op === "ADD") {
    if (l.isArithmetic() && r.isArithmetic()) return true;
    if ((l.isPointer() || l.isArray()) && r.isInteger()) return true;
    if ((r.isPointer() || r.isArray()) && l.isInteger()) return true;
    return false;
  }
  // SUB: both arithmetic, or pointer-int, or pointer-pointer (same base).
  if (op === "SUB") {
    if (l.isArithmetic() && r.isArithmetic()) return true;
    if ((l.isPointer() || l.isArray()) && r.isInteger()) return true;
    if ((l.isPointer() || l.isArray()) && (r.isPointer() || r.isArray())) {
      return l.baseType.removeQualifiers().isCompatibleWith(r.baseType.removeQualifiers());
    }
    return false;
  }
  // Comparisons.
  if (meta.isCompare) {
    if (l.isArithmetic() && r.isArithmetic()) return true;
    if (l.isPointer() && r.isPointer()) return true;
    // EQ/NE: pointer + integer is allowed only via NPC; that case is
    // handled by typesAreAssignmentCompatible at the cast site. We
    // tolerate it here so the assignment-compat path can give the
    // canonical NPC message without cascading.
    if (op === "EQ" || op === "NE") {
      if ((l.isPointer() && r.isInteger()) || (r.isPointer() && l.isInteger())) return true;
    }
    return false;
  }
  return false;
}

// Wrap an expression in EImplicitCast at the target type. Pass-through
// when the source already matches the target after qualifier strip,
// or when either side is void / divergent. Validates assignment
// compatibility — `reportError` (not fatal) on mismatch and pass the
// expression through unwrapped, so cascading damage is bounded.
function maybeImplicitCast(expr, targetType) {
  targetType = targetType.removeQualifiers();
  const srcType = expr.type.removeQualifiers();
  if (srcType === targetType) return expr;
  if (targetType.isVoid() || srcType.isVoid()) return expr;
  // Divergent (recovery from a parser error) absorbs — don't wrap.
  if (srcType.isDivergent() || targetType.isDivergent()) return expr;
  if (!typesAreAssignmentCompatible(srcType, targetType, expr)) {
    // Specialize the message for non-ref → ref (the old rejectNonZeroToRef
    // case) — the user almost certainly wants either __cast or __ref_null.
    if (targetType.isRef() && !srcType.isRef()) {
      const castSpelling = castTypeArgSpelling(targetType);
      reportError(expr.loc,
        `cannot convert '${srcType.toString()}' to reference type '${targetType.toString()}' (use __cast(${castSpelling}, x) for an explicit conversion, or __ref_null for null)`);
    } else {
      reportError(expr.loc,
        `incompatible types: cannot implicitly convert '${srcType.toString()}' to '${targetType.toString()}'`);
    }
    return expr;
  }
  return new EImplicitCast(expr.loc, targetType, expr);
}

// The spelling to suggest for the type-arg of `__cast(T, x)` and similar
// intrinsics. GC struct refs collapse to their heap form (the ref form's `*`
// is not allowed in heap-type-arg positions).
function castTypeArgSpelling(type) {
  const u = type.removeQualifiers();
  if (u.isGCStruct()) return `__struct ${u.tagName}`;
  return type.toString();
}

// Wrap an expression in EDecay if its type is array or function.
// Pass-through otherwise.
function maybeDecay(expr) {
  const t = expr.type;
  if (t.isArray() || t.isFunction()) return new EDecay(expr.loc, t.decay(), expr);
  return expr;
}

// True if `expr` is a null pointer constant (literal 0, possibly wrapped
// in casts to void* / similar).
function isNullPointerConstant(expr) {
  if (!expr) return false;
  if (expr instanceof EInt && expr.value === 0n) return true;
  if (expr instanceof EImplicitCast || expr instanceof ECast) {
    return isNullPointerConstant(expr.expr);
  }
  return false;
}

// Reject a non-zero non-ref source flowing into a ref target. Allowed:
// null pointer constant, prim → __eqref auto-box. Anything else needs an
// explicit __cast.
function rejectNonZeroToRef(targetType, expr, loc) {
  if (!expr || !targetType) return;
  const t = targetType.removeQualifiers();
  const s = expr.type.removeQualifiers();
  if (!t.isRef() || s.isRef()) return;
  if (isNullPointerConstant(expr)) return;
  if (t === Types.TEQREF && s.isArithmetic()) return;
  reportError(loc,
    `cannot convert '${expr.type.toString()}' to reference type '${targetType.toString()}' (use __cast(${castTypeArgSpelling(targetType)}, x) for an explicit conversion, or __ref_null for null)`);
}

// Pointer arithmetic: given the operand types of a binary `+`/`-`,
// return the pointee element type if one side is a pointer/array (the
// other being an integer), or null if it's not pointer arithmetic.
// Used by both constEval and codegen to consistently identify the
// pointee whose size scales the integer operand.
function pointerArithElemType(leftType, rightType) {
  const l = leftType.removeQualifiers();
  const r = rightType.removeQualifiers();
  if (l.isPointer() || l.isArray()) return l.baseType;
  if (r.isPointer() || r.isArray()) return r.baseType;
  return null;
}

// C99 6.3.1.1: integer promotions for bitfield expressions. A bitfield
// member smaller than int promotes to int (or unsigned int if it can't
// be represented as int). Non-bitfield expressions promote to themselves.
function promoteExprType(e) {
  const t = e.type;
  let bf = null;
  if ((e instanceof EMember || e instanceof EArrow) && e.memberDecl.bitWidth >= 0) {
    bf = e.memberDecl;
  }
  if (bf) {
    const bw = bf.bitWidth;
    const uq = t.removeQualifiers();
    const isSigned = uq === Types.TINT || uq === Types.TLONG || uq === Types.TSHORT || uq === Types.TSCHAR || uq === Types.TCHAR;
    if (isSigned || bw < 32) return Types.TINT;
    return Types.TUINT;
  }
  return t;
}

// Result type of a binary expression. Operands must be already decayed
// (so array types never reach here) and bitfield-promoted (so small
// types are already TINT/TUINT).
function computeBinaryType(op, leftType, rightType) {
  // Divergent absorbs — propagate so further ops on it stay sound.
  if (leftType.isDivergent() || rightType.isDivergent()) return Types.TDIVERGENT;
  const meta = AST.BinOp[op];
  // Comparison and logical operators return int.
  if (meta.isCompare || meta.isLogical) return Types.TINT;
  // Assignment operators return left type.
  if (meta.isAssign) return leftType;
  // Shift operators: result type is the promoted left operand type (C99 6.5.7).
  if (meta.isShift) {
    const uq = leftType.removeQualifiers();
    if (uq === Types.TCHAR || uq === Types.TSCHAR || uq === Types.TUCHAR ||
        uq === Types.TSHORT || uq === Types.TUSHORT || uq === Types.TBOOL) {
      return Types.TINT;
    }
    return uq;
  }
  // Pointer arithmetic.
  if (leftType.isPointer() && rightType.isInteger()) return leftType;
  if (rightType.isPointer() && leftType.isInteger() && op === "ADD") return rightType;
  if (leftType.isPointer() && rightType.isPointer() && op === "SUB") return Types.TLONG;
  return Types.usualArithmeticConversions(leftType, rightType);
}

// Build an EBinary, applying C semantics:
//   - reject ref-incompatible operators
//   - reject non-null int → ref on ASSIGN; reject any compound-assign on ref
//   - decay array/function operands (left only when not an assignment target)
//   - compute the result type via C99 promotion + usual arithmetic conversions
//   - insert implicit casts on operands to the common operation type
//
// `op` is the AST op string ("ADD", "SUB", "ASSIGN", "ADD_ASSIGN", ...).
// `loc` is typically the left operand's loc to match how chained binops
// report (the whole-expression start). Type-error diagnostics use
// `fatalError` so parsing halts at the first one, matching the parser's
// historic behavior.
function makeBinary(loc, op, left, right) {
  const meta = AST.BinOp[op];
  if (!meta) throw new Error(`makeBinary: unknown op '${op}'`);
  const opText = meta.text;
  const lIsRef = left.type.removeQualifiers().isRef();
  const rIsRef = right.type.removeQualifiers().isRef();
  // Refs: only ==, !=, &&, ||, ASSIGN are allowed.
  if (lIsRef || rIsRef) {
    if (op === "LT" || op === "GT" || op === "LE" || op === "GE") {
      fatalError(loc, `'${opText}' on reference type is not allowed (only ==, != for identity/null)`);
    }
    // Arithmetic / shift / bitwise on refs is meaningless.
    if (op === "ADD" || op === "SUB" || op === "MUL" || op === "DIV" ||
        op === "MOD" || meta.isShift || meta.isBitwise) {
      fatalError(loc, `'${opText}' on reference type is not allowed`);
    }
    // == / != involving refs: must be ref-vs-ref OR ref-vs-(null pointer constant).
    if (meta.isCompare && (op === "EQ" || op === "NE")) {
      if (lIsRef !== rIsRef && !isNullPointerConstant(lIsRef ? right : left)) {
        fatalError(loc,
          `'${opText}' between reference and non-reference requires the non-ref operand to be the literal 0 / NULL`);
      }
    }
  }
  // Compound assignment on ref: not allowed.
  if (lIsRef && meta.isAssign && op !== "ASSIGN") {
    fatalError(loc, `'${opText}' on reference type is not allowed`);
  }
  // Decay array/function operands. ASSIGN/compound's left is the lvalue
  // target — never decayed. ASSIGN's right decays only if the left is a
  // pointer (so `p = arr` works).
  const isPtrArith = (op === "ADD" || op === "SUB") &&
    (left.type.isPointer() || right.type.isPointer() ||
     left.type.isArray() || right.type.isArray());
  if (!meta.isAssign) {
    left = maybeDecay(left);
    right = maybeDecay(right);
  } else if (op === "ASSIGN" && left.type.isPointer()) {
    right = maybeDecay(right);
  }
  // Operand-compat: catch operator-illegal type combinations BEFORE
  // the cast/conversion logic. `int & float`, `struct + struct`,
  // `int << ptr`, etc. — none of these are fixable by an implicit
  // cast; reporting here gives a clean message and prevents downstream
  // cascades. Refs and ASSIGN have their own specific handling above.
  if (!typesAreOperandCompatible(op, left.type, right.type)) {
    reportError(loc,
      `invalid operands to binary '${opText}': '${left.type.toString()}' and '${right.type.toString()}'`);
    return new EBinary(loc, Types.TDIVERGENT, op, left, right);
  }
  // ASSIGN: validate RHS is assignment-compatible with LHS. EImplicitCast
  // isn't inserted on ASSIGN (codegen does the conversion), but we still
  // need to enforce the rules — otherwise `ref = 5` etc. silently miscompiles.
  if (op === "ASSIGN" &&
      !typesAreAssignmentCompatible(right.type, left.type, right)) {
    if (left.type.removeQualifiers().isRef() && !right.type.removeQualifiers().isRef()) {
      reportError(loc,
        `cannot convert '${right.type.toString()}' to reference type '${left.type.toString()}' (use __cast(${castTypeArgSpelling(left.type)}, x) for an explicit conversion, or __ref_null for null)`);
    } else {
      reportError(loc,
        `incompatible types in assignment: cannot convert '${right.type.toString()}' to '${left.type.toString()}'`);
    }
  }
  // Apply C99 6.3.1.1 integer promotions for bitfield operands.
  const resType = computeBinaryType(op, promoteExprType(left), promoteExprType(right));
  // Insert implicit casts on operands to the common op type. Skipped for:
  //   - assignment ops (handled by lvalue context, not arithmetic)
  //   - logical && / || (boolean coercion is per-operand, not common)
  //   - pointer arithmetic (operand types are deliberately mixed)
  //   - pointer comparisons (no implicit qualifier-stripping on pointee)
  //   - ref operands (== / != on refs is identity, no conversion)
  if (!meta.isAssign && !meta.isLogical) {
    const leftType = left.type;
    const rightType = right.type;
    const involvesRef = leftType.removeQualifiers().isRef() ||
                        rightType.removeQualifiers().isRef();
    const involvesPtr = leftType.isPointer() || rightType.isPointer();
    if (!isPtrArith && !involvesRef && !(meta.isCompare && involvesPtr)) {
      const opType = meta.isCompare
        ? Types.usualArithmeticConversions(leftType, rightType)
        : resType;
      left = maybeImplicitCast(left, opType);
      right = maybeImplicitCast(right, opType);
    }
  }
  return new EBinary(loc, resType, op, left, right);
}

// Mark `expr` as having its address taken — promotes the underlying
// DVar from REGISTER to MEMORY allocation. Walks through EMember and
// (for array elements) ESubscript to find the root storage.
function markAddressTaken(expr) {
  if (!expr) return;
  if (expr instanceof EIdent) {
    if (expr.decl && expr.decl instanceof DVar) {
      expr.decl.allocClass = Types.AllocClass.MEMORY;
    }
  } else if (expr instanceof EMember) {
    markAddressTaken(expr.base);
  } else if (expr instanceof ESubscript) {
    if (expr.array.type && expr.array.type.isArray()) {
      markAddressTaken(expr.array);
    }
  }
}

// Build an EUnary, applying C semantics. Dispatches on `op`:
//   OP_PRE_INC / OP_PRE_DEC / OP_POST_INC / OP_POST_DEC: reject ref operand
//   OP_ADDR: reject bitfield-member, ref, GC struct field, GC array elem;
//            mark the underlying decl as memory-allocated
//   OP_DEREF: reject ref operand; decay array/function operand
//   OP_POS / OP_NEG / OP_BNOT: reject ref operand
//   OP_LNOT: ref allowed (boolean coercion sugar = __ref_is_null)
function makeUnary(loc, op, operand) {
  const isRef = operand.type && operand.type.removeQualifiers().isRef();
  switch (op) {
    case "OP_PRE_INC": case "OP_POST_INC":
      if (isRef) fatalError(loc, `'++' on reference type is not allowed`);
      break;
    case "OP_PRE_DEC": case "OP_POST_DEC":
      if (isRef) fatalError(loc, `'--' on reference type is not allowed`);
      break;
    case "OP_ADDR":
      if ((operand instanceof EMember || operand instanceof EArrow) &&
          operand.memberDecl.bitWidth >= 0) {
        fatalError(loc, `Cannot take address of bit-field member '${operand.memberDecl.name}'`);
      }
      if (isRef) {
        fatalError(loc, `Cannot take address of ${operand.type.removeQualifiers().toString()} variable`);
      }
      if (operand instanceof EMember && operand.base && operand.base.type &&
          operand.base.type.removeQualifiers().isGCStruct()) {
        fatalError(loc, `cannot take address of GC struct field`);
      }
      if (operand instanceof ESubscript && operand.array && operand.array.type &&
          operand.array.type.removeQualifiers().isGCArray()) {
        fatalError(loc, `cannot take address of GC array element`);
      }
      markAddressTaken(operand);
      break;
    case "OP_DEREF":
      if (isRef) {
        fatalError(loc, `unary '*' on reference type '${operand.type.toString()}' is not allowed (use '->' for fields, or just access the ref directly)`);
      }
      operand = maybeDecay(operand);
      break;
    case "OP_POS":
      if (isRef) fatalError(loc, `unary '+' on reference type is not allowed`);
      break;
    case "OP_NEG":
      if (isRef) fatalError(loc, `unary '-' on reference type is not allowed`);
      break;
    case "OP_BNOT":
      if (isRef) fatalError(loc, `unary '~' on reference type is not allowed`);
      break;
    case "OP_LNOT":
      operand = maybeDecay(operand);
      if (!isBoolContextType(operand.type)) {
        reportError(loc,
          `unary '!' requires a scalar operand, got '${operand.type.toString()}'`);
      }
      break;
  }
  return new EUnary(loc, Types.computeUnaryType(op, operand.type), op, operand);
}

// Build an SReturn, applying C semantics:
//   - decay array/function expression
//   - reject non-null int → ref when return type is a ref
//   - implicit-cast to the function's return type
// retType may be null (e.g., void function — caller passes null and the
// expr is just attached as-is). expr may also be null for `return;`.
function makeReturn(loc, expr, retType) {
  // C99 §6.8.6.4: a `return` with no value in a non-void function is a
  // constraint violation. C23 §6.8.6.4 relaxed the void case: `return EXPR;`
  // in a void function is now legal IFF EXPR's type is also void (i.e.,
  // `return void_func();` to forward through). Accept the C23 form for
  // GCC/clang compatibility — both have accepted this as an extension for
  // decades and real-world C code (including tinyemu) relies on it.
  // (We tolerate `retType === null` callers, e.g. legacy/synthesized
  // sites — they explicitly opt out by passing null.)
  if (retType !== null) {
    const rt = retType.removeQualifiers();
    if (!expr && !rt.isVoid()) {
      reportError(loc,
        `non-void function returns no value (return type is '${retType.toString()}')`);
    } else if (expr && rt.isVoid() && !expr.type.removeQualifiers().isVoid()) {
      reportError(loc,
        `void function should not return a value`);
    }
  }
  if (!expr) return new SReturn(loc, null);
  expr = maybeDecay(expr);
  if (retType) {
    expr = maybeImplicitCast(expr, retType);
  }
  return new SReturn(loc, expr);
}

// Build an ECast (explicit cast `(T)expr`), applying C semantics:
//   - decay array/function operand
//   - reject ref↔non-ref except (refT)0 / (refT)NULL
function makeCast(loc, targetType, expr) {
  expr = maybeDecay(expr);
  const tIsRef = targetType.removeQualifiers().isRef();
  const sIsRef = expr.type && expr.type.removeQualifiers().isRef();
  if (tIsRef || sIsRef) {
    if (tIsRef && !sIsRef && isNullPointerConstant(expr)) {
      // (refT)0 / (refT)NULL — typed null pointer constant.
      return new ECast(loc, targetType, targetType, expr);
    }
    fatalError(loc, "Cannot cast to or from a reference type; use __cast(T, x) (or __ref_cast for GC ref downcast)");
  }
  return new ECast(loc, targetType, targetType, expr);
}

// Resolve a member-name lookup against a struct/union type. Returns
// the chain of DVar field decls leading to the target (length 1 for a
// direct field, length >1 when traversing anonymous nested structs),
// or null if the name doesn't resolve. Pure — depends only on the type
// and its tagDecl.members.
function lookupMemberChain(type, name) {
  const ut = type.removeQualifiers();
  if (ut.tagDecl && ut.tagDecl.members) {
    for (const m of ut.tagDecl.members) {
      if (!(m instanceof DVar)) continue;
      if (m.name === name) return [m];
      // Recurse into anonymous nested struct/union members.
      if (!m.name && m.type && m.type.tagDecl && m.type.tagDecl.members) {
        const sub = lookupMemberChain(m.type, name);
        if (sub) return [m, ...sub];
      }
    }
  }
  return null;
}

// Synthesize a placeholder DVar for error recovery. Used by makeIdent /
// makeMember / makeArrow when the name doesn't resolve — we report the
// diagnostic, then return a placeholder so downstream construction can
// continue without nulls. The placeholder's type is divergent so any
// operations on it stay well-typed.
function _placeholderDVar(loc, name) {
  return new DVar(loc, name, Types.TDIVERGENT, Types.StorageClass.NONE, null);
}

// Build a member-access expression `base.name`. Looks up the field
// (handling anonymous-nested chains). On miss, reports a recoverable
// diagnostic and constructs the EMember with a synthesized placeholder
// DVar (divergent-typed) so the parse can continue. After this returns,
// EMember always has a non-null memberDecl.
function makeMember(loc, base, name) {
  // The `.` operator requires struct/union on the left. GC struct refs use
  // `->` (they are reference values, not aggregates). Without this gate,
  // `int x; x.foo` would crash later in lookupMemberChain or in codegen.
  const bt = base.type.removeQualifiers();
  if (bt.isGCStruct()) {
    reportError(loc,
      `'.' on GC struct ref '${base.type.toString()}' is not allowed — use '->'`);
    return new EMember(loc, Types.TDIVERGENT, base, _placeholderDVar(loc, name));
  }
  if (!bt.isStruct() && !bt.isUnion() && !bt.isDivergent()) {
    reportError(loc,
      `left operand of '.' must have struct or union type, got '${base.type.toString()}'`);
    return new EMember(loc, Types.TDIVERGENT, base, _placeholderDVar(loc, name));
  }
  const chain = lookupMemberChain(base.type, name);
  if (!chain) {
    reportError(loc, `'${base.type.toString()}' has no member named '${name}'`);
    return new EMember(loc, Types.TDIVERGENT, base, _placeholderDVar(loc, name));
  }
  let result = base;
  for (const m of chain) {
    result = new EMember(loc, m.type, result, m);
  }
  return result;
}

// Build a pointer-arrow expression `base->name`. For GC struct refs
// (one-indirection by design), build an EMember chain directly — GC field
// access is dispatched in codegen by checking that the EMember base is a
// GC struct ref. For other pointer-to-struct types, decay the base if
// needed and build EArrow + EMember chain.
function makeArrow(loc, base, name) {
  let bt = base.type.removeQualifiers();
  if (bt.isGCStruct()) {
    const chain = lookupMemberChain(bt, name);
    if (!chain) {
      reportError(loc, `'${base.type.toString()}' has no member named '${name}'`);
      return new EMember(loc, Types.TDIVERGENT, base, _placeholderDVar(loc, name));
    }
    let result = base;
    for (const m of chain) result = new EMember(loc, m.type, result, m);
    return result;
  }
  base = maybeDecay(base);
  bt = base.type.removeQualifiers();
  // `->` requires a pointer-to-struct/union on the left. Without this
  // gate, `struct S s; s->a` would find a member in the (non-pointer)
  // struct type and silently build an EArrow with a non-pointer base
  // — codegen later crashes dereferencing tagDecl on something that
  // isn't a tag.
  if (!bt.isPointer() && !bt.isDivergent()) {
    reportError(loc,
      `left operand of '->' must be a pointer to struct or union, got '${base.type.toString()}'`);
    return new EArrow(loc, Types.TDIVERGENT, base, _placeholderDVar(loc, name));
  }
  if (bt.isPointer()) {
    const pointee = bt.baseType.removeQualifiers();
    if (!pointee.isStruct() && !pointee.isUnion() && !pointee.isDivergent()) {
      reportError(loc,
        `left operand of '->' must point to struct or union, got pointer to '${bt.baseType.toString()}'`);
      return new EArrow(loc, Types.TDIVERGENT, base, _placeholderDVar(loc, name));
    }
    bt = bt.baseType;
  }
  const chain = lookupMemberChain(bt, name);
  if (!chain) {
    reportError(loc, `'${base.type.toString()}' has no member named '${name}'`);
    return new EArrow(loc, Types.TDIVERGENT, base, _placeholderDVar(loc, name));
  }
  const first = chain[0];
  let result = new EArrow(loc, first.type, base, first);
  for (let i = 1; i < chain.length; i++) {
    result = new EMember(loc, chain[i].type, result, chain[i]);
  }
  return result;
}

// Build an EIdent from a name resolved through a scope. On miss, reports
// a recoverable diagnostic and synthesizes a placeholder DVar so
// EIdent.decl is always non-null.
//
// `scope` is anything with `.get(name)` returning a DVar / DFunc /
// DEnumConst / null — typically the parser's varScope.
function makeIdent(loc, name, scope) {
  const decl = scope.get(name);
  if (decl instanceof DVar)       return new EIdent(loc, decl.type, decl);
  if (decl instanceof DFunc)      return new EIdent(loc, decl.type, decl);
  if (decl instanceof DEnumConst) return new EIdent(loc, Types.TINT, decl);
  reportError(loc, `Undeclared identifier '${name}'`);
  return new EIdent(loc, Types.TDIVERGENT, _placeholderDVar(loc, name));
}

// Build an ESubscript, applying C semantics:
//   - reject commutative form `0[arr]` (we choose not to support it)
//   - reject subscript on a reference type
//   - decay an array base to a pointer (GC arrays stay — they aren't C arrays)
//   - infer element type from the base's pointer/array element
//
// Diagnostics flow through the active `withDiag` sink. Always returns an
// ESubscript (best-effort even on errors).
function makeSubscript(loc, base, index) {
  const baseUt = base.type.removeQualifiers();
  const idxUt = index.type.removeQualifiers();
  // Reverse-order subscript (`5[arr]`) — rejected as our compiler
  // doesn't support C99's commutative form.
  if (baseUt.isInteger() &&
      (idxUt.isPointer() || idxUt.isArray())) {
    reportError(loc, "Commutative subscript (e.g. 0[arr]) is not supported; write arr[0] instead");
  }
  // Base must be pointer / array / GC-array. Without this check
  // codegen would emit `base_addr + idx*sizeof(elem)` against a
  // non-pointer base value (e.g. a struct's wasm representation),
  // producing a wild memory read.
  const baseIsIndexable =
    baseUt.isArray() ||
    baseUt.isPointer() ||
    baseUt.isGCArray();
  // Refs that aren't GC arrays (e.g. eqref, GC structs, externref) —
  // give the helpful `__array(T)` hint. GC_ARRAY is handled as
  // indexable above; isRef() also matches it, so the order matters.
  if (!baseIsIndexable && baseUt.isRef()) {
    reportError(loc,
      `subscript '[]' on reference type '${base.type.toString()}' is not allowed (use __array(T) for indexable GC storage)`);
  } else if (!baseIsIndexable && !baseUt.isDivergent()) {
    reportError(loc,
      `subscripted value is not an array, pointer, or vector — got '${base.type.toString()}'`);
  }
  // Index must be integer. Otherwise codegen multiplies a non-int
  // (e.g. another pointer's bit-value) by sizeof(elem) and adds it to
  // base — silent wild memory access.
  if (!idxUt.isInteger() && !idxUt.isDivergent()) {
    reportError(loc,
      `array subscript must be of integer type, got '${index.type.toString()}'`);
  }
  let elemType = Types.TINT;
  if (baseIsIndexable) elemType = baseUt.baseType;
  // GC arrays don't decay; keep them as the array operand.
  const arrayOperand = baseUt.isGCArray() ? base : maybeDecay(base);
  return new ESubscript(loc, elemType, arrayOperand, index);
}

// Build an ECall, applying C semantics:
//   - decay callee (function name → function pointer; array → ptr)
//   - decay each argument
//   - reject ref-conversion errors on declared params
//   - reject ref-typed varargs
//   - implicit-cast each fixed arg to its parameter type
//   - default-argument promotion (float → double) on varargs
//
// Diagnostics flow through the active `withDiag` sink — no callback
// threading. Always returns an ECall (best-effort even on errors).
function makeCall(loc, callee, args) {
  callee = maybeDecay(callee);
  const calleeType = callee.type;
  let funcType = null;
  if (calleeType.isPointer() &&
      calleeType.baseType.isFunction()) {
    funcType = calleeType.baseType;
  } else if (!calleeType.isDivergent()) {
    // The callee must be a function or pointer-to-function (after
    // decay). Without this gate, `int x; x();` would build an ECall
    // with a non-function callee — codegen later crashes computing
    // the function-pointer call shape.
    reportError(loc,
      `called object is not a function or function pointer; got '${callee.type.toString()}'`);
    return new ECall(loc, callee, args);
  }
  // Decay all arguments first; pointer-typed params and varargs alike
  // receive pointer values, never arrays.
  for (let i = 0; i < args.length; i++) args[i] = maybeDecay(args[i]);
  if (funcType) {
    const paramTypes = funcType.getParamTypes();
    const numFixed = paramTypes.length;
    // Validation: only meaningful when the prototype declared its params.
    if (!funcType.hasUnspecifiedParams) {
      if (funcType.isVarArg) {
        if (args.length < numFixed) {
          reportError(loc,
            `too few arguments to function call (expected at least ${numFixed}, got ${args.length})`);
        }
        for (let i = numFixed; i < args.length; i++) {
          if (args[i].type.removeQualifiers().isRef()) {
            reportError(loc,
              `cannot pass reference type '${args[i].type.toString()}' as a variadic argument — vararg storage uses linear memory which can't hold GC references`);
          }
        }
      } else if (args.length !== numFixed) {
        reportError(loc,
          `${args.length < numFixed ? 'too few' : 'too many'} arguments to function call (expected ${numFixed}, got ${args.length})`);
      }
    }
    // Implicit casts on fixed arguments.
    for (let i = 0; i < args.length && i < numFixed; i++) {
      args[i] = maybeImplicitCast(args[i], paramTypes[i]);
    }
    // Default-argument promotion (C99 6.5.2.2/6) for varargs: float → double.
    if (funcType.isVarArg) {
      for (let i = numFixed; i < args.length; i++) {
        if (args[i].type.removeQualifiers() === Types.TFLOAT) {
          args[i] = maybeImplicitCast(args[i], Types.TDOUBLE);
        }
      }
    }
  }
  return new ECall(loc, callee, args);
}

// TUnit constructor
class TUnit {
  constructor(filename) {
    this.filename = filename;
    this.importedFunctions = [];
    this.definedFunctions = [];
    this.staticFunctions = [];
    this.declaredFunctions = [];
    this.localDeclaredFunctions = [];
    this.definedVariables = [];
    this.externVariables = [];
    this.localExternVariables = [];
    this.requiredSources = new Set();
    this.minStackBytes = 0;
    this.exportDirectives = [];
    this.exceptionTags = [];
    Object.seal(this);
  }
}
function makeTUnit(filename) { return new TUnit(filename); }

return {
  Scope,
  Expr, Stmt, Decl,
  DVar, DFunc, DTag, DExceptionTag, DEnumConst,
  EInt, EFloat, EString, EIdent, EBinary, EUnary, ETernary, ECall,
  ESubscript, EMember, EArrow, ECast, ESizeofExpr, ESizeofType,
  EAlignofExpr, EAlignofType, EComma, EInitList, EIntrinsic, EWasm,
  ECompoundLiteral, EImplicitCast, EDecay, EGCNew,
  SExpr, SDecl, SCompound, SIf, SWhile, SDoWhile, SFor,
  SBreak, SContinue, SReturn, SSwitch, SCase, SGoto, SLabel, SEmpty,
  STryCatch, SThrow,
  makeTUnit,
  // C-semantics-aware builders
  maybeImplicitCast, typesAreAssignmentCompatible, typesAreOperandCompatible,
  isBoolContextType,
  maybeDecay, isNullPointerConstant, rejectNonZeroToRef,
  pointerArithElemType,
  promoteExprType, computeBinaryType, markAddressTaken,
  makeCall, makeSubscript, makeBinary, makeUnary, makeReturn, makeCast,
  makeMember, makeArrow, makeIdent, lookupMemberChain,
  // Linearity tagging for optimizer correctness checks
  Linearity, joinLinearity,
  // Op metadata registries (text, linearity, classification flags)
  BinOp, UnOp,
  // Generic traversal / substitution for AST→AST passes
  walkExpr, substituteParams,
  // Bubble-up metadata container
  TreeBag,
};
})();

// ====================
// constEvalItem / constEvalInt — typed integer constant evaluator
// ====================
// constEvalItem returns ConstEval.Item (value + type) or null.
// constEvalInt is a thin wrapper returning BigInt or null for callers
// that don't need the type.

function constEvalItem(expr) {
  if (!expr) return null;
  switch (expr.constructor) {
    case AST.EInt: return new ConstEval.Item(expr.value, expr.type);
    case AST.EIdent:
      if (expr.decl && expr.decl instanceof AST.DEnumConst)
        return new ConstEval.Item(expr.decl.value, expr.type);
      return null;
    case AST.EBinary: {
      const l = constEvalItem(expr.left), r = constEvalItem(expr.right);
      if (l === null || r === null) return null;
      return ConstEval.binary(expr.op, l, r);
    }
    case AST.EUnary: {
      if (expr.op === "OP_ADDR") {
        const inner = expr.operand;
        if (inner instanceof AST.EArrow || inner instanceof AST.EMember) {
          const base = constEvalItem(inner.base);
          if (base !== null) return new ConstEval.Item(base.value + BigInt(inner.memberDecl.byteOffset), expr.type);
        }
        return null;
      }
      const a = constEvalItem(expr.operand);
      if (a === null) return null;
      return ConstEval.unary(expr.op, a);
    }
    case AST.EImplicitCast: {
      const inner = constEvalItem(expr.expr);
      if (inner === null) return null;
      return new ConstEval.Item(inner.value, expr.type);
    }
    case AST.ETernary: {
      const c = constEvalItem(expr.condition);
      if (c === null) return null;
      return constEvalItem(c.value !== 0n ? expr.thenExpr : expr.elseExpr);
    }
    case AST.ECast: {
      const inner = constEvalItem(expr.expr);
      if (inner === null) return null;
      return new ConstEval.Item(inner.value, expr.type);
    }
    case AST.ESizeofExpr: return new ConstEval.Item(BigInt(expr.expr.type.size), Types.TUINT);
    case AST.ESizeofType: return new ConstEval.Item(BigInt(expr.operandType.size), Types.TUINT);
    case AST.EAlignofExpr: return new ConstEval.Item(BigInt(expr.expr.type.align), Types.TUINT);
    case AST.EAlignofType: return new ConstEval.Item(BigInt(expr.operandType.align), Types.TUINT);
    default: return null;
  }
}

function constEvalInt(expr) {
  const item = constEvalItem(expr);
  return item !== null ? item.value : null;
}

// ====================
// INLINER — AST→AST optimization pass
// ====================
//
// One pass that walks each function body bottom-up and folds constant
// subexpressions (and dead branches under constant conditions). Named
// INLINER because it's the home for inlining + tree-shaking too once
// those land — the three optimizations want to feed each other. For
// now: constant folding only.
//
// Strategy:
//   - Bottom-up post-order: fold children, then try to fold the node.
//   - On replacement, return a fresh AST node (preserve the original
//     node's loc and type). Constructors are dumb, so we can build
//     directly without surprise wrapping; type-changing rewrites would
//     route through make* helpers, but folding never changes types.
//   - On no change, return the original node identity. Callers compare
//     by `===` to skip rebuilds, which keeps AST allocation O(changed).
//   - Side-effecting ops (ASSIGN, ++/--, function calls, dereferences,
//     intrinsics, etc.) are walked into but never folded as a whole.
//   - DFunc.body and DVar.initExpr are mutated in place (sealed but
//     writable), matching how the rest of the codebase already handles
//     post-construction updates.

const INLINER = (() => {

// True if `op` is the AST tag for an op with no value-producing side
// effect of its own — folding the operands and rewriting to a literal
// is OK iff this is true AND the operands are themselves pure.
function isPureBinop(op) {
  return !AST.BinOp[op].isAssign;
}

// Evaluate a pure integer binary op on BigInt operands. Returns the
// result as a BigInt, or null if not foldable (e.g. div by zero, shift
// out of range). Caller is responsible for truncating to the result type.
// Fold an expression. Bottom-up: fold children first.
function foldExpr(expr) {
  if (!expr) return expr;
  switch (expr.constructor) {
    // True leaves — nothing inside to fold.
    case AST.EInt:
    case AST.EFloat:
    case AST.EString:
    case AST.EIdent:
    case AST.ESizeofType:
    case AST.EAlignofType:
      return expr;

    // sizeof(expr) / _Alignof(expr) don't evaluate their operand at
    // runtime — leave the inner expression alone so we don't create
    // surprising side-effect changes.
    case AST.ESizeofExpr:
    case AST.EAlignofExpr:
      return expr;

    case AST.EUnary: {
      const op = expr.op;
      const operand = foldExpr(expr.operand);
      // Skip side-effecting / addressing ops; only rebuild if the operand changed.
      if (op === "OP_PRE_INC"  || op === "OP_PRE_DEC" ||
          op === "OP_POST_INC" || op === "OP_POST_DEC" ||
          op === "OP_ADDR"     || op === "OP_DEREF") {
        return operand === expr.operand ? expr
          : new AST.EUnary(expr.loc, expr.type, op, operand);
      }
      const a = constEvalItem(operand);
      if (a !== null && expr.type.isInteger()) {
        const r = ConstEval.unary(op, a);
        if (r !== null) {
          return new AST.EInt(expr.loc, expr.type, Types.truncateConstInt(r.value, expr.type));
        }
      }
      return operand === expr.operand ? expr
        : new AST.EUnary(expr.loc, expr.type, op, operand);
    }

    case AST.EBinary: {
      const left = foldExpr(expr.left);
      const right = foldExpr(expr.right);
      const op = expr.op;
      if (!isPureBinop(op)) {
        return (left === expr.left && right === expr.right) ? expr
          : new AST.EBinary(expr.loc, expr.type, op, left, right);
      }
      const li = constEvalItem(left);
      if (op === "LAND" && li !== null && li.value === 0n) return new AST.EInt(expr.loc, expr.type, 0n);
      if (op === "LOR"  && li !== null && li.value !== 0n) return new AST.EInt(expr.loc, expr.type, 1n);
      const ri = constEvalItem(right);
      if (li !== null && ri !== null && expr.type.isInteger()) {
        const r = ConstEval.binary(op, li, ri);
        if (r !== null) {
          return new AST.EInt(expr.loc, expr.type, Types.truncateConstInt(r.value, expr.type));
        }
      }
      return (left === expr.left && right === expr.right) ? expr
        : new AST.EBinary(expr.loc, expr.type, op, left, right);
    }

    case AST.ETernary: {
      const cond = foldExpr(expr.condition);
      const cv = constEvalInt(cond);
      if (cv !== null) {
        // Pick the live branch; fold and return it directly (its type
        // matches expr.type by the parser's ternary type computation,
        // possibly via an EImplicitCast wrapper).
        return foldExpr(cv !== 0n ? expr.thenExpr : expr.elseExpr);
      }
      const thenE = foldExpr(expr.thenExpr);
      const elseE = foldExpr(expr.elseExpr);
      return (cond === expr.condition && thenE === expr.thenExpr && elseE === expr.elseExpr) ? expr
        : new AST.ETernary(expr.loc, expr.type, cond, thenE, elseE);
    }

    case AST.ECall: {
      const callee = foldExpr(expr.callee);
      let changed = callee !== expr.callee;
      const newArgs = expr.arguments.map(a => {
        const folded = foldExpr(a);
        if (folded !== a) changed = true;
        return folded;
      });
      const call = changed ? new AST.ECall(expr.loc, callee, newArgs) : expr;
      // No manual liveness bookkeeping here — the call's children (the
      // EDecay/EIdent on the callee) bubble the DFunc into the
      // referencedFunctions bag automatically. Try inlining; on success,
      // recurse-fold so cascades like square(5) → 25 collapse in one pass.
      const inlined = tryInline(call);
      return inlined !== null ? foldExpr(inlined) : call;
    }

    case AST.ESubscript: {
      const arr = foldExpr(expr.array);
      const idx = foldExpr(expr.index);
      return (arr === expr.array && idx === expr.index) ? expr
        : new AST.ESubscript(expr.loc, expr.type, arr, idx);
    }

    case AST.EMember: {
      const base = foldExpr(expr.base);
      return base === expr.base ? expr
        : new AST.EMember(expr.loc, expr.type, base, expr.memberDecl);
    }

    case AST.EArrow: {
      const base = foldExpr(expr.base);
      return base === expr.base ? expr
        : new AST.EArrow(expr.loc, expr.type, base, expr.memberDecl);
    }

    case AST.ECast: {
      const inner = foldExpr(expr.expr);
      const a = constEvalItem(inner);
      if (a !== null && expr.targetType.isInteger()) {
        return new AST.EInt(expr.loc, expr.targetType, Types.truncateConstInt(a.value, expr.targetType));
      }
      return inner === expr.expr ? expr
        : new AST.ECast(expr.loc, expr.type, expr.targetType, inner);
    }

    case AST.EImplicitCast: {
      const inner = foldExpr(expr.expr);
      const a = constEvalItem(inner);
      if (a !== null && expr.type.isInteger()) {
        return new AST.EInt(expr.loc, expr.type, Types.truncateConstInt(a.value, expr.type));
      }
      return inner === expr.expr ? expr
        : new AST.EImplicitCast(expr.loc, expr.type, inner);
    }

    case AST.EDecay: {
      const inner = foldExpr(expr.operand);
      return inner === expr.operand ? expr
        : new AST.EDecay(expr.loc, expr.type, inner);
    }

    case AST.EComma: {
      let changed = false;
      const newExprs = expr.expressions.map(e => {
        const folded = foldExpr(e);
        if (folded !== e) changed = true;
        return folded;
      });
      return changed
        ? new AST.EComma(expr.loc, expr.type, newExprs)
        : expr;
    }

    case AST.EInitList: {
      let changed = false;
      const newElems = expr.elements.map(e => {
        const folded = foldExpr(e);
        if (folded !== e) changed = true;
        return folded;
      });
      return changed
        ? new AST.EInitList(expr.loc, expr.type, newElems, expr.designators, expr.unionMemberIndex)
        : expr;
    }

    case AST.EIntrinsic: {
      let changed = false;
      const newArgs = expr.args.map(a => {
        const folded = foldExpr(a);
        if (folded !== a) changed = true;
        return folded;
      });
      return changed
        ? new AST.EIntrinsic(expr.loc, expr.type, expr.intrinsicKind, newArgs, expr.argType)
        : expr;
    }

    case AST.EWasm: {
      let changed = false;
      const newArgs = expr.args.map(a => {
        const folded = foldExpr(a);
        if (folded !== a) changed = true;
        return folded;
      });
      return changed
        ? new AST.EWasm(expr.loc, expr.type, newArgs, expr.bytes)
        : expr;
    }

    case AST.EGCNew: {
      let changed = false;
      const newArgs = expr.args.map(a => {
        const folded = foldExpr(a);
        if (folded !== a) changed = true;
        return folded;
      });
      return changed
        ? new AST.EGCNew(expr.loc, expr.type, newArgs)
        : expr;
    }

    case AST.ECompoundLiteral: {
      // ECompoundLiteral is frozen — fold the init list and rebuild via
      // _withChildren. Codegen finds the current node via the bag.
      const folded = foldExpr(expr.initList);
      return folded === expr.initList ? expr : expr._withChildren([folded]);
    }

    default:
      return expr;
  }
}

// Fold a statement bottom-up. Eliminates dead branches when conditions
// are constant. Returns a (possibly new) statement; callers compare by
// `===` to skip rebuilds.
function foldStmt(stmt) {
  if (!stmt) return stmt;
  switch (stmt.constructor) {
    case AST.SEmpty:
    case AST.SBreak:
    case AST.SContinue:
    case AST.SLabel:
    case AST.SGoto:
    case AST.SCase:
      return stmt;

    case AST.SExpr: {
      const e = foldExpr(stmt.expr);
      return e === stmt.expr ? stmt : new AST.SExpr(stmt.loc, e);
    }

    case AST.SDecl: {
      // Mutate each DVar's initExpr in place. DVars are sealed-but-writable.
      for (const d of stmt.declarations) {
        if (d instanceof AST.DVar && d.initExpr) {
          const folded = foldExpr(d.initExpr);
          if (folded !== d.initExpr) d.initExpr = folded;
        }
      }
      return stmt;
    }

    case AST.SCompound: {
      let changed = false;
      const newStmts = stmt.statements.map(s => {
        const folded = foldStmt(s);
        if (folded !== s) changed = true;
        return folded;
      });
      return changed
        ? new AST.SCompound(stmt.loc, newStmts, stmt.labels)
        : stmt;
    }

    case AST.SIf: {
      const cond = foldExpr(stmt.condition);
      const cv = constEvalInt(cond);
      // Dead-branch elimination when the condition is a known constant.
      if (cv === 0n) return stmt.elseBranch ? foldStmt(stmt.elseBranch) : new AST.SEmpty(stmt.loc);
      if (cv !== null && cv !== 0n) return foldStmt(stmt.thenBranch);
      const thenB = foldStmt(stmt.thenBranch);
      const elseB = foldStmt(stmt.elseBranch);
      return (cond === stmt.condition && thenB === stmt.thenBranch && elseB === stmt.elseBranch)
        ? stmt
        : new AST.SIf(stmt.loc, cond, thenB, elseB);
    }

    case AST.SWhile: {
      const cond = foldExpr(stmt.condition);
      const body = foldStmt(stmt.body);
      // while (0) — body never runs. Replace with empty.
      if (constEvalInt(cond) === 0n) return new AST.SEmpty(stmt.loc);
      return (cond === stmt.condition && body === stmt.body)
        ? stmt
        : new AST.SWhile(stmt.loc, cond, body);
    }

    case AST.SDoWhile: {
      const body = foldStmt(stmt.body);
      const cond = foldExpr(stmt.condition);
      return (body === stmt.body && cond === stmt.condition)
        ? stmt
        : new AST.SDoWhile(stmt.loc, body, cond);
    }

    case AST.SFor: {
      const init = stmt.init ? foldStmt(stmt.init) : null;
      const cond = stmt.condition ? foldExpr(stmt.condition) : null;
      const incr = stmt.increment ? foldExpr(stmt.increment) : null;
      const body = foldStmt(stmt.body);
      return (init === stmt.init && cond === stmt.condition &&
              incr === stmt.increment && body === stmt.body)
        ? stmt
        : new AST.SFor(stmt.loc, init, cond, incr, body);
    }

    case AST.SReturn: {
      if (!stmt.expr) return stmt;
      const e = foldExpr(stmt.expr);
      return e === stmt.expr ? stmt : new AST.SReturn(stmt.loc, e);
    }

    case AST.SSwitch: {
      const e = foldExpr(stmt.expr);
      const body = foldStmt(stmt.body);
      return (e === stmt.expr && body === stmt.body)
        ? stmt
        : new AST.SSwitch(stmt.loc, e, body);
    }

    case AST.STryCatch: {
      const tryB = foldStmt(stmt.tryBody);
      let changed = tryB !== stmt.tryBody;
      const newCatches = stmt.catches.map(c => {
        const newBody = foldStmt(c.body);
        if (newBody === c.body) return c;
        changed = true;
        return { ...c, body: newBody };
      });
      return changed
        ? new AST.STryCatch(stmt.loc, tryB, newCatches)
        : stmt;
    }

    case AST.SThrow: {
      let changed = false;
      const newArgs = stmt.args.map(a => {
        const folded = foldExpr(a);
        if (folded !== a) changed = true;
        return folded;
      });
      return changed
        ? new AST.SThrow(stmt.loc, stmt.tag, newArgs)
        : stmt;
    }

    default:
      return stmt;
  }
}

// ---------- Inlining ----------
//
// _inliningStack is the set of functions currently being inlined.
// While we're substituting body B for a call to F, we push F. Any
// recursive call to F encountered while folding B is left as a real
// call (because tryInline bails when the callee is on the stack).
// After we're done with F's body, we pop. This gives us natural
// recursion detection without a separate call-graph pass.
//
// Liveness no longer needs separate state — the AST itself bubbles up
// `referencedFunctions` via TreeBag, so once a function's body has been
// folded we can read its bag to see what it transitively references.
const _inliningStack = new Set();

// Predicate: is this body a single `return EXPR;`? Returns the return
// expression, or null if the body is anything more complex.
function singleReturnBody(body) {
  if (!body) return null;
  if (body instanceof AST.SReturn) return body.expr || null;
  if (body instanceof AST.SCompound &&
      body.statements.length === 1 &&
      body.statements[0] instanceof AST.SReturn) {
    return body.statements[0].expr || null;
  }
  return null;
}

// Try to inline a call. Returns the substituted expression on success,
// or null if the call should stay as a call. Conservative criteria:
//   - direct call (funcDecl set), with a body
//   - body is a single `return EXPR;`
//   - return EXPR is UNRESTRICTED (no side effects, deterministic)
//   - argument count matches parameter count
//   - all arguments are UNRESTRICTED (safe to substitute multiple times)
//   - callee is not currently being inlined (recursion detected via stack)
function tryInline(callExpr) {
  const decl = callExpr.funcDecl;
  if (!decl) return null;
  if (_inliningStack.has(decl)) return null;
  const def = decl.definition || decl;
  if (!def.body) return null;
  const returnExpr = singleReturnBody(def.body);
  if (!returnExpr) return null;
  if (returnExpr.linearity !== AST.Linearity.UNRESTRICTED) return null;
  const params = def.parameters || [];
  if (callExpr.arguments.length !== params.length) return null;
  for (const arg of callExpr.arguments) {
    if (arg.linearity !== AST.Linearity.UNRESTRICTED) return null;
  }
  const paramMap = new Map();
  for (let i = 0; i < params.length; i++) {
    paramMap.set(params[i], callExpr.arguments[i]);
  }
  // Push self onto the stack while substituting & re-folding the body,
  // so a recursive call to `decl` inside the body sees its callee as
  // already-being-inlined and bails.
  _inliningStack.add(decl);
  try {
    return AST.substituteParams(returnExpr, paramMap);
  } finally {
    _inliningStack.delete(decl);
  }
}

// Optimize a translation unit. Walk from "root" functions (entry points
// + exported + extern + address-taken) and fold their bodies; ECall
// folding records every reached callee as live and tries to inline.
// Anything never reached gets dropped from the unit at the end —
// inlining and tree-shaking fall out of the same walk.
function isRootFunction(f, unit) {
  // Anything not defined here can't be a root we own.
  if (!f.body) return false;
  // `main` is the conventional program entry.
  if (f.name === "main") return true;
  // Anything explicitly exported is a root.
  for (const [, decl] of unit.exportDirectives) if (decl === f) return true;
  // Extern-linkage functions might be called from another TU.
  if (f.storageClass === Types.StorageClass.EXTERN ||
      f.storageClass === Types.StorageClass.NONE) return true;
  return false;
}

function optimize(unit, options) {
  _inliningStack.clear();
  // Unified worklist for both functions and globals. We walk from real
  // roots (extern-linkage symbols, exports, main) and accumulate every
  // function / variable reachable from them via the AST bag. Anything
  // unreached at the end is dead and gets tree-shaken.
  const liveFuncs = new Set();
  const liveVars = new Set();
  const funcQ = [];
  const varQ = [];
  const enqueueFunc = (f) => {
    if (!f || liveFuncs.has(f)) return;
    liveFuncs.add(f);
    funcQ.push(f);
  };
  const enqueueVar = (v) => {
    if (!v || liveVars.has(v)) return;
    liveVars.add(v);
    varQ.push(v);
  };
  const visitRefs = (node) => {
    for (const f of node.referencedFunctions) enqueueFunc(f);
    for (const v of node.referencedVariables) enqueueVar(v);
  };
  // Seed: extern-linkage / exported / main funcs + non-static globals.
  for (const f of unit.definedFunctions) {
    if (isRootFunction(f, unit)) enqueueFunc(f);
  }
  // Export-directive targets are roots regardless of whether they're
  // called from anywhere in this TU. They may be a non-defining
  // declaration whose definition lives in another TU; without this seed
  // the tree-shake would drop the decl from `declaredFunctions` and the
  // linker would have nothing left to set `.definition` on.
  for (const [, decl] of unit.exportDirectives) enqueueFunc(decl);
  for (const v of unit.definedVariables) {
    if (v.storageClass !== Types.StorageClass.STATIC) enqueueVar(v);
  }
  // Drain to fixed point. We process funcs and vars together; either
  // queue might add to the other.
  while (funcQ.length > 0 || varQ.length > 0) {
    while (funcQ.length > 0) {
      const f = funcQ.shift();
      if (!f.body) continue;
      f.body = foldStmt(f.body);
      visitRefs(f.body);
      // Static locals are diverted out of the function body (they live
      // in `staticLocals`), so their initializers don't ride the body's
      // bag. Walk them explicitly — function-pointer tables in static
      // locals (e.g. Lua's searcher_C / searcher_Lua dispatch table)
      // are a real reference path.
      for (const v of (f.staticLocals || [])) {
        if (v.initExpr) {
          const folded = foldExpr(v.initExpr);
          if (folded !== v.initExpr) v.initExpr = folded;
          visitRefs(v.initExpr);
        }
      }
    }
    while (varQ.length > 0) {
      const v = varQ.shift();
      if (!v.initExpr) continue;
      const folded = foldExpr(v.initExpr);
      if (folded !== v.initExpr) v.initExpr = folded;
      visitRefs(v.initExpr);
    }
  }
  // Tree-shake. The bag-walk above transitively visited everything
  // reachable from roots; anything not in `live*` is genuinely dead.
  // - static funcs / vars: drop if unreached (TU-internal, safe).
  // - imported / extern / declared decls: also drop if unreached UNLESS
  //   --no-undefined, in which case the linker should be allowed to
  //   complain about every dangling reference for visibility. (Defined
  //   non-static decls are seeded as roots, so they're never filtered.)
  unit.staticFunctions = unit.staticFunctions.filter(f => liveFuncs.has(f));
  unit.definedVariables = unit.definedVariables.filter(
    v => v.storageClass !== Types.StorageClass.STATIC || liveVars.has(v));
  if (!options?.noUndefined) {
    unit.importedFunctions = unit.importedFunctions.filter(f => liveFuncs.has(f));
    unit.externVariables = unit.externVariables.filter(v => liveVars.has(v));
    unit.declaredFunctions = unit.declaredFunctions.filter(f => liveFuncs.has(f));
    unit.localExternVariables = unit.localExternVariables.filter(v => liveVars.has(v));
    unit.localDeclaredFunctions = unit.localDeclaredFunctions.filter(f => liveFuncs.has(f));
  }
  return unit;
}

return { optimize, foldExpr, foldStmt, tryInline };
})();

// ====================
// GOTO NORMALIZER — AST→AST transformation pass
// ====================
//
// C allows `goto L` to jump to any label `L:` within the same function,
// regardless of block scoping. WASM only allows `br` to *enclosing* block
// labels. Most of the gap is closed by the codegen's pre-scan (which opens a
// `block` for each forward label at the same compound level), but cross-
// block forward gotos — where `goto L` is in one branch and `L:` is in a
// sibling/cousin branch — fail to codegen.
//
// This pass detects such cases and rewrites the AST to put the label at a
// position structurally enclosing both the goto and its original location,
// preserving the original control-flow semantics. The transform is:
//
//   if (cond) {                       if (cond) {
//     goto L;                           goto L;
//   } else {            =====>        } else {
//     L: stmt;                          goto L;
//   }                                 }
//   /* continuation */                L: stmt;
//                                     /* continuation */
//
// The label and its tail (subsequent statements in the same compound) move
// to the LCA compound right after the subtree that contained the original
// label. The original position becomes `goto L` so the natural fall-through
// path still reaches the labeled stmt.
//
// Restrictions (bail with a clean diagnostic if violated):
//   - Hoisting must NOT cross a loop body boundary. Hoisting a label out of
//     a loop changes iteration semantics.
//   - The hoisted tail must NOT contain `break` or `continue` whose target
//     is a loop or switch crossed by the hoist.
//   - The labeled tail must be at the END of its containing compound (the
//     simple case). Mid-block labels with post-label stmts in nested
//     intermediate compounds are not handled by this pass.
//
// The pass iterates: each round transforms one cross-block label, then
// re-scans (transforms can reveal new opportunities or cause re-classifying
// of other gotos). Bounded by the label count.

const GOTO_NORMALIZER = (() => {

// Walk a function body, collecting per-label and per-goto location traces.
// Each trace is the chain of ancestor nodes from the function body (root)
// down to the SLabel/SGoto, in outer→inner order. SCompound nodes act as
// "scope boundaries" — gotos and labels are children of some SCompound.
//
// Returns:
//   labels: Map<SLabel, { compound, indexInCompound, trace }>
//   gotos:  Map<SGoto,  { compound, indexInCompound, trace }>
function collectTraces(body) {
  const labels = new Map();
  const gotos = new Map();

  // `nearestCompound` is the deepest SCompound on `trace` — the compound
  // that an SGoto/SLabel "belongs to" structurally, even if its immediate
  // parent is a control-flow node like an unbraced `if (cond) goto X;`.
  function nearestCompound(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
      if (trace[i] instanceof AST.SCompound) return trace[i];
    }
    return null;
  }

  function visit(node, trace) {
    if (!node) return;
    const ntrace = [...trace, node];

    if (node instanceof AST.SLabel) {
      const compound = nearestCompound(ntrace);
      // Index in compound is meaningful only if the label is a direct
      // child of the compound. Otherwise (e.g. `if (cond) L: stmt;`),
      // index is -1 to signal "non-direct child" — we won't apply the
      // hoist transform to such labels.
      const idx = compound ? compound.statements.indexOf(node) : -1;
      labels.set(node, { compound, indexInCompound: idx, trace: ntrace });
      return;
    }
    if (node instanceof AST.SGoto) {
      const compound = nearestCompound(ntrace);
      gotos.set(node, { compound, indexInCompound: -1, trace: ntrace });
      return;
    }

    if (node instanceof AST.SCompound) {
      for (const s of node.statements) visit(s, ntrace);
    } else if (node instanceof AST.SIf) {
      visit(node.thenBranch, ntrace);
      if (node.elseBranch) visit(node.elseBranch, ntrace);
    } else if (node instanceof AST.SWhile || node instanceof AST.SDoWhile) {
      visit(node.body, ntrace);
    } else if (node instanceof AST.SFor) {
      visit(node.init, ntrace);
      visit(node.body, ntrace);
    } else if (node instanceof AST.SSwitch) {
      visit(node.body, ntrace);
    } else if (node instanceof AST.STryCatch) {
      visit(node.tryBody, ntrace);
      for (const cc of node.catches) visit(cc.body, ntrace);
    }
    // Other Stmt subclasses (SExpr, SDecl, SReturn, SBreak, SContinue,
    // SEmpty) are leaves with no nested labels/gotos.
  }

  visit(body, []);
  return { labels, gotos };
}

// Returns the deepest common-prefix length of two traces. trace1[0..k-1]
// equals trace2[0..k-1], and they differ (or one ends) at index k.
function commonPrefixLength(trace1, trace2) {
  let i = 0;
  while (i < trace1.length && i < trace2.length && trace1[i] === trace2[i]) i++;
  return i;
}

// Classify a (goto, label) pair given their traces.
//   "structured-forward": label's compound is an ancestor of the goto's
//                         compound. The wasm `block` opened for the label
//                         wraps the goto's position, so `br` reaches it.
//                         Current codegen handles this; this pass skips.
//   "needs-transform":    everything else — either the goto's compound is
//                         an ancestor of the label's (jump INTO a nested
//                         scope), or they're in sibling/cousin subtrees.
//                         Both cases require hoisting the label to a
//                         position structurally enclosing the goto.
function classifyPair(gotoInfo, labelInfo) {
  const gotoTrace = gotoInfo.trace;
  if (gotoTrace.includes(labelInfo.compound)) return "structured-forward";
  return "needs-transform";
}

// Find the SCompound that's the LCA of the given traces (deepest common
// ancestor that is itself an SCompound, since insertions happen at compound
// level). Returns { lcaCompound, anchorStmt, anchorIndex } where anchorStmt
// is the statement in lcaCompound on the LABEL's path (the construct that
// transitively contains the label's branch), and anchorIndex is its index.
function findHoistTarget(gotoInfo, labelInfo) {
  const k = commonPrefixLength(gotoInfo.trace, labelInfo.trace);
  // Walk up from index k-1 to find the deepest SCompound that's a common
  // ancestor.
  let lcaCompound = null;
  for (let i = k - 1; i >= 0; i--) {
    if (gotoInfo.trace[i] instanceof AST.SCompound) {
      lcaCompound = gotoInfo.trace[i];
      break;
    }
  }
  if (!lcaCompound) return null;
  // Find the position of the next-level node on the LABEL's trace within
  // lcaCompound.statements. The next-level node is labelInfo.trace[lcaIdx+1]
  // where lcaIdx is the index of lcaCompound in labelInfo.trace.
  const lcaIdx = labelInfo.trace.indexOf(lcaCompound);
  if (lcaIdx < 0) return null;
  const childOnLabelPath = labelInfo.trace[lcaIdx + 1];
  if (!childOnLabelPath) return null;
  const anchorIndex = lcaCompound.statements.indexOf(childOnLabelPath);
  if (anchorIndex < 0) {
    // child is not directly in statements; it's wrapped by some control-flow
    // node that IS in statements. Find which statement contains it.
    for (let i = 0; i < lcaCompound.statements.length; i++) {
      if (containsNode(lcaCompound.statements[i], childOnLabelPath)) {
        return { lcaCompound, anchorStmt: lcaCompound.statements[i], anchorIndex: i };
      }
    }
    return null;
  }
  return { lcaCompound, anchorStmt: childOnLabelPath, anchorIndex };
}

// True if `tree` contains `node` somewhere in its sub-tree (matches by
// reference identity).
function containsNode(tree, node) {
  if (tree === node) return true;
  if (tree instanceof AST.SCompound) {
    return tree.statements.some(s => containsNode(s, node));
  }
  if (tree instanceof AST.SIf) {
    return containsNode(tree.thenBranch, node) ||
           (tree.elseBranch && containsNode(tree.elseBranch, node));
  }
  if (tree instanceof AST.SWhile || tree instanceof AST.SDoWhile) {
    return containsNode(tree.body, node);
  }
  if (tree instanceof AST.SFor) {
    return (tree.init && containsNode(tree.init, node)) ||
           containsNode(tree.body, node);
  }
  if (tree instanceof AST.SSwitch) return containsNode(tree.body, node);
  if (tree instanceof AST.STryCatch) {
    return containsNode(tree.tryBody, node) ||
           tree.catches.some(c => containsNode(c.body, node));
  }
  return false;
}

// Safety: check that hoisting `label` (in `labelInfo.compound`) up to
// `lcaCompound` is sound. Returns { ok: true } or { ok: false, reason: '...' }.
function checkHoistSafe(labelInfo, hoistTarget, body, switchBodies) {
  // Condition 1: lcaCompound must NOT itself be a switch body. Hoisting
  // into a switch body would interleave label/tail statements between case
  // blocks; the codegen's case-dispatch machinery already handles cross-
  // case-compound gotos directly, so leave those alone.
  if (switchBodies.has(hoistTarget.lcaCompound)) {
    return { ok: false, reason: `cannot hoist into a switch body — codegen handles cross-case gotos directly` };
  }

  // Condition 2: label and its tail (label + post-label stmts) are at the
  // END of labelCompound. In our simple model, the tail consists of
  // [labelCompound.statements from labelIdx onward]; we always include all
  // of those, so the tail-collapsing is safe within the labelCompound
  // itself. (The post-label stmts move with the tail.)

  // Condition 3: the path from labelCompound up to lcaCompound must NOT
  // cross a loop, switch, or try/catch body. Hoisting a label out of a
  // loop body changes the loop's iteration semantics; out of a switch
  // changes case dispatch + break semantics; out of a try-body would
  // move statements outside the protection of the corresponding catch
  // (and out of a catch-body would similarly change which throws are
  // re-caught).
  const trace = labelInfo.trace;
  const lcaIdx = trace.indexOf(hoistTarget.lcaCompound);
  for (let i = lcaIdx + 1; i < trace.length; i++) {
    const node = trace[i];
    if (node instanceof AST.SWhile || node instanceof AST.SDoWhile || node instanceof AST.SFor) {
      return { ok: false, reason: `cannot hoist label '${labelInfo.label?.name || '?'}' out of a loop body` };
    }
    if (node instanceof AST.SSwitch) {
      return { ok: false, reason: `cannot hoist label '${labelInfo.label?.name || '?'}' out of a switch body` };
    }
    if (node instanceof AST.STryCatch) {
      return { ok: false, reason: `cannot hoist label '${labelInfo.label?.name || '?'}' out of a try/catch body` };
    }
  }

  // Condition 4: the path from labelCompound up to (and through) the
  // anchor statement must consist of constructs whose fall-through naturally
  // exits to the position right after the anchor. This holds for SIf
  // branches (any branch falls out to right after the if) and SCompound
  // nesting; loops/switches are already ruled out.

  return { ok: true };
}

// Collect the set of SCompound nodes that are the body of an SSwitch in the
// function. Used by safety check to reject hoisting into a switch body.
function collectSwitchBodies(body) {
  const set = new Set();
  function visit(node) {
    if (!node) return;
    if (node instanceof AST.SCompound) {
      for (const s of node.statements) visit(s);
    } else if (node instanceof AST.SIf) {
      visit(node.thenBranch);
      visit(node.elseBranch);
    } else if (node instanceof AST.SWhile || node instanceof AST.SDoWhile) {
      visit(node.body);
    } else if (node instanceof AST.SFor) {
      visit(node.init);
      visit(node.body);
    } else if (node instanceof AST.SSwitch) {
      if (node.body instanceof AST.SCompound) set.add(node.body);
      visit(node.body);
    } else if (node instanceof AST.STryCatch) {
      visit(node.tryBody);
      for (const cc of node.catches) visit(cc.body);
    }
  }
  visit(body);
  return set;
}

// Perform the hoist transform. Returns the new function body (rebuilt).
//
// Layout of the resulting LCA compound (around the anchor stmt):
//
//   ...stmts before anchor...
//   modified anchor      (label-compound replaced with `goto L`)
//   goto __hoist_skip_N  (skip the hoisted region on natural fall-through)
//   L: ...tail...        (hoisted body)
//   __hoist_skip_N:      (resume natural fall-through)
//   ...stmts after anchor...
//
// The `goto __hoist_skip` + `__hoist_skip:` pair is essential: without it,
// any natural fall-through past the anchor that DIDN'T originally execute
// the label's body would now run the hoisted body inadvertently. With the
// skip-jump, only goto-driven and "explicit branch into the modified
// anchor" paths reach the hoisted body.
//
// The transform rebuilds every SCompound on the path from body down to
// labelCompound, plus lcaCompound itself.
let __hoistSkipCounter = 0;
function applyHoist(body, labelInfo, hoistTarget) {
  const labelCompound = labelInfo.compound;
  const labelIdx = labelInfo.indexInCompound;
  const lcaCompound = hoistTarget.lcaCompound;
  const anchorIndex = hoistTarget.anchorIndex;
  const labelStmt = labelCompound.statements[labelIdx];

  // Tail = label + everything after in labelCompound
  const tail = labelCompound.statements.slice(labelIdx);

  // New labelCompound: original stmts before label + a single SGoto
  const gotoReplacement = new AST.SGoto(labelStmt.loc, labelStmt.name);
  gotoReplacement.target = labelStmt;
  // Mark the original label as having gotos (it now has at least our new one).
  labelStmt.hasGotos = true;
  if (labelStmt.labelKind === Types.LabelKind.LOOP) {
    labelStmt.labelKind = Types.LabelKind.BOTH;
  } // else stays FORWARD

  const newLabelCompoundStmts = [
    ...labelCompound.statements.slice(0, labelIdx),
    gotoReplacement,
  ];
  const newLabelCompound = new AST.SCompound(labelCompound.loc, newLabelCompoundStmts, labelCompound.labels);

  // Walk anchor subtree; replace labelCompound deep inside with the modified
  // version. This rebuilds the SIf/SCompound chain on the way down.
  const oldAnchor = lcaCompound.statements[anchorIndex];
  const newAnchor = rebuildAlongPath(oldAnchor, labelCompound, newLabelCompound);

  // Update the label's enclosingBlock pointer to point to the lcaCompound
  // (its new parent compound after hoist).
  labelStmt.enclosingBlock = lcaCompound;

  // Synthesize a unique skip-label and the goto+label pair.
  const skipName = `__hoist_skip_${labelStmt.name}_${++__hoistSkipCounter}`;
  const skipLabel = new AST.SLabel(labelStmt.loc, skipName, lcaCompound);
  skipLabel.hasGotos = true;
  skipLabel.labelKind = Types.LabelKind.FORWARD;
  const skipGoto = new AST.SGoto(labelStmt.loc, skipName);
  skipGoto.target = skipLabel;

  const newLcaStmts = [
    ...lcaCompound.statements.slice(0, anchorIndex),
    newAnchor,
    skipGoto,
    ...tail,
    skipLabel,
    ...lcaCompound.statements.slice(anchorIndex + 1),
  ];
  const newLcaCompound = new AST.SCompound(lcaCompound.loc, newLcaStmts, lcaCompound.labels);

  // Update the SCompound.labels references on lcaCompound to include the
  // hoisted label and the new skip-label.
  if (!newLcaCompound.labels.includes(labelStmt)) {
    newLcaCompound.labels.push(labelStmt);
  }
  newLcaCompound.labels.push(skipLabel);
  // Remove the label from the (old) labelCompound's labels list (it lives
  // there from parser registration; we want consistency).
  if (newLabelCompound.labels) {
    const idx = newLabelCompound.labels.indexOf(labelStmt);
    if (idx >= 0) newLabelCompound.labels.splice(idx, 1);
  }

  // Now rebuild the body to install newLcaCompound in place of lcaCompound.
  return rebuildAlongPath(body, lcaCompound, newLcaCompound);
}

// Walk `tree` looking for `oldNode`; return a new tree where every node on
// the path to oldNode is rebuilt, and oldNode itself is replaced by newNode.
// Returns `tree` unchanged if oldNode is not found.
function rebuildAlongPath(tree, oldNode, newNode) {
  if (tree === oldNode) return newNode;
  if (tree instanceof AST.SCompound) {
    const newStmts = tree.statements.map(s => rebuildAlongPath(s, oldNode, newNode));
    if (newStmts.some((s, i) => s !== tree.statements[i])) {
      return new AST.SCompound(tree.loc, newStmts, tree.labels);
    }
    return tree;
  }
  if (tree instanceof AST.SIf) {
    const newThen = rebuildAlongPath(tree.thenBranch, oldNode, newNode);
    const newElse = tree.elseBranch ? rebuildAlongPath(tree.elseBranch, oldNode, newNode) : null;
    if (newThen !== tree.thenBranch || newElse !== tree.elseBranch) {
      return new AST.SIf(tree.loc, tree.condition, newThen, newElse);
    }
    return tree;
  }
  if (tree instanceof AST.SWhile) {
    const newBody = rebuildAlongPath(tree.body, oldNode, newNode);
    if (newBody !== tree.body) return new AST.SWhile(tree.loc, tree.condition, newBody);
    return tree;
  }
  if (tree instanceof AST.SDoWhile) {
    const newBody = rebuildAlongPath(tree.body, oldNode, newNode);
    if (newBody !== tree.body) return new AST.SDoWhile(tree.loc, newBody, tree.condition);
    return tree;
  }
  if (tree instanceof AST.SFor) {
    const newBody = rebuildAlongPath(tree.body, oldNode, newNode);
    if (newBody !== tree.body) return new AST.SFor(tree.loc, tree.init, tree.condition, tree.increment, newBody);
    return tree;
  }
  if (tree instanceof AST.SSwitch) {
    const newBody = rebuildAlongPath(tree.body, oldNode, newNode);
    if (newBody !== tree.body) return new AST.SSwitch(tree.loc, tree.expr, newBody);
    return tree;
  }
  if (tree instanceof AST.STryCatch) {
    const newTry = rebuildAlongPath(tree.tryBody, oldNode, newNode);
    let changed = newTry !== tree.tryBody;
    const newCatches = tree.catches.map(c => {
      const nb = rebuildAlongPath(c.body, oldNode, newNode);
      if (nb !== c.body) { changed = true; return { ...c, body: nb }; }
      return c;
    });
    if (changed) return new AST.STryCatch(tree.loc, newTry, newCatches);
    return tree;
  }
  return tree;
}

// Top-level entry: run the pass on a function body. Iteratively transforms
// cross-block goto/label pairs. Reports any unhandled cases via `sink`.
function normalize(funcDecl, sink) {
  if (!funcDecl.body) return;
  let body = funcDecl.body;
  const MAX_ITERATIONS = 256;  // upper bound on transformations per function
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const { labels, gotos } = collectTraces(body);
    const switchBodies = collectSwitchBodies(body);
    let transformedThisRound = false;
    for (const [gotoNode, gotoInfo] of gotos) {
      if (!gotoNode.target) continue;  // unresolved goto; codegen will report
      const labelInfo = labels.get(gotoNode.target);
      if (!labelInfo) continue;
      // Hoist requires the label to be a direct child of a compound (so we
      // can replace it with a goto). Skip pathological cases like
      // `if (cond) name: stmt;`.
      if (labelInfo.indexInCompound < 0) continue;
      const cls = classifyPair(gotoInfo, labelInfo);
      if (cls !== "needs-transform") continue;
      const target = findHoistTarget(gotoInfo, labelInfo);
      if (!target) continue;
      const labelInfoWithLabel = { ...labelInfo, label: gotoNode.target };
      const safe = checkHoistSafe(labelInfoWithLabel, target, body, switchBodies);
      if (!safe.ok) {
        // Leave it alone; codegen will surface its own diagnostic.
        continue;
      }
      body = applyHoist(body, labelInfoWithLabel, target);
      transformedThisRound = true;
      break;  // re-collect traces after a transform
    }
    if (!transformedThisRound) break;
  }
  funcDecl.body = body;
}

// ---------------------------------------------------------------------
// Backward-goto inlining
//
// A label that's both a forward-goto target AND a backward-goto target
// (`labelKind === BOTH`) gets a wasm `loop` block opened at its position
// to receive backward branches. If a SUBSEQUENT forward label appears in
// the same compound, the codegen has to close the loop (wasm structured
// blocks can't outlive an outer block that ends earlier) — and any
// later backward goto to the original label fails to codegen.
//
// virtio.c's `virtio_9p_recv_request` hits this exact pattern:
//
//     ... many `goto error;` (forward) ...
//     return 0;
//   error:                                  // BOTH (forward + backward)
//     virtio_9p_send_error(...); return 0;
//   protocol_error:                         // FORWARD — closes error's loop
//   fid_not_found:
//     err = -P9_EPROTO;
//     goto error;                           // <-- error's loop is gone, fails
//
// Fix: at the AST level, REPLACE each backward goto with a copy of the
// labeled-tail's statements. The label retains forward-only gotos, no
// loop is needed, and the wasm structure cleanly nests.
//
// Safety conditions for inlining (all must hold):
//   - The body terminates (last stmt is `return`) so we don't fall through
//     past the inlined region into surrounding code.
//   - The body contains no nested labels, gotos, declarations, breaks, or
//     continues. (Labels would be duplicated across inline sites; gotos
//     could target stale positions; decls could clash with the goto-site's
//     scope; break/continue could re-target a different enclosing loop.)
//   - The body is non-empty.

// Compute the label's body slice: statements in `compound.statements`
// after position `labelIndex`, up to (but not including) the next SLabel
// or end of compound. Returns null if the slice contains anything that
// makes inlining unsafe.
function bodySliceFor(compound, labelIndex) {
  const stmts = compound.statements;
  let endIdx = labelIndex + 1;
  while (endIdx < stmts.length && !(stmts[endIdx] instanceof AST.SLabel)) endIdx++;
  return stmts.slice(labelIndex + 1, endIdx);
}

// True if `stmts` is safe to splice in place of a backward goto.
function isInlineSafe(stmts) {
  if (stmts.length === 0) return false;

  // Walk to detect any disqualifying construct.
  function disqualifies(s) {
    if (s instanceof AST.SLabel || s instanceof AST.SGoto) return true;
    if (s instanceof AST.SDecl) return true;
    if (s instanceof AST.SBreak || s instanceof AST.SContinue) return true;
    if (s instanceof AST.SCompound) return s.statements.some(disqualifies);
    if (s instanceof AST.SIf) {
      return disqualifies(s.thenBranch) || (s.elseBranch && disqualifies(s.elseBranch));
    }
    if (s instanceof AST.SWhile || s instanceof AST.SDoWhile) return disqualifies(s.body);
    if (s instanceof AST.SFor) {
      return (s.init && disqualifies(s.init)) || disqualifies(s.body);
    }
    if (s instanceof AST.SSwitch) return disqualifies(s.body);
    if (s instanceof AST.STryCatch) {
      return disqualifies(s.tryBody) || s.catches.some(c => disqualifies(c.body));
    }
    return false;
  }
  if (stmts.some(disqualifies)) return false;

  // Must terminate. Conservative: last stmt is SReturn. Could later
  // extend to nested SIf where both branches terminate, calls to
  // `_Noreturn` functions, etc.
  const last = stmts[stmts.length - 1];
  if (last instanceof AST.SReturn) return true;

  return false;
}

// Walk a function body and assign each SLabel and SGoto a linear "source
// position" (an integer that respects pre-order traversal). Two nodes
// where pos(a) < pos(b) means `a` appears textually before `b`.
function collectLabelGotoPositions(body) {
  const labelInfo = new Map();   // SLabel → { compound, indexInCompound, position, bodySlice }
  const gotoInfo = new Map();    // SGoto → { compound, indexInCompound, position }
  let pos = 0;

  function walk(node) {
    if (!node) return;
    if (node instanceof AST.SCompound) {
      for (let i = 0; i < node.statements.length; i++) {
        const s = node.statements[i];
        if (s instanceof AST.SLabel) {
          const slice = bodySliceFor(node, i);
          labelInfo.set(s, { compound: node, indexInCompound: i, position: pos++, bodySlice: slice });
        } else if (s instanceof AST.SGoto) {
          gotoInfo.set(s, { compound: node, indexInCompound: i, position: pos++ });
        } else {
          pos++;
          walk(s);
        }
      }
    } else if (node instanceof AST.SIf) {
      walk(node.thenBranch);
      walk(node.elseBranch);
    } else if (node instanceof AST.SWhile || node instanceof AST.SDoWhile) {
      walk(node.body);
    } else if (node instanceof AST.SFor) {
      walk(node.init);
      walk(node.body);
    } else if (node instanceof AST.SSwitch) {
      walk(node.body);
    } else if (node instanceof AST.STryCatch) {
      walk(node.tryBody);
      for (const cc of node.catches) walk(cc.body);
    }
    // else: leaf
  }
  walk(body);
  return { labelInfo, gotoInfo };
}

// Run the backward-goto inlining pass on a function body. Iterates: each
// round inlines one backward goto, then re-walks to find more. Bounded
// by the goto count.
function inlineBackwardGotos(funcDecl) {
  if (!funcDecl.body) return;
  let body = funcDecl.body;

  for (let iter = 0; iter < 1024; iter++) {
    const { labelInfo, gotoInfo } = collectLabelGotoPositions(body);

    let didTransform = false;
    for (const [label, lInfo] of labelInfo) {
      // Only relevant for labels with at least one backward goto. The
      // parser sets BOTH when forward + backward both exist; LOOP for
      // backward-only. We only want to inline backward gotos to BOTH
      // labels — pure LOOP labels are fine for the codegen as-is.
      if (label.labelKind !== Types.LabelKind.BOTH) continue;
      if (!isInlineSafe(lInfo.bodySlice)) continue;

      // Find a backward goto to this label.
      let targetGoto = null;
      let targetGotoInfo = null;
      for (const [g, gI] of gotoInfo) {
        if (g.target === label && gI.position > lInfo.position) {
          targetGoto = g;
          targetGotoInfo = gI;
          break;
        }
      }
      if (!targetGoto) continue;

      // Replace the goto with the body slice. The slice's statements are
      // shared (not deep-cloned); since the safety check guarantees no
      // labels/gotos/decls inside, sharing is fine. (Multiple inline
      // sites referencing the same EXpr nodes is OK — the codegen reads
      // them, doesn't mutate.)
      const compound = targetGotoInfo.compound;
      const idx = targetGotoInfo.indexInCompound;
      const newStmts = [
        ...compound.statements.slice(0, idx),
        ...lInfo.bodySlice,
        ...compound.statements.slice(idx + 1),
      ];
      const newCompound = new AST.SCompound(compound.loc, newStmts, compound.labels);
      body = rebuildAlongPath(body, compound, newCompound);

      // If this was the last backward goto to the label, demote labelKind
      // from BOTH back to FORWARD so the codegen treats it as a pure
      // forward target (no loop block).
      let backwardCount = 0;
      for (const [g, gI] of gotoInfo) {
        if (g === targetGoto) continue;
        if (g.target === label && gI.position > lInfo.position) backwardCount++;
      }
      if (backwardCount === 0) label.labelKind = Types.LabelKind.FORWARD;

      didTransform = true;
      break;
    }
    if (!didTransform) break;
  }

  funcDecl.body = body;
}

// Optimize all functions with bodies in a translation unit. Runs the
// cross-block hoist pass and the backward-goto inlining pass. Both can
// reduce the goto graph; running them in this order means hoist sees the
// original structure (which is what its safety conditions assume), and
// inlining cleans up any remaining BOTH-label trouble after.
function optimize(unit) {
  for (const fn of unit.definedFunctions || []) {
    normalize(fn);
    inlineBackwardGotos(fn);
  }
  for (const fn of unit.staticFunctions || []) {
    normalize(fn);
    inlineBackwardGotos(fn);
  }
}

return { normalize, inlineBackwardGotos, optimize, collectTraces, classifyPair };

})();

// ====================
// IRREDUCIBLE LOWERING — function-local loop-switch fallback
// ====================
//
// For functions where GOTO_NORMALIZER couldn't make all gotos resolvable via
// structured wasm `block`/`loop` nesting, we fall back to a CPS-style
// encoding: rewrite the whole function body as `while (1) switch (state)`
// with one case per basic block. Each goto becomes `state = N; continue;`.
//
// The output is plain structured C and feeds back through the existing
// codegen unchanged — this pass is purely an AST→AST transformation.
//
// Pass ordering: runs after GOTO_NORMALIZER so we only pay the cost for
// functions that genuinely can't be structured. Functions with clean control
// flow are left alone.
//
// Limitations (documented, not silently miscompiled):
//   - VLAs are rejected at parse time elsewhere; their hoisting would need
//     dynamic alloca which we don't model.
//   - setjmp/longjmp interaction inside an irreducible function: not
//     supported. (Structured-mode functions still work.)
//   - Computed goto (GCC extension): we don't support it generally.

const IRREDUCIBLE_LOWERING = (() => {

// ----- Segment + terminator types -----
//
// A Segment is the AST equivalent of a basic block — a maximal sequence of
// straight-line statements with one entry (the case label) and one exit
// (its terminator). All segments live in a flat array; their `id` is the
// switch-case value used to dispatch into them.
//
// Terminators describe how control leaves a segment. They get translated
// into AST statements at the end of each case body during wrapper synthesis.

function newSegment(id) {
  return { id, stmts: [], term: null };
}

// Terminator factory helpers. Each returns a plain object whose `kind` field
// is one of: "fallthrough", "goto", "branch", "switch", "return", "halt".
const Term = {
  fallthrough: (nextId) => ({ kind: "fallthrough", nextId }),
  goto: (targetId) => ({ kind: "goto", targetId }),
  branch: (cond, thenId, elseId) => ({ kind: "branch", cond, thenId, elseId }),
  // cases: [{ value: bigint, target: int }], defaultTarget: int
  switchDispatch: (scrutinee, cases, defaultTarget) => ({
    kind: "switch", scrutinee, cases, defaultTarget,
  }),
  return: (expr) => ({ kind: "return", expr }),
  // SThrow as a terminator — emitted by the segmentizer when it rewrites
  // a longjmp(buf, val) call. The thrown exception is caught by the
  // physical try/catch that the wrapper synthesizes around the switch.
  throw: (sthrow) => ({ kind: "throw", sthrow }),
  // "halt" marks a segment that exits the loop-switch and falls out the
  // bottom of the function (used for unreachable continuations after a
  // terminator emits its branch).
  halt: () => ({ kind: "halt" }),
};

// ----- Variable hoisting -----
//
// Walk the function body, collect every DVar declaration into a single
// flat list at function entry, and replace each in-place declaration with
// an SExpr-wrapped assignment (when there was an initializer).
//
// α-rename when a nested-scope DVar shadows an outer-scope one with the
// same name. EIdent nodes already point at DVar objects by reference, so
// mutating DVar.name (DVars are seal'd, not frozen) keeps every reference
// pointed at the right object — only the displayed name changes.
//
// Returns { decls: DVar[], rewrittenBody: SCompound }. The DVars in
// `decls` are stripped of initExprs.
function hoistDeclarations(funcDef) {
  const hoisted = [];
  // names seen anywhere in this function so far — used to detect
  // shadowing. A second `int x;` in a nested scope gets renamed.
  const used = new Set();
  for (const p of funcDef.parameters) used.add(p.name);

  function uniquify(dvar) {
    if (!used.has(dvar.name)) { used.add(dvar.name); return; }
    let i = 2;
    let candidate = `${dvar.name}__${i}`;
    while (used.has(candidate)) { i++; candidate = `${dvar.name}__${i}`; }
    used.add(candidate);
    dvar.name = candidate;
  }

  function rewrite(stmt) {
    if (!stmt) return stmt;
    if (stmt instanceof AST.SDecl) {
      const initStmts = [];
      for (const d of stmt.declarations) {
        if (!(d instanceof AST.DVar)) continue;
        if (d.storageClass === Types.StorageClass.STATIC ||
            d.storageClass === Types.StorageClass.EXTERN) continue;
        uniquify(d);
        const init = d.initExpr;
        // EInitList / aggregate-array initializers can't be expressed as
        // a plain `var = expr` SExpr after declaration. Keep the init on
        // the hoisted DVar in those cases — the codegen runs it at the
        // (function-entry) hoisted declaration site. For arrays/aggregates
        // we also keep the init in place because their allocation is
        // tied to the original declaration position in some codepaths.
        const initIsListLike = init &&
          (init instanceof AST.EInitList ||
           (d.type.isArray && d.type.isArray()) ||
           (d.type.isAggregate && d.type.isAggregate()));
        if (initIsListLike) {
          // Keep the original init on the hoisted decl. No SExpr emitted
          // at the original position.
          hoisted.push(d);
          continue;
        }
        d.initExpr = null;  // strip — the hoisted decl has no initializer
        hoisted.push(d);
        if (init !== null) {
          const ident = new AST.EIdent(d.loc, d.type, d);
          const assign = new AST.EBinary(d.loc, d.type, "ASSIGN", ident, init);
          initStmts.push(new AST.SExpr(d.loc, assign));
        }
      }
      // Collapse to nothing / a single SExpr / a small SCompound of
      // assignments — whatever's smallest.
      if (initStmts.length === 0) return new AST.SEmpty(stmt.loc);
      if (initStmts.length === 1) return initStmts[0];
      return new AST.SCompound(stmt.loc, initStmts);
    }
    if (stmt instanceof AST.SCompound) {
      const rewritten = stmt.statements.map(rewrite);
      return new AST.SCompound(stmt.loc, rewritten, stmt.labels);
    }
    if (stmt instanceof AST.SIf) {
      return new AST.SIf(stmt.loc, stmt.condition,
        rewrite(stmt.thenBranch),
        stmt.elseBranch ? rewrite(stmt.elseBranch) : null);
    }
    if (stmt instanceof AST.SWhile) {
      return new AST.SWhile(stmt.loc, stmt.condition, rewrite(stmt.body));
    }
    if (stmt instanceof AST.SDoWhile) {
      return new AST.SDoWhile(stmt.loc, rewrite(stmt.body), stmt.condition);
    }
    if (stmt instanceof AST.SFor) {
      return new AST.SFor(stmt.loc,
        stmt.init ? rewrite(stmt.init) : null,
        stmt.condition, stmt.increment,
        rewrite(stmt.body));
    }
    if (stmt instanceof AST.SSwitch) {
      const newBody = rewrite(stmt.body);
      return new AST.SSwitch(stmt.loc, stmt.expr, newBody);
    }
    if (stmt instanceof AST.STryCatch) {
      // After irreducible lifts catch bodies into segments, the catch's
      // binding vars need function-scope visibility (segments reference
      // them by DVar identity from outside the catch's lexical scope).
      // Hoist them alongside the rest of the locals.
      for (const cc of stmt.catches) {
        for (const bv of (cc.bindingVars || [])) {
          uniquify(bv);
          hoisted.push(bv);
        }
      }
      const newTry = rewrite(stmt.tryBody);
      const newCatches = stmt.catches.map(c => ({ ...c, body: rewrite(c.body) }));
      return new AST.STryCatch(stmt.loc, newTry, newCatches);
    }
    return stmt;  // SExpr, SReturn, SGoto, SLabel, SBreak, SContinue, SEmpty, etc.
  }

  const rewrittenBody = rewrite(funcDef.body);
  return { decls: hoisted, rewrittenBody };
}

// ----- AST → segments walker -----
//
// Walks the rewritten function body, splitting it at every control-flow
// boundary into a flat list of Segments. Each goto/branch/return becomes
// a terminator referring to other segment ids by integer.
//
// Loop and switch contexts are tracked on `loopStack` so SBreak/SContinue
// resolve to the right exit/header ids.
function buildSegments(body, tryCtx) {
  const segments = [];
  let curSeg = null;
  let nextId = 0;
  const labelToId = new Map();  // SLabel → segment id
  // Loop stack: each entry is { breakId, continueId? }. Switches push
  // entries without continueId (SContinue must skip past switches).
  const loopStack = [];
  // Stack of Map<SCase, segmentId>. Pushed when entering an SSwitch's
  // body; consumed when an SCase node is visited (so the visitor knows
  // which segment id to open at that label).
  const caseIdsStack = [];

  function allocId() { return nextId++; }
  function currentHandlerRegionId() {
    if (!tryCtx || tryCtx.regionStack.length === 0) return -1;
    return tryCtx.regionStack[tryCtx.regionStack.length - 1];
  }
  function openSeg(id) {
    const seg = newSegment(id);
    segments.push(seg);
    curSeg = seg;
    // Stamp every opened segment with the innermost active handler-region.
    // The wrapper writes this id into a runtime variable at the top of each
    // case body, so when an exception fires, the catch dispatcher knows
    // which lexical region the current segment belongs to.
    if (tryCtx) tryCtx.segmentHandlerIds.set(id, currentHandlerRegionId());
    return seg;
  }
  function close(term) {
    if (!curSeg.term) curSeg.term = term;
    curSeg = null;  // anything emitted before a new openSeg goes into limbo
  }
  function ensureOpen() {
    // If we just emitted a terminator and the next statement isn't a label,
    // create a fresh "dead" segment to hold further code.
    if (curSeg === null) openSeg(allocId());
  }
  function getLabelId(label) {
    let id = labelToId.get(label);
    if (id === undefined) { id = allocId(); labelToId.set(label, id); }
    return id;
  }
  function topLoop() {
    for (let i = loopStack.length - 1; i >= 0; i--) {
      if (loopStack[i].continueId !== null) return loopStack[i];
    }
    return null;
  }
  function topBreakTarget() {
    return loopStack.length > 0 ? loopStack[loopStack.length - 1].breakId : null;
  }

  // Open the entry segment.
  openSeg(allocId());

  function visit(node) {
    if (!node) return;
    ensureOpen();

    if (node instanceof AST.SEmpty) return;

    if (node instanceof AST.SCompound) {
      for (const s of node.statements) visit(s);
      return;
    }

    if (node instanceof AST.SLabel) {
      // A label site: close the current segment falling through to a fresh
      // segment with the label's id, then open it.
      const id = getLabelId(node);
      close(Term.fallthrough(id));
      openSeg(id);
      return;
    }

    if (node instanceof AST.SGoto) {
      if (!node.target) {
        // Unresolved label name — leave a halt; codegen will diagnose it.
        close(Term.halt());
        return;
      }
      const id = getLabelId(node.target);
      close(Term.goto(id));
      return;
    }

    if (node instanceof AST.SIf) {
      const thenId = allocId();
      const elseId = node.elseBranch ? allocId() : null;
      const joinId = allocId();
      close(Term.branch(node.condition, thenId, elseId !== null ? elseId : joinId));
      openSeg(thenId);
      visit(node.thenBranch);
      if (curSeg !== null) close(Term.fallthrough(joinId));
      if (elseId !== null) {
        openSeg(elseId);
        visit(node.elseBranch);
        if (curSeg !== null) close(Term.fallthrough(joinId));
      }
      openSeg(joinId);
      return;
    }

    if (node instanceof AST.SWhile) {
      const hdrId = allocId();
      const bodyId = allocId();
      const exitId = allocId();
      close(Term.fallthrough(hdrId));
      openSeg(hdrId);
      close(Term.branch(node.condition, bodyId, exitId));
      openSeg(bodyId);
      loopStack.push({ breakId: exitId, continueId: hdrId });
      visit(node.body);
      loopStack.pop();
      if (curSeg !== null) close(Term.fallthrough(hdrId));
      openSeg(exitId);
      return;
    }

    if (node instanceof AST.SDoWhile) {
      const bodyId = allocId();
      const testId = allocId();
      const exitId = allocId();
      close(Term.fallthrough(bodyId));
      openSeg(bodyId);
      loopStack.push({ breakId: exitId, continueId: testId });
      visit(node.body);
      loopStack.pop();
      if (curSeg !== null) close(Term.fallthrough(testId));
      openSeg(testId);
      close(Term.branch(node.condition, bodyId, exitId));
      openSeg(exitId);
      return;
    }

    if (node instanceof AST.SFor) {
      // After hoisting, SFor.init is either null, an SExpr, an SCompound of
      // assignments, or SEmpty. Lower init in the current segment.
      if (node.init) visit(node.init);
      const hdrId = allocId();
      const bodyId = allocId();
      const contId = allocId();  // continue target = increment block
      const exitId = allocId();
      close(Term.fallthrough(hdrId));
      openSeg(hdrId);
      if (node.condition) {
        close(Term.branch(node.condition, bodyId, exitId));
      } else {
        close(Term.fallthrough(bodyId));
      }
      openSeg(bodyId);
      loopStack.push({ breakId: exitId, continueId: contId });
      visit(node.body);
      loopStack.pop();
      if (curSeg !== null) close(Term.fallthrough(contId));
      openSeg(contId);
      if (node.increment) {
        curSeg.stmts.push(new AST.SExpr(node.loc, node.increment));
      }
      close(Term.fallthrough(hdrId));
      openSeg(exitId);
      return;
    }

    if (node instanceof AST.SSwitch) {
      const postId = allocId();
      // Allocate a segment id per SCase in this switch's body. The
      // mapping is stashed on caseIdsStack so the SCase visitor below
      // can open the right segment at each label position — case
      // labels deep inside nested compounds work naturally because
      // they're just SCase nodes the visitor will encounter in order.
      const caseIds = new Map();
      let defaultTarget = postId;
      const dispatchCases = [];
      for (const sc of node.body.caseBag) {
        const id = allocId();
        caseIds.set(sc, id);
        if (sc.isDefault) {
          defaultTarget = id;
        } else {
          for (let v = sc.lo; v <= sc.hi; v++) {
            dispatchCases.push({ value: v, target: id });
          }
        }
      }
      close(Term.switchDispatch(node.expr, dispatchCases, defaultTarget));
      caseIdsStack.push(caseIds);
      loopStack.push({ breakId: postId, continueId: null });
      openSeg(allocId());
      visit(node.body);
      loopStack.pop();
      caseIdsStack.pop();
      if (curSeg !== null) close(Term.fallthrough(postId));
      openSeg(postId);
      return;
    }

    if (node instanceof AST.SCase) {
      // Close the current segment falling through into this case's
      // segment, then open it. The id was assigned by the enclosing
      // SSwitch handler above.
      const top = caseIdsStack.length > 0 ? caseIdsStack[caseIdsStack.length - 1] : null;
      const id = top ? top.get(node) : undefined;
      if (id === undefined) {
        throw new Error("irreducible lowering: SCase outside switch");
      }
      if (curSeg !== null) close(Term.fallthrough(id));
      openSeg(id);
      return;
    }

    if (node instanceof AST.SBreak) {
      const target = topBreakTarget();
      if (target === null) {
        throw new Error("irreducible lowering: SBreak outside loop/switch");
      }
      close(Term.goto(target));
      return;
    }

    if (node instanceof AST.SContinue) {
      const loop = topLoop();
      if (!loop) {
        throw new Error("irreducible lowering: SContinue outside loop");
      }
      close(Term.goto(loop.continueId));
      return;
    }

    if (node instanceof AST.SReturn) {
      close(Term.return(node.expr));
      return;
    }

    // STryCatch: hoist its try-body and catch bodies into segments in
    // the shared switch. The wrapper synthesizes a single physical
    // try/catch wrapping the whole switch, with one catch clause per
    // distinct tag; the dispatcher inside each clause reads the runtime
    // `current_handler` (stamped per-segment) and routes to the right
    // catch entry segment — or rethrows if no enclosing region handles
    // this tag.
    if (node instanceof AST.STryCatch) {
      if (!tryCtx) {
        // Defensive: lower() always passes a tryCtx now. If we ever
        // call buildSegments without one, fall back to opaque.
        curSeg.stmts.push(node);
        return;
      }

      const parentId = currentHandlerRegionId();
      const regionId = tryCtx.regions.length;
      const joinId = allocId();
      const catchInfos = node.catches.map(cc => {
        tryCtx.tags.set(cc.tag.name, cc.tag);
        return {
          tag: cc.tag,
          userBindingVars: cc.bindingVars || [],
          entrySegId: allocId(),
        };
      });
      tryCtx.regions.push({
        id: regionId,
        parentId,
        joinSegId: joinId,
        catches: catchInfos,
      });

      // Close current segment, fall through into the try body.
      const tryEntryId = allocId();
      close(Term.fallthrough(tryEntryId));

      // Push this region while segmentizing the try body so its segments
      // get stamped with regionId.
      tryCtx.regionStack.push(regionId);
      openSeg(tryEntryId);
      visit(node.tryBody);
      if (curSeg !== null) close(Term.fallthrough(joinId));
      tryCtx.regionStack.pop();

      // Catch bodies run *after* their region exited — segments here are
      // protected by the parent region (or unprotected if top-level).
      for (let i = 0; i < node.catches.length; i++) {
        openSeg(catchInfos[i].entrySegId);
        visit(node.catches[i].body);
        if (curSeg !== null) close(Term.fallthrough(joinId));
      }

      openSeg(joinId);
      return;
    }

    // SThrow as a terminator: closes the current segment. The thrown
    // exception is caught by the physical try/catch the wrapper
    // synthesizes around the switch (when any setjmp region exists).
    if (node instanceof AST.SThrow) {
      close(Term.throw(node));
      return;
    }

    // Straight-line statements: SExpr, SDecl (post-hoist — only static/extern
    // locals survive), and anything else we don't transform.
    curSeg.stmts.push(node);
  }

  visit(body);
  // Close any trailing open segment with a halt (function fall-through).
  if (curSeg !== null) close(Term.halt());

  return segments;
}

// For a region and a tag, find the innermost enclosing region that has
// a catch for that tag. Walks the parent chain. Returns the matching
// catch info (with entrySegId, userBindingVars) or null if no ancestor
// handles the tag.
function findDispatchEntry(regionId, tag, regions) {
  let id = regionId;
  while (id >= 0) {
    const r = regions[id];
    for (const ci of r.catches) {
      if (ci.tag === tag) return ci;
    }
    id = r.parentId;
  }
  return null;
}

// Construct one catch clause of the physical try/catch wrapping the
// switch. The clause catches `tag`, binds the thrown args into fresh
// temp DVars, and dispatches based on the runtime handler-region id:
//
//   catch tag(__tmp0, __tmp1, ...) {
//     if      (__irreducible_handler == R1) { user.id = __tmp0; ...; state = entryR1; }
//     else if (__irreducible_handler == R2) { ...                     state = entryR2; }
//     ...
//     else __throw tag(__tmp0, __tmp1, ...);  // no ancestor handles → propagate
//   }
//
// After the catch body falls off, the while loop iterates and the
// switch re-enters at the new state (whose case prefix stamps a new
// handler id — typically the dispatched-to handler's parent region).
function makeDispatcherCatch(tag, tryCtx, loc, handlerVar, setState) {
  const paramTypes = tag.paramTypes || [];
  const tempBindings = paramTypes.map((t, idx) => {
    const dv = new AST.DVar(loc,
      Lexer.intern(`__irreducible_caught_${idx}`),
      t, Types.StorageClass.NONE, null);
    dv.definition = dv;
    return dv;
  });
  const tempBindingNames = tempBindings.map(d => d.name);

  // Per-region match arm: assign temp bindings into the chosen user
  // catch's bindings, then state = entry. Only emit an arm for regions
  // whose dispatch table for this tag is non-null.
  const armStmts = [];  // [{ regionId, body }]
  for (let i = 0; i < tryCtx.regions.length; i++) {
    const entry = findDispatchEntry(i, tag, tryCtx.regions);
    if (!entry) continue;
    const bodyStmts = [];
    for (let j = 0; j < tempBindings.length && j < entry.userBindingVars.length; j++) {
      const userVar = entry.userBindingVars[j];
      const tmpVar = tempBindings[j];
      const lhs = new AST.EIdent(loc, userVar.type, userVar);
      const rhs = new AST.EIdent(loc, tmpVar.type, tmpVar);
      bodyStmts.push(new AST.SExpr(loc,
        new AST.EBinary(loc, userVar.type, "ASSIGN", lhs, rhs)));
    }
    bodyStmts.push(setState(entry.entrySegId));
    armStmts.push({ regionId: i, body: new AST.SCompound(loc, bodyStmts) });
  }

  // Build the if/else chain: each arm checks __irreducible_handler == R.
  // Final else: rethrow tag(tempBindings...).
  const rethrowArgs = tempBindings.map(d => new AST.EIdent(loc, d.type, d));
  let chain = new AST.SThrow(loc, tag, rethrowArgs);
  for (let i = armStmts.length - 1; i >= 0; i--) {
    const arm = armStmts[i];
    const cond = new AST.EBinary(loc, Types.TINT, "EQ",
      new AST.EIdent(loc, Types.TINT, handlerVar),
      new AST.EInt(loc, Types.TINT, BigInt(arm.regionId)));
    chain = new AST.SIf(loc, cond, arm.body, chain);
  }

  return {
    tag,
    bindings: tempBindingNames,
    bindingVars: tempBindings,
    body: new AST.SCompound(loc, [chain]),
  };
}

// ----- Wrapper synthesis -----
//
// Build the output function body:
//
//   {
//     <hoisted decls>
//     int __state = 0;
//     while (1) {
//       switch (__state) {
//         case 0: { ...seg0 stmts... ; <terminator stmts> ; continue/break; }
//         ...
//       }
//       break;  // unreachable, but keeps the wasm validator happy if any
//               // case body fell through without an explicit transfer
//     }
//   }
//
// Terminator translations:
//   fallthrough(n) → __state = n; continue;
//   goto(n)        → __state = n; continue;
//   branch(c,t,e)  → __state = (c) ? t : e; continue;
//   switch(...)    → switch(scrut) { case v: __state=t; ...; default: __state=d; }
//                     continue;
//   return(e)      → return e;
//   halt()         → break;   /* exits the while(1) */
function synthesizeWrapper(funcDef, hoistedDecls, segments, tryCtx) {
  const loc = funcDef.loc;
  const stateVar = new AST.DVar(loc, "__irreducible_state",
    Types.TINT, Types.StorageClass.AUTO, null);
  stateVar.definition = stateVar;  // local definition (codegen checks this)
  // Runtime variable holding the innermost active try-region id for the
  // currently-executing segment. Stamped at the top of each case body
  // from the segment's static handler-id; read by the physical catch's
  // dispatcher to decide which user catch (if any) handles the throw.
  // Only allocated when the function has at least one try-region.
  const haveRegions = tryCtx && tryCtx.regions.length > 0;
  let handlerVar = null;
  if (haveRegions) {
    handlerVar = new AST.DVar(loc, "__irreducible_handler",
      Types.TINT, Types.StorageClass.AUTO, null);
    handlerVar.definition = handlerVar;
  }
  const retType = funcDef.type.getReturnType();
  const isVoid = retType === Types.TVOID;

  function intLit(n) { return new AST.EInt(loc, Types.TINT, BigInt(n)); }
  // For "halt" terminators (function fall-through or unreachable
  // continuation after a goto), produce a return that satisfies the
  // function's signature. Falling off the end of a non-void function is
  // UB in C; we conservatively return a zero of the appropriate type.
  function haltReturn() {
    if (isVoid) return new AST.SReturn(loc, null);
    let zero;
    if (retType.isInteger()) {
      zero = new AST.EInt(loc, retType, 0n);
    } else if (retType.isFloatingPoint()) {
      zero = new AST.EFloat(loc, retType, 0);
    } else if (retType.isPointer()) {
      // null pointer: int 0 cast to the pointer type. Use a 0-int and
      // let the existing cast machinery handle conversion if needed.
      zero = new AST.EInt(loc, Types.TINT, 0n);
    } else {
      // Aggregate / struct / ref return — too complex to fabricate; emit
      // a bare `return;` and accept the UB. The codegen may diagnose.
      zero = null;
    }
    return new AST.SReturn(loc, zero);
  }
  function stateRef() { return new AST.EIdent(loc, Types.TINT, stateVar); }
  function setState(n) {
    return new AST.SExpr(loc,
      new AST.EBinary(loc, Types.TINT, "ASSIGN", stateRef(), intLit(n)));
  }
  // We use SBreak inside the switch+while envelope to mean "next iteration".
  // The desugaring is: each case body ends with SBreak (exits the switch);
  // the while loop body then loops back. But that's only correct if the
  // while body is JUST the switch. We wrap accordingly.
  const continueWhile = () => new AST.SBreak(loc);  // breaks inner switch
  const breakWhile = () => {
    // Mark the outer while with a label-driven exit. Since we can't goto
    // out of nested structures portably in our AST without labels, we use
    // a sentinel: set state to a "done" id and break the switch — the
    // while loop checks state and exits.
    // Simpler: use SReturn(null) only if return type is void; otherwise
    // we can't fabricate a value. For now, halt cases are unreachable in
    // well-formed input — emit `break` and let the while loop iterate
    // back into the switch with whatever state is set. The default switch
    // case handles unexpected state by falling through to "break loop".
    return new AST.SBreak(loc);
  };

  // Translate one terminator to a list of statements appended after the
  // segment's body stmts. The last statement should transfer control.
  function termToStmts(term) {
    if (term === null) return [];
    if (term.kind === "fallthrough" || term.kind === "goto") {
      return [setState(term.kind === "goto" ? term.targetId : term.nextId),
              continueWhile()];
    }
    if (term.kind === "branch") {
      // __state = cond ? thenId : elseId
      const tern = new AST.ETernary(loc, Types.TINT,
        term.cond, intLit(term.thenId), intLit(term.elseId));
      const assign = new AST.SExpr(loc,
        new AST.EBinary(loc, Types.TINT, "ASSIGN", stateRef(), tern));
      return [assign, continueWhile()];
    }
    if (term.kind === "switch") {
      // Emit a structured switch into __state, then break to outer loop.
      const bodyStmts = [];
      for (const c of term.cases) {
        bodyStmts.push(new AST.SCase(loc, c.value, c.value, false));
        bodyStmts.push(setState(c.target));
        bodyStmts.push(new AST.SBreak(loc));
      }
      bodyStmts.push(new AST.SCase(loc, 0n, 0n, true));
      bodyStmts.push(setState(term.defaultTarget));
      bodyStmts.push(new AST.SBreak(loc));
      const switchBody = new AST.SCompound(loc, bodyStmts);
      const inner = new AST.SSwitch(loc, term.scrutinee, switchBody);
      return [inner, continueWhile()];
    }
    if (term.kind === "return") {
      return [new AST.SReturn(loc, term.expr)];
    }
    if (term.kind === "throw") {
      // The throw itself transfers control to the catch on the physical
      // try/catch wrapping the whole switch; no continuation needed.
      return [term.sthrow];
    }
    if (term.kind === "halt") {
      // Either function fall-through (reached end of source body without
      // an explicit return) or an unreachable continuation after a goto.
      // Either way, emit a return — for void, bare `return;`; for non-
      // void, a zero of the return type. The unreachable case never
      // actually executes; the function-fall-through case is well-defined
      // for void and UB-but-safe for non-void.
      return [haltReturn()];
    }
    throw new Error(`unknown terminator kind: ${term.kind}`);
  }

  // Helpers for the handler-stamp prefix at each case body.
  function handlerRef() { return new AST.EIdent(loc, Types.TINT, handlerVar); }
  function setHandler(regionId) {
    return new AST.SExpr(loc,
      new AST.EBinary(loc, Types.TINT, "ASSIGN",
        handlerRef(), intLit(regionId)));
  }

  // Build the inner switch: emit one SCase per segment id at the head
  // of that segment's body. Segments are sorted by id; per-segment bodies
  // appear in id order in the switch body. When the function has any
  // try-region, each case body's first action is writing the segment's
  // static handler-region id to __irreducible_handler.
  const switchBodyStmts = [];
  const ordered = [...segments].sort((a, b) => a.id - b.id);
  for (const seg of ordered) {
    switchBodyStmts.push(new AST.SCase(loc, BigInt(seg.id), BigInt(seg.id), false));
    if (haveRegions) {
      const stamp = tryCtx.segmentHandlerIds.get(seg.id);
      switchBodyStmts.push(setHandler(stamp == null ? -1 : stamp));
    }
    switchBodyStmts.push(...seg.stmts);
    switchBodyStmts.push(...termToStmts(seg.term));
  }
  // Default: break out (unexpected state).
  switchBodyStmts.push(new AST.SCase(loc, 0n, 0n, true));
  switchBodyStmts.push(new AST.SBreak(loc));

  const switchStmt = new AST.SSwitch(loc, stateRef(),
    new AST.SCompound(loc, switchBodyStmts));

  // If the function has try-regions, wrap the switch in a physical
  // try/catch — one catch clause per distinct tag. Each clause's body
  // is a switch(__irreducible_handler) that, for each region that
  // (transitively) handles this tag, dispatches to the catch entry
  // segment, copying the thrown args into the user catch's hoisted
  // binding vars. If no region matches, rethrow with the same tag/args.
  let switchOrTry = switchStmt;
  if (haveRegions) {
    const tagsList = [...tryCtx.tags.values()];
    const physicalCatches = tagsList.map(tag => makeDispatcherCatch(tag, tryCtx, loc, handlerVar, setState));
    switchOrTry = new AST.STryCatch(loc, switchStmt, physicalCatches);
  }

  // The while loop wraps just the switch (or the try/catch around it).
  const whileBody = new AST.SCompound(loc, [switchOrTry]);
  const whileCond = new AST.EInt(loc, Types.TINT, 1n);
  const whileStmt = new AST.SWhile(loc, whileCond, whileBody);

  // Build the new function body: state-var decl + while(1) { switch }.
  // The handler-region var is declared alongside state when present;
  // initialization happens at each case body's stamp, but we still set
  // a sentinel here so the validator sees a definite assignment.
  const fnBodyStmts = [];
  if (hoistedDecls.length > 0) fnBodyStmts.push(new AST.SDecl(loc, hoistedDecls));
  fnBodyStmts.push(new AST.SDecl(loc, [stateVar]));
  fnBodyStmts.push(new AST.SExpr(loc,
    new AST.EBinary(loc, Types.TINT, "ASSIGN", stateRef(), intLit(0))));
  if (handlerVar) {
    fnBodyStmts.push(new AST.SDecl(loc, [handlerVar]));
    fnBodyStmts.push(new AST.SExpr(loc,
      new AST.EBinary(loc, Types.TINT, "ASSIGN", handlerRef(), intLit(-1))));
  }
  fnBodyStmts.push(whileStmt);
  return new AST.SCompound(loc, fnBodyStmts);
}

function lower(funcDef, dumpSegments) {
  // tryCtx threads the try-region graph through segmentization and
  // wrapper synthesis. Every STryCatch in the function body becomes a
  // region; the segmentizer maintains a region stack while visiting,
  // and stamps each opened segment with the innermost region's id
  // (-1 if unprotected). The wrapper writes that id into a runtime
  // `current_handler` variable at the top of each case, so when an
  // exception fires the physical catch can walk the region graph and
  // dispatch to the right handler segment (or rethrow if no ancestor
  // catches the tag).
  const tryCtx = {
    regions: [],          // [{ id, parentId, joinSegId,
                          //    catches: [{ tag, userBindingVars, entrySegId }] }]
    regionStack: [],      // segmentizer-time stack of active region ids
    segmentHandlerIds: new Map(),  // segmentId → innermost regionId (-1 if none)
    tags: new Map(),      // distinct tags appearing in any catch (by name)
  };

  const { decls, rewrittenBody } = hoistDeclarations(funcDef);
  const segments = buildSegments(rewrittenBody, tryCtx);
  if (dumpSegments) {
    for (const s of segments) {
      const t = s.term;
      let td = '?';
      if (t) {
        if (t.kind === 'fallthrough') td = 'fall→' + t.nextId;
        else if (t.kind === 'goto') td = 'goto→' + t.targetId;
        else if (t.kind === 'branch') td = 'branch→' + t.thenId + '/' + t.elseId;
        else if (t.kind === 'switch') td = 'sw[' + t.cases.map(c => c.value+'→'+c.target).join(',') + '] def→' + t.defaultTarget;
        else if (t.kind === 'throw') td = 'throw';
        else td = t.kind;
      }
      dumpSegments(`  seg ${s.id}: ${s.stmts.length} stmts → ${td}\n`);
    }
  }

  const newBody = synthesizeWrapper(funcDef, decls, segments, tryCtx);
  funcDef.body = newBody;
}

// ----- JSON export (for the disasm tool's CFG view) -----
//
// Produce a plain-old-data object describing one function's segments and
// their terminators, with short C-like snippets for each statement and
// expression. This is purely for visualization — the snippet text is a
// best-effort rendering, not a faithful pretty-print.
//
// IMPORTANT: this destructively rewrites the funcDef AST (DVars get
// alpha-renamed, initExprs stripped) the same way `lower()` does, since
// it reuses hoistDeclarations + buildSegments. Don't call this on a
// function you intend to compile afterward.
function fmtType(t) {
  if (!t) return '?';
  if (t.name) return t.name;
  if (typeof t.toString === 'function') {
    const s = t.toString();
    return s.length > 32 ? s.slice(0, 29) + '…' : s;
  }
  return '?';
}

const BINOP_TEXT = {
  ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: '%',
  EQ: '==', NE: '!=', LT: '<', LE: '<=', GT: '>', GE: '>=',
  LAND: '&&', LOR: '||',
  BAND: '&', BOR: '|', BXOR: '^', SHL: '<<', SHR: '>>',
  ASSIGN: '=',
  ADD_ASSIGN: '+=', SUB_ASSIGN: '-=', MUL_ASSIGN: '*=',
  DIV_ASSIGN: '/=', MOD_ASSIGN: '%=',
  BAND_ASSIGN: '&=', BOR_ASSIGN: '|=', BXOR_ASSIGN: '^=',
  SHL_ASSIGN: '<<=', SHR_ASSIGN: '>>=',
};
const UNOP_TEXT = {
  OP_NEG: '-', OP_POS: '+', OP_LNOT: '!', OP_BNOT: '~',
  OP_ADDR: '&', OP_DEREF: '*',
  OP_PRE_INC: '++', OP_PRE_DEC: '--',
  OP_POST_INC: '++', OP_POST_DEC: '--',
};

function fmtExpr(e) {
  if (!e) return '';
  if (e instanceof AST.EImplicitCast) return fmtExpr(e.expr);
  if (e instanceof AST.EDecay) return fmtExpr(e.operand);
  if (e instanceof AST.EInt) {
    const tn = e.type && e.type.name;
    if (tn === 'long long' || tn === 'unsigned long long') return String(e.value) + 'LL';
    return String(e.value);
  }
  if (e instanceof AST.EFloat) return String(e.value);
  if (e instanceof AST.EString) {
    const s = String(e.value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return '"' + (s.length > 40 ? s.slice(0, 37) + '…' : s) + '"';
  }
  if (e instanceof AST.EIdent) {
    return (e.decl && e.decl.name) || '?';
  }
  if (e instanceof AST.EBinary) {
    const op = BINOP_TEXT[e.op] || e.op;
    return fmtExpr(e.left) + ' ' + op + ' ' + fmtExpr(e.right);
  }
  if (e instanceof AST.EUnary) {
    const op = UNOP_TEXT[e.op] || e.op;
    if (e.op === 'OP_POST_INC' || e.op === 'OP_POST_DEC') return fmtExpr(e.operand) + op;
    return op + fmtExpr(e.operand);
  }
  if (e instanceof AST.ETernary) {
    return fmtExpr(e.condition) + ' ? ' + fmtExpr(e.thenExpr) + ' : ' + fmtExpr(e.elseExpr);
  }
  if (e instanceof AST.ECall) {
    const args = (e.arguments || []).map(fmtExpr).join(', ');
    return fmtExpr(e.callee) + '(' + args + ')';
  }
  if (e instanceof AST.ESubscript) return fmtExpr(e.array) + '[' + fmtExpr(e.index) + ']';
  if (e instanceof AST.EMember) {
    return fmtExpr(e.base) + '.' + (e.memberDecl && e.memberDecl.name || '?');
  }
  if (e instanceof AST.EArrow) {
    return fmtExpr(e.base) + '->' + (e.memberDecl && e.memberDecl.name || '?');
  }
  if (e instanceof AST.ECast) return '(' + fmtType(e.targetType) + ')' + fmtExpr(e.expr);
  if (e instanceof AST.EComma) {
    return (e.expressions || []).map(fmtExpr).join(', ');
  }
  if (e instanceof AST.ESizeofExpr) return 'sizeof(' + fmtExpr(e.expr) + ')';
  if (e instanceof AST.ESizeofType) return 'sizeof(' + fmtType(e.operandType) + ')';
  // Fallback for less-common nodes
  return '<' + e.constructor.name + '>';
}

function fmtStmt(s) {
  if (!s) return '';
  if (s instanceof AST.SExpr) return fmtExpr(s.expr) + ';';
  if (s instanceof AST.SEmpty) return ';';
  if (s instanceof AST.SDecl) {
    const parts = [];
    for (const d of s.declarations) {
      const tname = fmtType(d.type);
      if (d.storageClass === Types.StorageClass.STATIC) {
        parts.push('static ' + tname + ' ' + d.name);
      } else if (d.storageClass === Types.StorageClass.EXTERN) {
        parts.push('extern ' + tname + ' ' + d.name);
      } else {
        parts.push(tname + ' ' + d.name);
      }
    }
    return parts.join('; ') + ';';
  }
  return '<' + s.constructor.name + '>';
}

function locOf(node) {
  if (!node || !node.loc) return null;
  return { file: node.loc.filename || '?', line: node.loc.line || 0 };
}

function funcToCfgJson(funcDef) {
  const { decls, rewrittenBody } = hoistDeclarations(funcDef);
  const segments = buildSegments(rewrittenBody);

  const segJson = segments.map(seg => {
    const stmts = seg.stmts.map(st => ({
      text: fmtStmt(st),
      loc: locOf(st),
    }));
    const t = seg.term;
    let term;
    if (!t) {
      term = { kind: 'none' };
    } else if (t.kind === 'fallthrough') {
      term = { kind: 'fallthrough', next: t.nextId };
    } else if (t.kind === 'goto') {
      term = { kind: 'goto', target: t.targetId };
    } else if (t.kind === 'branch') {
      term = { kind: 'branch', cond: fmtExpr(t.cond), thenId: t.thenId, elseId: t.elseId };
    } else if (t.kind === 'switch') {
      term = {
        kind: 'switch',
        scrutinee: fmtExpr(t.scrutinee),
        cases: t.cases.map(c => ({ value: String(c.value), target: c.target })),
        defaultTarget: t.defaultTarget,
      };
    } else if (t.kind === 'return') {
      term = { kind: 'return', expr: t.expr ? fmtExpr(t.expr) : null };
    } else {
      term = { kind: t.kind };
    }
    return { id: seg.id, stmts, terminator: term };
  });

  const params = (funcDef.parameters || []).map(p => ({
    name: p.name,
    type: fmtType(p.type),
  }));
  const hoistedDecls = decls.map(d => ({
    name: d.name,
    type: fmtType(d.type),
  }));

  return {
    name: funcDef.name,
    loc: locOf(funcDef),
    params,
    hoistedDecls,
    segments: segJson,
  };
}

return { lower, hoistDeclarations, buildSegments, funcToCfgJson };

})();

// LEB128 encoding utilities (shared between Parser and Wasm)
function lebU(out, value) {
  do {
    let byte = value & 0x7F;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
}

function lebSize(value) {
  var n = 0;
  do { value >>>= 7; n++; } while (value !== 0);
  return n;
}

function lebI(out, value) {
  value = value | 0; // ensure i32 range
  let more = true;
  while (more) {
    let byte = value & 0x7F;
    value >>= 7; // arithmetic shift
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte & 0xFF);
  }
}

function lebI64(out, value) {
  // value is a BigInt for i64 - ensure signed 64-bit range
  if (value > 0x7FFFFFFFFFFFFFFFn || value < -0x8000000000000000n) {
    value = BigInt.asIntN(64, value);
  }
  let more = true;
  while (more) {
    let byte = Number(value & 0x7Fn);
    value >>= 7n; // arithmetic shift
    if ((value === 0n && (byte & 0x40) === 0) || (value === -1n && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte & 0xFF);
  }
}

// ====================
// Parser
// ====================

const Parser = (() => {

class DumpContext {
  constructor() { this.idMap = new Map(); this.nextId = 1; }
  formatId(obj) {
    if (!obj) return "$0";
    if (this.idMap.has(obj)) return "$" + this.idMap.get(obj);
    const id = this.nextId++;
    this.idMap.set(obj, id);
    return "$" + id;
  }
  formatDeclId(decl) { return this.formatId(decl); }
  formatDeclIdOfDefinition(decl) {
    if (decl instanceof AST.DFunc || decl instanceof AST.DVar) {
      return this.formatId(decl.definition);
    }
    return this.formatId(decl);
  }
}

function ind(indent) { return "\n" + "  ".repeat(indent); }

// Format float matching C printf %f (6 decimal places, no scientific notation)
// Format a double exactly like C's printf("%f") — 6 decimal places, full precision.
// Extracts IEEE 754 bits and computes the exact decimal expansion via BigInt.
function formatFloatForDump(v) {
  if (!isFinite(v)) return v.toString();
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = v;
  const dv = new DataView(buf);
  const bits = dv.getBigUint64(0, true); // little-endian
  const sign = bits >> 63n;
  const rawExp = Number((bits >> 52n) & 0x7FFn);
  const frac = bits & 0xFFFFFFFFFFFFFn;

  let mantissa, exp;
  if (rawExp === 0) {
    // subnormal: mantissa = frac, exponent = 1 - 1023 - 52 = -1074
    mantissa = frac;
    exp = -1074;
  } else {
    // normal: mantissa = (1 << 52) | frac, exponent = rawExp - 1023 - 52
    mantissa = (1n << 52n) | frac;
    exp = rawExp - 1023 - 52;
  }

  // exact value = mantissa * 2^exp
  // If exp >= 0: integer = mantissa << exp, fracDigits = "000000"
  // If exp < 0:  multiply by 5^(-exp) to convert denominator from 2^(-exp) to 10^(-exp)
  //              then split at -exp digits from the right
  let intPart, fracStr;
  if (exp >= 0) {
    intPart = (mantissa << BigInt(exp)).toString();
    fracStr = "000000";
  } else {
    const negExp = -exp;
    const full = mantissa * 5n ** BigInt(negExp); // = mantissa * 5^negExp
    const digits = full.toString();
    if (digits.length > negExp) {
      intPart = digits.substring(0, digits.length - negExp);
      fracStr = digits.substring(digits.length - negExp);
    } else {
      intPart = "0";
      fracStr = "0".repeat(negExp - digits.length) + digits;
    }
    // Round to 6 decimal places
    if (fracStr.length > 6) {
      const roundUp = fracStr.charCodeAt(6) >= 53; // '5'
      fracStr = fracStr.substring(0, 6);
      if (roundUp) {
        const rounded = (BigInt(intPart + fracStr) + 1n).toString();
        intPart = rounded.substring(0, rounded.length - 6);
        fracStr = rounded.substring(rounded.length - 6);
        if (!intPart) intPart = "0";
      }
    } else {
      fracStr = (fracStr + "000000").substring(0, 6);
    }
  }
  const result = intPart + "." + fracStr;
  return sign ? "-" + result : result;
}

function dumpExpr(expr, ctx, indent) {
  let ret = ind(indent);
  ret += "Expr: Type=" + expr.type.toString() + " ";
  switch (expr.constructor) {
    case AST.EInt:
      ret += "INT " + expr.value;
      break;
    case AST.EFloat:
      ret += "FLOAT " + formatFloatForDump(expr.value);
      break;
    case AST.EString:
      ret += "STRING len=" + expr.value.length;
      break;
    case AST.EIdent: {
      ret += "IDENT " + expr.name;
      if (expr.decl) {
        const id = ctx.formatDeclId(expr.decl);
        const defnId = ctx.formatDeclIdOfDefinition(expr.decl);
        if (id === defnId) ret += " (decl=" + id + ")";
        else ret += " (decl=" + id + ", defn=" + defnId + ")";
      }
      break;
    }
    case AST.EBinary:
      ret += "BINARY " + Types.BopStr[expr.op];
      ret += dumpExpr(expr.left, ctx, indent + 1);
      ret += dumpExpr(expr.right, ctx, indent + 1);
      break;
    case AST.EUnary:
      ret += "UNARY " + Types.UopStr[expr.op];
      ret += dumpExpr(expr.operand, ctx, indent + 1);
      break;
    case AST.ETernary:
      ret += "TERNARY";
      ret += dumpExpr(expr.condition, ctx, indent + 1);
      ret += dumpExpr(expr.thenExpr, ctx, indent + 1);
      ret += dumpExpr(expr.elseExpr, ctx, indent + 1);
      break;
    case AST.ECall:
      ret += "CALL " + expr.arguments.length + " args";
      ret += dumpExpr(expr.callee, ctx, indent + 1);
      for (const arg of expr.arguments) ret += dumpExpr(arg, ctx, indent + 1);
      break;
    case AST.ESubscript:
      ret += "SUBSCRIPT";
      ret += dumpExpr(expr.array, ctx, indent + 1);
      ret += dumpExpr(expr.index, ctx, indent + 1);
      break;
    case AST.EMember:
      ret += "MEMBER ." + (expr.memberDecl.name ?? "(anon)");
      ret += dumpExpr(expr.base, ctx, indent + 1);
      break;
    case AST.EArrow:
      ret += "ARROW ->" + (expr.memberDecl.name ?? "(anon)");
      ret += dumpExpr(expr.base, ctx, indent + 1);
      break;
    case AST.ECast:
      ret += "CAST " + expr.targetType.toString();
      ret += dumpExpr(expr.expr, ctx, indent + 1);
      break;
    case AST.EImplicitCast:
      ret += "IMPLICIT_CAST " + expr.type.toString();
      ret += dumpExpr(expr.expr, ctx, indent + 1);
      break;
    case AST.EDecay:
      ret += "DECAY " + expr.type.toString();
      ret += dumpExpr(expr.operand, ctx, indent + 1);
      break;
    case AST.ESizeofExpr:
      ret += "SIZEOF_EXPR";
      ret += dumpExpr(expr.expr, ctx, indent + 1);
      break;
    case AST.ESizeofType:
      ret += "SIZEOF_TYPE " + expr.operandType.toString();
      break;
    case AST.EAlignofExpr:
      ret += "ALIGNOF_EXPR";
      ret += dumpExpr(expr.expr, ctx, indent + 1);
      break;
    case AST.EAlignofType:
      ret += "ALIGNOF_TYPE " + expr.operandType.toString();
      break;
    case AST.EComma:
      ret += "COMMA " + expr.expressions.length;
      for (const e of expr.expressions) ret += dumpExpr(e, ctx, indent + 1);
      break;
    case AST.EInitList:
      ret += "INIT_LIST " + expr.elements.length;
      for (const e of expr.elements) ret += dumpExpr(e, ctx, indent + 1);
      break;
    case AST.EIntrinsic:
      ret += "INTRINSIC " + expr.intrinsicKind;
      for (const arg of expr.args) ret += dumpExpr(arg, ctx, indent + 1);
      break;
    case AST.EWasm:
      ret += "WASM " + expr.bytes.length + " bytes " + expr.args.length + " args";
      for (const arg of expr.args) ret += dumpExpr(arg, ctx, indent + 1);
      break;
    case AST.ECompoundLiteral:
      ret += "COMPOUND_LITERAL";
      ret += dumpExpr(expr.initList, ctx, indent + 1);
      break;
  }
  return ret;
}

function dumpStmt(stmt, ctx, indent) {
  let ret = ind(indent);
  ret += "Stmt " + stmt.constructor.name + ":";
  switch (stmt.constructor) {
    case AST.SExpr:
      ret += dumpExpr(stmt.expr, ctx, indent + 1);
      break;
    case AST.SReturn:
      if (stmt.expr) ret += dumpExpr(stmt.expr, ctx, indent + 1);
      else ret += " (no expression)";
      break;
    case AST.SDecl:
      for (const d of stmt.declarations) ret += dumpDecl(d, ctx, indent + 1);
      break;
    case AST.SCompound:
      ret += " " + stmt.statements.length + " statements";
      for (const s of stmt.statements) ret += dumpStmt(s, ctx, indent + 1);
      break;
    case AST.SGoto:
      ret += " " + stmt.label;
      break;
    case AST.SLabel:
      ret += " " + stmt.name;
      break;
    case AST.SIf:
      ret += dumpExpr(stmt.condition, ctx, indent + 1);
      ret += dumpStmt(stmt.thenBranch, ctx, indent + 1);
      if (stmt.elseBranch) ret += dumpStmt(stmt.elseBranch, ctx, indent + 1);
      break;
    case AST.SWhile:
      ret += dumpExpr(stmt.condition, ctx, indent + 1);
      ret += dumpStmt(stmt.body, ctx, indent + 1);
      break;
    case AST.SDoWhile:
      ret += dumpStmt(stmt.body, ctx, indent + 1);
      ret += dumpExpr(stmt.condition, ctx, indent + 1);
      break;
    case AST.SFor:
      if (stmt.init) ret += dumpStmt(stmt.init, ctx, indent + 1);
      else ret += ind(indent + 1) + "(no init)";
      if (stmt.condition) ret += dumpExpr(stmt.condition, ctx, indent + 1);
      else ret += ind(indent + 1) + "(no condition)";
      if (stmt.increment) ret += dumpExpr(stmt.increment, ctx, indent + 1);
      else ret += ind(indent + 1) + "(no increment)";
      ret += dumpStmt(stmt.body, ctx, indent + 1);
      break;
    case AST.SSwitch: {
      ret += dumpExpr(stmt.expr, ctx, indent + 1);
      const cases = [...stmt.body.caseBag];
      ret += ind(indent + 1) + cases.length + " cases";
      for (const c of cases) {
        ret += ind(indent + 2);
        if (c.isDefault) ret += "default:";
        else if (c.lo === c.hi) ret += "case " + c.lo + ":";
        else ret += "case " + c.lo + " ... " + c.hi + ":";
      }
      ret += dumpStmt(stmt.body, ctx, indent + 1);
      break;
    }
    case AST.SCase:
      ret += " " + (stmt.isDefault ? "default" :
        (stmt.lo === stmt.hi ? "case " + stmt.lo : "case " + stmt.lo + " ... " + stmt.hi));
      break;
    case AST.STryCatch:
      ret += dumpStmt(stmt.tryBody, ctx, indent + 1);
      for (const cc of stmt.catches) {
        ret += ind(indent + 1);
        if (cc.tag) ret += "catch " + cc.tag.name;
        else ret += "catch_all";
        ret += dumpStmt(cc.body, ctx, indent + 2);
      }
      break;
    case AST.SThrow:
      ret += " " + stmt.tag.name;
      for (const arg of stmt.args) ret += dumpExpr(arg, ctx, indent + 1);
      break;
    case AST.SEmpty:
    case AST.SBreak:
    case AST.SContinue:
      break;
  }
  return ret;
}

function dumpDecl(decl, ctx, indent) {
  let ret = ind(indent);
  ret += "Decl " + decl.constructor.name + " " + ctx.formatDeclId(decl);
  const defnStr = ctx.formatDeclIdOfDefinition(decl);
  if (defnStr !== ctx.formatDeclId(decl)) {
    ret += " (def=" + defnStr + ")";
  }
  ret += ":";
  if (decl instanceof AST.DVar) {
    ret += " " + decl.name + " " + decl.type.toString();
    if (decl.storageClass !== Types.StorageClass.NONE) ret += " (" + decl.storageClass + ")";
    if (decl.initExpr) ret += dumpExpr(decl.initExpr, ctx, indent + 1);
  } else if (decl instanceof AST.DFunc) {
    ret += " " + decl.name + " " + decl.type.toString();
    if (decl.storageClass !== Types.StorageClass.NONE) ret += " (" + decl.storageClass + ")";
    ret += ind(indent + 1) + decl.parameters.length + " parameters";
    for (const p of decl.parameters) ret += dumpDecl(p, ctx, indent + 2);
    if (decl.body) ret += dumpStmt(decl.body, ctx, indent + 1);
  }
  return ret;
}

function dumpTUnit(unit, ctx, depth) {
  let ret = ind(depth) + "Translation Unit " + unit.filename;
  const show = (d) => { ret += dumpDecl(d, ctx, depth + 1); };
  for (const f of unit.importedFunctions) show(f);
  for (const f of unit.definedFunctions) show(f);
  for (const f of unit.staticFunctions) show(f);
  for (const f of unit.declaredFunctions) show(f);
  for (const f of unit.localDeclaredFunctions) show(f);
  for (const v of unit.definedVariables) show(v);
  for (const v of unit.externVariables) show(v);
  for (const v of unit.localExternVariables) show(v);
  return ret;
}

function dumpAst(units) {
  const ctx = new DumpContext();
  let out = "";
  for (const unit of units) {
    out += dumpTUnit(unit, ctx, 0) + "\n";
  }
  return out;
}

// ====================
// C Pretty-Printer — AST→C source
// ====================
//
// Emits re-compilable C code from the AST. The output parses to the same
// AST (modulo source locations and cosmetic whitespace). EImplicitCast and
// EDecay nodes are transparent — they're re-inserted deterministically by
// the parser, so we skip them here.

function printC(units, options) {
  const showStdlib = !!(options && options.showStdlib);
  const out = [];
  const emittedTags = new Set();
  let curLine = 1;
  let curLoc = null;
  const lineMap = [];

  function w(s) {
    out.push(s);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\n') {
        if (curLoc && curLoc.filename !== '<generated>') {
          if (!lineMap[curLine]) lineMap[curLine] = { file: curLoc.filename, line: curLoc.line };
        }
        curLine++;
      }
    }
  }

  function setLoc(loc) { if (loc) curLoc = loc; }

  // --- Type spelling (C's inside-out declaration syntax) ---
  // spellType(type, declarator) returns a string like "int (*x)[10]".
  // `declarator` is the "inner" part built outward from the variable name.
  function spellType(type, declarator) {
    type = type.removeQualifiers ? type : type;
    const q = qualPrefix(type);
    const uq = type.removeQualifiers();
    if (uq instanceof Types.PointerType) {
      let inner = "*" + q + declarator;
      const base = uq.baseType.removeQualifiers();
      if (base instanceof Types.ArrayType || base.isFunction()) inner = "(" + inner + ")";
      return spellType(uq.baseType, inner);
    }
    if (uq instanceof Types.ArrayType) {
      const sz = uq.arraySize >= 0 ? String(uq.arraySize) : "";
      return spellType(uq.baseType, declarator + "[" + sz + "]");
    }
    if (uq.isFunction()) {
      const params = [];
      for (let i = 0; i < uq.paramTypes.length; i++) {
        params.push(spellType(uq.paramTypes[i], ""));
      }
      if (uq.isVarArg) params.push("...");
      else if (params.length === 0 && !uq.hasUnspecifiedParams) params.push("void");
      return spellType(uq.returnType, declarator + "(" + params.join(", ") + ")");
    }
    return q + spellBaseType(uq) + (declarator ? " " + declarator : "");
  }

  function qualPrefix(type) {
    let q = "";
    if (type.isConst) q += "const ";
    if (type.isVolatile) q += "volatile ";
    return q;
  }

  function spellBaseType(type) {
    const uq = type.removeQualifiers();
    if (uq.isTag && uq.isTag()) {
      return uq.tagKind + " " + uq.tagName;
    }
    if (uq instanceof Types.GCStructRefType) return "__struct " + uq.tagName + " *";
    if (uq instanceof Types.GCStructHeapType) return "__struct " + uq.tagName;
    if (uq instanceof Types.GCArrayType) return "__array(" + spellBaseType(uq.baseType) + ")";
    if (uq instanceof Types.ExternRefType) return "__externref";
    if (uq instanceof Types.RefExternType) return "__refextern";
    if (uq instanceof Types.EqRefType) return "__eqref";
    if (uq === Types.TVOID) return "void";
    if (uq === Types.TBOOL) return "_Bool";
    if (uq.name) return uq.name;
    return uq.toString();
  }

  // Spell a declaration with a name: "int x", "void (*fp)(int)"
  function spellDecl(type, name) {
    return spellType(type, name);
  }

  // --- Tag (struct/union/enum) definition emission ---
  function emitTagDef(tagDecl, indent) {
    if (!tagDecl || emittedTags.has(tagDecl)) return;
    emittedTags.add(tagDecl);
    const ind = "  ".repeat(indent);
    if (tagDecl.tagKind === "enum") {
      w(ind + tagDecl.tagKind + " " + (tagDecl.name || "") + " {\n");
      for (let i = 0; i < tagDecl.members.length; i++) {
        const m = tagDecl.members[i];
        w(ind + "  " + m.name + " = " + m.value);
        if (i < tagDecl.members.length - 1) w(",");
        w("\n");
      }
      w(ind + "}");
      return;
    }
    // struct / union
    w(ind + tagDecl.tagKind + " " + (tagDecl.name || ""));
    if (!tagDecl.isComplete) return;
    w(" {\n");
    for (const m of tagDecl.members) {
      if (!m.name && m.type && m.type.isTag && m.type.isTag() && m.type.tagDecl) {
        emitTagDef(m.type.tagDecl, indent + 1);
        w(";\n");
        continue;
      }
      w(ind + "  " + spellDecl(m.type, m.name || ""));
      if (m.bitWidth >= 0) w(" : " + m.bitWidth);
      w(";\n");
    }
    w(ind + "}");
    if (tagDecl.isPacked) w(" __attribute__((packed))");
  }

  // Emit tag definition inline if this type references a tag we haven't
  // emitted yet. Returns the base type string to use.
  function maybeEmitInlineTag(type) {
    const uq = type.removeQualifiers();
    if (uq.isTag && uq.isTag() && uq.tagDecl && uq.tagDecl.isComplete && !emittedTags.has(uq.tagDecl)) {
      return true;
    }
    return false;
  }

  // --- Operator precedence for minimal parenthesization ---
  const PREC = {
    COMMA: 1,
    ASSIGN: 2, ADD_ASSIGN: 2, SUB_ASSIGN: 2, MUL_ASSIGN: 2,
    DIV_ASSIGN: 2, MOD_ASSIGN: 2, BAND_ASSIGN: 2, BOR_ASSIGN: 2,
    BXOR_ASSIGN: 2, SHL_ASSIGN: 2, SHR_ASSIGN: 2,
    TERNARY: 3,
    LOR: 4, LAND: 5, BOR: 6, BXOR: 7, BAND: 8,
    EQ: 9, NE: 9, LT: 10, GT: 10, LE: 10, GE: 10,
    SHL: 11, SHR: 11, ADD: 12, SUB: 12, MUL: 13, DIV: 13, MOD: 13,
    UNARY: 14, POSTFIX: 15, PRIMARY: 16,
  };

  function exprPrec(expr) {
    if (!expr) return PREC.PRIMARY;
    if (expr instanceof AST.EImplicitCast) return exprPrec(expr.expr);
    if (expr instanceof AST.EDecay) return exprPrec(expr.operand);
    if (expr instanceof AST.EBinary) return PREC[expr.op] || PREC.PRIMARY;
    if (expr instanceof AST.EComma) return PREC.COMMA;
    if (expr instanceof AST.ETernary) return PREC.TERNARY;
    if (expr instanceof AST.EUnary) {
      if (expr.op === "OP_POST_INC" || expr.op === "OP_POST_DEC") return PREC.POSTFIX;
      return PREC.UNARY;
    }
    if (expr instanceof AST.ECast) return PREC.UNARY;
    return PREC.PRIMARY;
  }

  function paren(inner, innerPrec, neededPrec) {
    return innerPrec < neededPrec ? "(" + inner + ")" : inner;
  }

  // --- Expression emission ---
  function emitExpr(expr) {
    if (!expr) return "0";
    if (expr instanceof AST.EImplicitCast) return emitExpr(expr.expr);
    if (expr instanceof AST.EDecay) return emitExpr(expr.operand);

    if (expr instanceof AST.EInt) {
      const t = expr.type.removeQualifiers();
      let s = String(expr.value);
      if (expr.value < 0n) s = "(" + s + ")";
      if (t === Types.TUINT || t === Types.TULONG) s += "U";
      else if (t === Types.TLLONG) s += "LL";
      else if (t === Types.TULLONG) s += "ULL";
      else if (t === Types.TLONG) s += "L";
      return s;
    }
    if (expr instanceof AST.EFloat) {
      const t = expr.type.removeQualifiers();
      let s;
      if (!isFinite(expr.value)) {
        if (expr.value === Infinity) s = "(1.0/0.0)";
        else if (expr.value === -Infinity) s = "(-1.0/0.0)";
        else s = "(0.0/0.0)";
      } else {
        s = expr.value.toString();
        if (!s.includes(".") && !s.includes("e") && !s.includes("E")) s += ".0";
      }
      if (t === Types.TFLOAT) s += "f";
      else if (t === Types.TLDOUBLE) s += "L";
      return s;
    }
    if (expr instanceof AST.EString) {
      return emitStringLiteral(expr);
    }
    if (expr instanceof AST.EIdent) {
      return expr.decl.name;
    }
    if (expr instanceof AST.EBinary) {
      const meta = AST.BinOp[expr.op];
      const p = PREC[expr.op] || PREC.PRIMARY;
      const isRightAssoc = meta.isAssign;
      const left = paren(emitExpr(expr.left), exprPrec(expr.left), isRightAssoc ? p + 1 : p);
      const right = paren(emitExpr(expr.right), exprPrec(expr.right), isRightAssoc ? p : p + 1);
      return left + " " + meta.text + " " + right;
    }
    if (expr instanceof AST.EUnary) {
      const meta = AST.UnOp[expr.op];
      if (expr.op === "OP_POST_INC" || expr.op === "OP_POST_DEC") {
        return paren(emitExpr(expr.operand), exprPrec(expr.operand), PREC.POSTFIX) + meta.text;
      }
      const inner = paren(emitExpr(expr.operand), exprPrec(expr.operand), PREC.UNARY);
      return meta.text + inner;
    }
    if (expr instanceof AST.ETernary) {
      const c = paren(emitExpr(expr.condition), exprPrec(expr.condition), PREC.TERNARY + 1);
      const t = emitExpr(expr.thenExpr);
      const e = paren(emitExpr(expr.elseExpr), exprPrec(expr.elseExpr), PREC.TERNARY);
      return c + " ? " + t + " : " + e;
    }
    if (expr instanceof AST.ECall) {
      const callee = paren(emitExpr(expr.callee), exprPrec(expr.callee), PREC.POSTFIX);
      const args = expr.arguments.map(a => emitExpr(a)).join(", ");
      return callee + "(" + args + ")";
    }
    if (expr instanceof AST.ESubscript) {
      return paren(emitExpr(expr.array), exprPrec(expr.array), PREC.POSTFIX) + "[" + emitExpr(expr.index) + "]";
    }
    if (expr instanceof AST.EMember) {
      return paren(emitExpr(expr.base), exprPrec(expr.base), PREC.POSTFIX) + "." + expr.memberDecl.name;
    }
    if (expr instanceof AST.EArrow) {
      return paren(emitExpr(expr.base), exprPrec(expr.base), PREC.POSTFIX) + "->" + expr.memberDecl.name;
    }
    if (expr instanceof AST.ECast) {
      return "(" + spellType(expr.targetType, "") + ")" + paren(emitExpr(expr.expr), exprPrec(expr.expr), PREC.UNARY);
    }
    if (expr instanceof AST.ESizeofExpr) {
      return "sizeof(" + emitExpr(expr.expr) + ")";
    }
    if (expr instanceof AST.ESizeofType) {
      return "sizeof(" + spellType(expr.operandType, "") + ")";
    }
    if (expr instanceof AST.EAlignofExpr) {
      return "_Alignof(" + emitExpr(expr.expr) + ")";
    }
    if (expr instanceof AST.EAlignofType) {
      return "_Alignof(" + spellType(expr.operandType, "") + ")";
    }
    if (expr instanceof AST.EComma) {
      return emitExpr(expr.left) + ", " + emitExpr(expr.right);
    }
    if (expr instanceof AST.EInitList) {
      return "{" + expr.elements.map(e => emitExpr(e)).join(", ") + "}";
    }
    if (expr instanceof AST.ECompoundLiteral) {
      return "(" + spellType(expr.type, "") + ")" + emitExpr(expr.initList);
    }
    if (expr instanceof AST.EIntrinsic) {
      return emitIntrinsic(expr);
    }
    if (expr instanceof AST.EWasm) {
      return emitWasm(expr);
    }
    if (expr instanceof AST.EGCNew) {
      return "__gc_new(" + expr.args.map(a => emitExpr(a)).join(", ") + ")";
    }
    return "/* unknown expr " + expr.constructor.name + " */0";
  }

  function emitStringLiteral(expr) {
    const elemType = expr.type.baseType;
    const elemSize = elemType.size;
    let prefix = "";
    if (elemSize === 2) prefix = "u";
    else if (elemSize === 4) prefix = "U";
    const bytes = expr.value;
    let s = prefix + "\"";
    // Decode elements from the byte array
    const nullTermBytes = elemSize;
    const contentLen = bytes.length - nullTermBytes;
    for (let i = 0; i < contentLen; i += elemSize) {
      let ch;
      if (elemSize === 1) ch = bytes[i];
      else if (elemSize === 2) ch = bytes[i] | (bytes[i + 1] << 8);
      else ch = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
      if (ch === 0) s += "\\0";
      else if (ch === 7) s += "\\a";
      else if (ch === 8) s += "\\b";
      else if (ch === 9) s += "\\t";
      else if (ch === 10) s += "\\n";
      else if (ch === 11) s += "\\v";
      else if (ch === 12) s += "\\f";
      else if (ch === 13) s += "\\r";
      else if (ch === 27) s += "\\e";
      else if (ch === 34) s += "\\\"";
      else if (ch === 92) s += "\\\\";
      else if (ch >= 32 && ch < 127) s += String.fromCharCode(ch);
      else if (elemSize === 1) s += "\\x" + ch.toString(16).padStart(2, "0");
      else if (elemSize === 2) s += "\\u" + ch.toString(16).padStart(4, "0");
      else s += "\\U" + (ch >>> 0).toString(16).padStart(8, "0");
    }
    s += "\"";
    return s;
  }

  function emitIntrinsic(expr) {
    const args = expr.args.map(a => emitExpr(a)).join(", ");
    switch (expr.intrinsicKind) {
      case Types.IntrinsicKind.VA_START: return "__builtin_va_start(" + args + ")";
      case Types.IntrinsicKind.VA_ARG: return "__builtin_va_arg(" + args + ")";
      case Types.IntrinsicKind.VA_END: return "__builtin_va_end(" + args + ")";
      case Types.IntrinsicKind.VA_COPY: return "__builtin_va_copy(" + args + ")";
      case Types.IntrinsicKind.UNREACHABLE: return "__builtin_unreachable()";
      case Types.IntrinsicKind.ALLOCA: return "__builtin(alloca" + (args ? ", " + args : "") + ")";
      case Types.IntrinsicKind.MEMORY_SIZE: return "__builtin(memory_size)";
      case Types.IntrinsicKind.MEMORY_GROW: return "__builtin(memory_grow, " + args + ")";
      case Types.IntrinsicKind.MEMORY_COPY: return "__builtin(memory_copy, " + args + ")";
      case Types.IntrinsicKind.MEMORY_FILL: return "__builtin(memory_fill, " + args + ")";
      case Types.IntrinsicKind.HEAP_BASE: return "__builtin(heap_base)";
      case Types.IntrinsicKind.REF_IS_NULL: return "__ref_is_null(" + args + ")";
      case Types.IntrinsicKind.REF_EQ: return "__ref_eq(" + args + ")";
      case Types.IntrinsicKind.REF_NULL: {
        const t = expr.argType || expr.type;
        return "__ref_null(" + spellType(t, "") + ")";
      }
      case Types.IntrinsicKind.REF_TEST: return "__ref_test(" + spellType(expr.argType, "") + ", " + args + ")";
      case Types.IntrinsicKind.REF_TEST_NULL: return "__ref_test_null(" + spellType(expr.argType, "") + ", " + args + ")";
      case Types.IntrinsicKind.REF_CAST: return "__ref_cast(" + spellType(expr.argType, "") + ", " + args + ")";
      case Types.IntrinsicKind.REF_CAST_NULL: return "__ref_cast_null(" + spellType(expr.argType, "") + ", " + args + ")";
      case Types.IntrinsicKind.ARRAY_LEN: return "__array_len(" + args + ")";
      case Types.IntrinsicKind.GC_NEW_ARRAY: return "__gc_new_array(" + spellType(expr.argType, "") + ", " + args + ")";
      case Types.IntrinsicKind.ARRAY_FILL: return "__array_fill(" + args + ")";
      case Types.IntrinsicKind.ARRAY_COPY: return "__array_copy(" + args + ")";
      case Types.IntrinsicKind.REF_AS_EXTERN: return "__ref_as_extern(" + args + ")";
      case Types.IntrinsicKind.REF_AS_EQ: return "__ref_as_eq(" + args + ")";
      case Types.IntrinsicKind.CAST: return "__cast(" + spellType(expr.argType, "") + ", " + args + ")";
      default: return "/* intrinsic:" + expr.intrinsicKind + " */(" + args + ")";
    }
  }

  function emitWasm(expr) {
    const args = expr.args.map(a => emitExpr(a));
    const hexBytes = Array.from(expr.bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");
    return "__wasm(\"" + hexBytes + "\"" + (args.length ? ", " + args.join(", ") : "") + ")";
  }

  // --- Statement emission ---
  function emitStmt(stmt, indent) {
    if (!stmt) return;
    setLoc(stmt.loc);
    const ind = "  ".repeat(indent);
    if (stmt instanceof AST.SCompound) {
      w(ind + "{\n");
      for (const s of stmt.statements) emitStmt(s, indent + 1);
      w(ind + "}\n");
      return;
    }
    if (stmt instanceof AST.SExpr) {
      w(ind + emitExpr(stmt.expr) + ";\n");
      return;
    }
    if (stmt instanceof AST.SDecl) {
      for (const d of stmt.declarations) {
        emitLocalDecl(d, indent);
      }
      return;
    }
    if (stmt instanceof AST.SReturn) {
      if (stmt.expr) w(ind + "return " + emitExpr(stmt.expr) + ";\n");
      else w(ind + "return;\n");
      return;
    }
    if (stmt instanceof AST.SIf) {
      w(ind + "if (" + emitExpr(stmt.condition) + ")\n");
      emitBody(stmt.thenBranch, indent);
      if (stmt.elseBranch) {
        w(ind + "else\n");
        emitBody(stmt.elseBranch, indent);
      }
      return;
    }
    if (stmt instanceof AST.SWhile) {
      w(ind + "while (" + emitExpr(stmt.condition) + ")\n");
      emitBody(stmt.body, indent);
      return;
    }
    if (stmt instanceof AST.SDoWhile) {
      w(ind + "do\n");
      emitBody(stmt.body, indent);
      w(ind + "while (" + emitExpr(stmt.condition) + ");\n");
      return;
    }
    if (stmt instanceof AST.SFor) {
      w(ind + "for (");
      if (stmt.init) {
        if (stmt.init instanceof AST.SDecl) {
          const parts = [];
          for (const d of stmt.init.declarations) {
            let s = spellDecl(d.type, d.name);
            if (d.initExpr) s += " = " + emitExpr(d.initExpr);
            parts.push(s);
          }
          w(parts.join(", "));
        } else if (stmt.init instanceof AST.SExpr) {
          w(emitExpr(stmt.init.expr));
        }
      }
      w("; ");
      if (stmt.condition) w(emitExpr(stmt.condition));
      w("; ");
      if (stmt.increment) w(emitExpr(stmt.increment));
      w(")\n");
      emitBody(stmt.body, indent);
      return;
    }
    if (stmt instanceof AST.SSwitch) {
      w(ind + "switch (" + emitExpr(stmt.expr) + ")\n");
      emitBody(stmt.body, indent);
      return;
    }
    if (stmt instanceof AST.SCase) {
      const cind = "  ".repeat(Math.max(0, indent - 1));
      if (stmt.isDefault) w(cind + "default:\n");
      else if (stmt.lo === stmt.hi) w(cind + "case " + stmt.lo + ":\n");
      else w(cind + "case " + stmt.lo + " ... " + stmt.hi + ":\n");
      return;
    }
    if (stmt instanceof AST.SGoto) {
      w(ind + "goto " + stmt.label + ";\n");
      return;
    }
    if (stmt instanceof AST.SLabel) {
      w(stmt.name + ":\n");
      return;
    }
    if (stmt instanceof AST.SBreak) { w(ind + "break;\n"); return; }
    if (stmt instanceof AST.SContinue) { w(ind + "continue;\n"); return; }
    if (stmt instanceof AST.SEmpty) { w(ind + ";\n"); return; }
    if (stmt instanceof AST.STryCatch) {
      w(ind + "__try\n");
      emitBody(stmt.tryBody, indent);
      for (const cc of stmt.catches) {
        if (cc.tag) {
          w(ind + "__catch " + cc.tag.name + "(" + cc.bindings.join(", ") + ")\n");
        } else {
          w(ind + "__catch\n");
        }
        emitBody(cc.body, indent);
      }
      return;
    }
    if (stmt instanceof AST.SThrow) {
      w(ind + "__throw " + stmt.tag.name + "(" + stmt.args.map(a => emitExpr(a)).join(", ") + ");\n");
      return;
    }
    w(ind + "/* unknown stmt: " + stmt.constructor.name + " */\n");
  }

  // Emit a stmt as a block body — if it's a compound, emit directly;
  // otherwise wrap in braces for safety.
  function emitBody(stmt, indent) {
    if (stmt instanceof AST.SCompound) {
      emitStmt(stmt, indent);
    } else {
      const ind = "  ".repeat(indent);
      w(ind + "{\n");
      emitStmt(stmt, indent + 1);
      w(ind + "}\n");
    }
  }

  // --- Local declarations ---
  function emitLocalDecl(decl, indent) {
    setLoc(decl.loc);
    const ind = "  ".repeat(indent);
    if (decl instanceof AST.DVar) {
      let s = "";
      if (decl.storageClass === Types.StorageClass.STATIC) s += "static ";
      else if (decl.storageClass === Types.StorageClass.EXTERN) s += "extern ";
      else if (decl.storageClass === Types.StorageClass.REGISTER) s += "register ";
      s += spellDecl(decl.type, decl.name);
      if (decl.initExpr) s += " = " + emitExpr(decl.initExpr);
      w(ind + s + ";\n");
    } else if (decl instanceof AST.DFunc) {
      emitFuncDecl(decl, indent);
    }
  }

  // --- Top-level declaration emission ---
  function emitTopLevelDecl(decl) {
    if (decl instanceof AST.DFunc) {
      emitFuncDecl(decl, 0);
    } else if (decl instanceof AST.DVar) {
      emitVarDecl(decl, 0);
    }
  }

  function storagePrefix(decl) {
    if (decl.storageClass === Types.StorageClass.STATIC) return "static ";
    if (decl.storageClass === Types.StorageClass.EXTERN) return "extern ";
    if (decl.storageClass === Types.StorageClass.IMPORT) return "__import ";
    return "";
  }

  function emitVarDecl(decl, indent) {
    setLoc(decl.loc);
    const ind = "  ".repeat(indent);
    let s = storagePrefix(decl);
    // Check if we need to emit the tag definition inline
    const uq = decl.type.removeQualifiers();
    if (maybeEmitInlineTag(decl.type)) {
      emitTagDef(uq.tagDecl, indent);
      w(" " + decl.name);
    } else {
      s += spellDecl(decl.type, decl.name);
      w(ind + s);
    }
    if (decl.initExpr) w(" = " + emitExpr(decl.initExpr));
    w(";\n");
  }

  function emitFuncDecl(decl, indent) {
    setLoc(decl.loc);
    const ind = "  ".repeat(indent);
    let prefix = storagePrefix(decl);
    if (decl.isInline) prefix += "inline ";

    // Build parameter list with names
    const paramStrs = [];
    for (let i = 0; i < decl.parameters.length; i++) {
      const p = decl.parameters[i];
      paramStrs.push(spellDecl(p.type, p.name || ""));
    }
    if (decl.type.isVarArg) paramStrs.push("...");
    else if (paramStrs.length === 0 && !decl.type.hasUnspecifiedParams) paramStrs.push("void");

    const retType = decl.type.getReturnType();
    const declStr = decl.name + "(" + paramStrs.join(", ") + ")";
    w(ind + prefix + spellType(retType, declStr));

    if (decl.body) {
      w("\n");
      emitStmt(decl.body, indent);
    } else {
      w(";\n");
    }
  }

  // Collect all tag types referenced anywhere in a type tree
  function collectTagsFromType(type, tags) {
    if (!type) return;
    const uq = type.removeQualifiers();
    if (uq.isTag && uq.isTag() && uq.tagDecl && uq.tagDecl.isComplete) {
      if (!tags.has(uq.tagDecl)) {
        tags.set(uq.tagDecl, uq.tagDecl);
        for (const m of uq.tagDecl.members) collectTagsFromType(m.type, tags);
      }
    }
    if (uq instanceof Types.PointerType) collectTagsFromType(uq.baseType, tags);
    if (uq instanceof Types.ArrayType) collectTagsFromType(uq.baseType, tags);
    if (uq.isFunction()) {
      collectTagsFromType(uq.returnType, tags);
      for (const p of uq.paramTypes) collectTagsFromType(p, tags);
    }
  }

  function collectTagsFromExpr(expr, tags) {
    if (!expr) return;
    collectTagsFromType(expr.type, tags);
    if (expr.children) for (const c of expr.children) collectTagsFromExpr(c, tags);
  }

  function collectTagsFromStmt(stmt, tags) {
    if (!stmt) return;
    if (stmt instanceof AST.SCompound) {
      for (const s of stmt.statements) collectTagsFromStmt(s, tags);
    } else if (stmt instanceof AST.SExpr) {
      collectTagsFromExpr(stmt.expr, tags);
    } else if (stmt instanceof AST.SDecl) {
      for (const d of stmt.declarations) {
        collectTagsFromType(d.type, tags);
        if (d.initExpr) collectTagsFromExpr(d.initExpr, tags);
      }
    } else if (stmt instanceof AST.SIf) {
      collectTagsFromExpr(stmt.condition, tags);
      collectTagsFromStmt(stmt.thenBranch, tags);
      if (stmt.elseBranch) collectTagsFromStmt(stmt.elseBranch, tags);
    } else if (stmt instanceof AST.SWhile) {
      collectTagsFromExpr(stmt.condition, tags);
      collectTagsFromStmt(stmt.body, tags);
    } else if (stmt instanceof AST.SDoWhile) {
      collectTagsFromStmt(stmt.body, tags);
      collectTagsFromExpr(stmt.condition, tags);
    } else if (stmt instanceof AST.SFor) {
      if (stmt.init) collectTagsFromStmt(stmt.init, tags);
      if (stmt.condition) collectTagsFromExpr(stmt.condition, tags);
      if (stmt.increment) collectTagsFromExpr(stmt.increment, tags);
      collectTagsFromStmt(stmt.body, tags);
    } else if (stmt instanceof AST.SSwitch) {
      collectTagsFromExpr(stmt.expr, tags);
      collectTagsFromStmt(stmt.body, tags);
    } else if (stmt instanceof AST.SReturn && stmt.expr) {
      collectTagsFromExpr(stmt.expr, tags);
    } else if (stmt instanceof AST.STryCatch) {
      collectTagsFromStmt(stmt.tryBody, tags);
      for (const cc of stmt.catches) collectTagsFromStmt(cc.body, tags);
    } else if (stmt instanceof AST.SThrow) {
      for (const a of stmt.args) collectTagsFromExpr(a, tags);
    }
  }

  // --- Translation unit ---
  function emitTUnit(unit) {
    // Collect all top-level decls and sort by id (source order)
    const allDecls = [];
    for (const f of unit.importedFunctions) allDecls.push(f);
    for (const f of unit.declaredFunctions) allDecls.push(f);
    for (const f of unit.localDeclaredFunctions) allDecls.push(f);
    for (const v of unit.externVariables) allDecls.push(v);
    for (const v of unit.localExternVariables) allDecls.push(v);
    for (const f of unit.definedFunctions) allDecls.push(f);
    for (const f of unit.staticFunctions) allDecls.push(f);
    for (const v of unit.definedVariables) allDecls.push(v);
    allDecls.sort((a, b) => a.id - b.id);

    // Collect all tag definitions referenced anywhere in this TU
    const tags = new Map();
    for (const decl of allDecls) {
      if (decl.type) collectTagsFromType(decl.type, tags);
      if (decl instanceof AST.DFunc) {
        for (const p of decl.parameters) collectTagsFromType(p.type, tags);
        if (decl.body) collectTagsFromStmt(decl.body, tags);
      }
    }
    // Emit tag definitions sorted by decl id (definition order)
    const sortedTags = [...tags.values()].sort((a, b) => a.id - b.id);
    for (const tagDecl of sortedTags) {
      if (!emittedTags.has(tagDecl)) {
        emitTagDef(tagDecl, 0);
        w(";\n\n");
      }
    }

    for (const decl of allDecls) {
      emitTopLevelDecl(decl);
      w("\n");
    }
  }

  for (const unit of units) {
    if (!showStdlib && unit.filename.startsWith("__")) continue;
    emitTUnit(unit);
  }
  return { text: out.join(""), lineMap: lineMap };
}

// Whole-program tree-shake. Walks the AST bag (referencedFunctions /
// referencedVariables) from cross-TU roots: `main`, `alloca`, exports.
// Any decl not reached from those roots — including non-static defined
// functions / globals — gets dropped. This is more aggressive than
// INLINER.optimize's per-TU pass, which has to assume non-static decls
// might be called from another TU.
function gcSectionsPass(units, options) {
  const liveFuncs = new Set();
  const liveVars = new Set();
  const funcQ = [];
  const varQ = [];
  const enqueueFunc = (f) => {
    if (!f || liveFuncs.has(f)) return;
    liveFuncs.add(f);
    funcQ.push(f);
  };
  const enqueueVar = (v) => {
    if (!v || liveVars.has(v)) return;
    liveVars.add(v);
    varQ.push(v);
  };
  const visitRefs = (node) => {
    for (const f of node.referencedFunctions) enqueueFunc(f);
    for (const v of node.referencedVariables) enqueueVar(v);
  };

  // Seed cross-TU roots.
  for (const unit of units) {
    for (const f of unit.definedFunctions) {
      if (f.name === "main" || f.name === "alloca") enqueueFunc(f);
    }
    if (!(options && options.gcNoExportRoots)) {
      for (const [, func] of unit.exportDirectives) enqueueFunc(func);
    }
  }

  // Drain. The bag follows decl.definition || decl, so cross-TU
  // references resolve naturally to the body-bearing instance after
  // the linker has run setDefinition.
  while (funcQ.length > 0 || varQ.length > 0) {
    while (funcQ.length > 0) {
      const f = funcQ.shift();
      if (f.body) visitRefs(f.body);
      for (const v of (f.staticLocals || [])) {
        if (v.initExpr) visitRefs(v.initExpr);
      }
    }
    while (varQ.length > 0) {
      const v = varQ.shift();
      if (v.initExpr) visitRefs(v.initExpr);
    }
  }

  const keepF = (f) => liveFuncs.has(f);
  const keepV = (v) => liveVars.has(v);
  for (const unit of units) {
    unit.importedFunctions = unit.importedFunctions.filter(keepF);
    unit.definedFunctions = unit.definedFunctions.filter(keepF);
    unit.staticFunctions = unit.staticFunctions.filter(keepF);
    unit.declaredFunctions = unit.declaredFunctions.filter(keepF);
    unit.localDeclaredFunctions = unit.localDeclaredFunctions.filter(keepF);
    unit.definedVariables = unit.definedVariables.filter(keepV);
    unit.externVariables = unit.externVariables.filter(keepV);
    unit.localExternVariables = unit.localExternVariables.filter(keepV);
  }
}

// ====================
// Linker
// ====================

function linkTranslationUnits(units, compilerOptions) {
  const errors = [];
  const externScope = new Map();

  function addError(message, locations) { errors.push({ message, locations: locations || [] }); }

  function isStatic(decl) {
    return decl.storageClass === Types.StorageClass.STATIC;
  }

  function isDefinition(decl) {
    if (decl instanceof AST.DVar) {
      return decl.storageClass !== Types.StorageClass.EXTERN || decl.initExpr != null;
    } else if (decl instanceof AST.DFunc) {
      return decl.body != null;
    }
    return false;
  }

  /* A "tentative definition" (C11 6.9.2 §2): a file-scope variable
   * declared without an initializer and without `extern`. Multiple
   * tentative definitions of the same identifier in the same scope are
   * merged into one object — only one becomes the real definition, and
   * the others are absorbed. If any later declaration has an
   * initializer, it wins. */
  function isTentativeDefinition(decl) {
    return decl instanceof AST.DVar
        && decl.storageClass !== Types.StorageClass.EXTERN
        && decl.initExpr == null;
  }

  function isImportFunction(decl) {
    return decl instanceof AST.DFunc && decl.storageClass === Types.StorageClass.IMPORT;
  }

  function getDeclType(decl) { return decl.type; }
  function getName(decl) { return decl.name; }

  function checkCompatibility(a, b) {
    const locs = [a.loc, b.loc].filter(l => l?.filename);
    if (a.constructor !== b.constructor) {
      addError(`declaration and definition kinds do not match for symbol '${getName(a)}'`, locs);
      return;
    }
    const ta = getDeclType(a), tb = getDeclType(b);
    if (ta && tb && !ta.isCompatibleWith(tb)) {
      addError(`conflicting types for '${getName(a)}' ('${ta.toString()}' vs '${tb.toString()}')`, locs);
    }
  }

  function setDefinition(decl, definition) {
    if (decl.constructor !== definition.constructor) return;
    if (decl instanceof AST.DVar) {
      decl.definition = definition;
      // Propagate allocClass
      if (decl.allocClass === Types.AllocClass.MEMORY) {
        definition.allocClass = Types.AllocClass.MEMORY;
      }
    } else if (decl instanceof AST.DFunc) {
      decl.definition = definition;
    }
  }

  function addDecl(scope, decl) {
    const name = getName(decl);
    if (!name) throw new Error("Declaration has no name");

    if (!scope.has(name)) {
      scope.set(name, decl);
      return;
    }

    const existing = scope.get(name);
    checkCompatibility(existing, decl);

    if (!isDefinition(decl) || isImportFunction(decl)) return;

    if (isDefinition(existing)) {
      // Allow duplicate definitions for inline functions
      if (decl instanceof AST.DFunc && decl.isInline &&
          existing instanceof AST.DFunc && existing.isInline) {
        return;
      }
      // C11 6.9.2: tentative definitions merge. Two tentatives → same
      // object; a later definition with an initializer supersedes any
      // prior tentative.
      if (isTentativeDefinition(existing) && isTentativeDefinition(decl)) {
        return;  // collapse second tentative into the first
      }
      if (isTentativeDefinition(existing) && decl instanceof AST.DVar && decl.initExpr != null) {
        scope.set(name, decl);  // initializer wins
        return;
      }
      if (isTentativeDefinition(decl) && existing instanceof AST.DVar && existing.initExpr != null) {
        return;  // existing initializer wins
      }
      addError(`Duplicate definition of symbol '${name}'`);
      return;
    }

    scope.set(name, decl);
  }

  function forEachDecl(unit, forStatic, callback) {
    const check = (d) => { if (isStatic(d) === forStatic) callback(d); };
    for (const f of unit.importedFunctions) check(f);
    for (const f of unit.definedFunctions) check(f);
    for (const f of unit.staticFunctions) check(f);
    for (const f of unit.declaredFunctions) check(f);
    for (const f of unit.localDeclaredFunctions) check(f);
    for (const v of unit.definedVariables) check(v);
    for (const v of unit.externVariables) check(v);
    for (const v of unit.localExternVariables) check(v);
  }

  function collectSymbols(unit, outScope, forStatic) {
    forEachDecl(unit, forStatic, (decl) => {
      const scope = isStatic(decl) ? outScope : externScope;
      addDecl(scope, decl);
    });
  }

  function linkSymbols(scope, unit, forStatic) {
    forEachDecl(unit, forStatic, (decl) => {
      const name = getName(decl);
      const it = scope.get(name);
      if (!it) {
        addError(`Internal linker error: symbol '${name}' not found in scope`);
        return;
      }
      if (!isDefinition(it) && !isImportFunction(it)) {
        if (compilerOptions.allowUndefined && it instanceof AST.DFunc) {
          it.storageClass = Types.StorageClass.IMPORT;
        } else {
          addError(`Undefined symbol '${name}' during linking`, [decl.loc || it.loc]);
          return;
        }
      }
      setDefinition(decl, it);
    });
  }

  // Collect all definitions and link static symbols
  for (const unit of units) {
    const tuScope = new Map();
    collectSymbols(unit, tuScope, false);  // extern
    collectSymbols(unit, tuScope, true);   // static
    linkSymbols(tuScope, unit, true);      // link static
  }

  // Link extern symbols
  for (const unit of units) {
    linkSymbols(externScope, unit, false);
  }

  return { errors };
}


// ====================
// Init list normalization helpers
// ====================

// Get VAR members of a tag, filtering out unnamed bitfields
function getVarMembers(tag) {
  const result = [];
  for (const m of tag.members) {
    if (!(m instanceof AST.DVar)) continue;
    if (m.bitWidth >= 0 && !m.name) continue; // skip unnamed bitfields
    result.push(m);
  }
  return result;
}

// Recursively search for a named member in a tag, descending into
// anonymous struct/union members. Returns array of DVar* path, or null.
function findMemberChain(tag, name) {
  for (const m of tag.members) {
    if (!(m instanceof AST.DVar)) continue;
    if (m.name === name) return [m];
    // Recurse into anonymous struct/union members
    if (!m.name && m.type.isTag() && m.type.tagDecl) {
      const sub = findMemberChain(m.type.tagDecl, name);
      if (sub) return [m, ...sub];
    }
  }
  return null;
}

// Normalize an init list: resolve designators, brace elision, zero-fill.
// Returns the (possibly new) init list — for unsized arrays the type
// changes to the inferred size, so a fresh EInitList is built at the
// end. Otherwise returns the original (mutated in place: elements and
// designators arrays are rewritten through the existing references —
// safe because Object.freeze on EInitList is shallow).
function normalizeInitList(initList, containerType) {
  // Snapshot source, then clear in place. Mutating array lengths/
  // contents rather than reassigning the references keeps
  // initList.children aliasing initList.elements for walkers. Frozen
  // EInitList allows array-content mutation since freeze is shallow.
  const src = initList.elements.slice();
  const desigs = initList.designators.slice();
  initList.elements.length = 0;
  initList.designators.length = 0;
  // Effective type: starts as containerType; may be refined for unsized
  // arrays once we know the actual extent. Tracked locally rather than
  // mutated on initList so we can build a fresh EInitList at the end.
  let effectiveType = containerType;

  // Child count for an aggregate type
  function childCount(t) {
    if (t.isArray()) {
      const sz = t.arraySize || 0;
      return sz === 0 ? 0x7FFFFFFF : sz;
    }
    if (t.isTag() && t.tagDecl) {
      if (t.tagDecl.tagKind === Types.TagKind.UNION) return 1;
      // STRUCT: count VAR members
      return getVarMembers(t.tagDecl).length;
    }
    return 0;
  }

  // Type of the i-th child of an aggregate
  function childType(t, index, output) {
    if (t.isArray()) return t.baseType;
    if (t.isTag() && t.tagDecl) {
      if (t.tagDecl.tagKind === Types.TagKind.UNION) {
        const members = getVarMembers(t.tagDecl);
        const umi = output.unionMemberIndex;
        if (umi >= 0 && umi < members.length) return members[umi].type;
        return members.length > 0 ? members[0].type : Types.TINT;
      }
      // STRUCT
      const members = getVarMembers(t.tagDecl);
      if (index >= 0 && index < members.length) return members[index].type;
    }
    return Types.TINT;
  }

  // Create a zero expression for a given type
  function makeZero(t) {
    const loc = Lexer.Loc.generated();
    if (t.isFloatingPoint()) return new AST.EFloat(loc, t, 0.0);
    return new AST.EInt(loc, Types.TINT, 0n);
  }

  // Ensure output has a slot at index
  function ensureSlot(list, index) {
    while (list.elements.length <= index) list.elements.push(null);
  }

  // Ensure output[index] is a sub-EInitList for an aggregate child
  function ensureSubList(list, index, subType) {
    ensureSlot(list, index);
    if (!list.elements[index] || !(list.elements[index] instanceof AST.EInitList)) {
      const cc = childCount(subType);
      const elems = [];
      if (cc !== 0x7FFFFFFF && cc > 0) {
        for (let i = 0; i < cc; i++) elems.push(null);
      }
      list.elements[index] = new AST.EInitList(Lexer.Loc.generated(), subType, elems);
    }
    return list.elements[index];
  }

  // Cursor: stack of levels tracking position in the type tree
  const stack = [];

  // Advance cursor to next position after placing an element
  function advanceCursor() {
    while (stack.length > 0) {
      stack[stack.length - 1].index++;
      if (stack[stack.length - 1].index < stack[stack.length - 1].count) return;
      stack.pop();
    }
  }

  // Descend into current slot (for brace elision)
  function descend() {
    const top = stack[stack.length - 1];
    const slotType = childType(top.type, top.index, top.output);
    const sub = ensureSubList(top.output, top.index, slotType);
    const cc = childCount(slotType);
    stack.push({ type: slotType, index: 0, count: cc, output: sub });
  }

  // Initialize root level — `length = 0` was already done above; pad with nulls.
  const rootCount = childCount(containerType);
  if (rootCount !== 0x7FFFFFFF && rootCount > 0) {
    for (let i = 0; i < rootCount; i++) initList.elements.push(null);
  }
  stack.push({ type: containerType, index: 0, count: rootCount, output: initList });

  // Track max extent for unsized arrays
  let maxExtent = 0;

  let srcIdx = 0;
  while (srcIdx < src.length) {
    // 1. Handle designator — reset cursor to root and navigate
    const hasDesig = srcIdx < desigs.length && desigs[srcIdx].steps.length > 0;
    if (!hasDesig && stack.length === 0) break;
    if (hasDesig) {
      const steps = desigs[srcIdx].steps;

      // Reset to root
      stack.length = 0;
      stack.push({ type: containerType, index: 0, count: rootCount, output: initList });

      for (let si = 0; si < steps.length; si++) {
        const step = steps[si];
        const top = stack[stack.length - 1];

        if (step.kind === "FIELD") {
          // Resolve field name
          if (!top.type.isTag() || !top.type.tagDecl) break;
          const tag = top.type.tagDecl;

          if (tag.tagKind === Types.TagKind.UNION) {
            const members = getVarMembers(tag);
            for (let j = 0; j < members.length; j++) {
              if (members[j].name === step.fieldName) {
                top.output.unionMemberIndex = j;
                top.index = 0;
                break;
              }
            }
          } else {
            // Struct: use findMemberChain for anonymous member support
            const chain = findMemberChain(tag, step.fieldName);
            if (chain) {
              for (let ci = 0; ci < chain.length; ci++) {
                const member = chain[ci];
                let currentTag = stack[stack.length - 1].type.tagDecl;
                const members = getVarMembers(currentTag);
                for (let j = 0; j < members.length; j++) {
                  if (members[j] === member) {
                    if (currentTag.tagKind === Types.TagKind.UNION) {
                      stack[stack.length - 1].output.unionMemberIndex = j;
                      stack[stack.length - 1].index = 0;
                    } else {
                      stack[stack.length - 1].index = j;
                    }
                    break;
                  }
                }
                // If not the final member in chain, descend into anonymous aggregate
                if (ci < chain.length - 1) {
                  descend();
                }
              }
            }
          }
        } else {
          // INDEX designator
          if (!top.type.isArray()) break;
          const val = constEvalInt(step.indexExpr);
          if (val !== null) {
            top.index = Number(val);
            ensureSlot(top.output, top.index);
          }
        }

        // If not the last step, descend into the current slot
        if (si + 1 < steps.length) {
          descend();
        }
      }
    }

    if (stack.length === 0) break;

    // 2. Place element — descend through aggregates for brace elision
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      ensureSlot(top.output, top.index);
      const slotType = childType(top.type, top.index, top.output);

      if (src[srcIdx] instanceof AST.EInitList) {
        // Braced sub-init-list: place and recurse
        top.output.elements[top.index] = src[srcIdx];
        top.output.elements[top.index] = normalizeInitList(top.output.elements[top.index], slotType);
        srcIdx++;
        if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
        advanceCursor();
        break;
      } else if (src[srcIdx] instanceof AST.EString && slotType.isArray()) {
        // String literal for char array
        top.output.elements[top.index] = src[srcIdx];
        srcIdx++;
        if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
        advanceCursor();
        break;
      } else if (slotType.isAggregate() &&
                 src[srcIdx].type && src[srcIdx].type.removeQualifiers().isCompatibleWith(slotType.removeQualifiers())) {
        // Aggregate expression matching slot type: place directly
        top.output.elements[top.index] = src[srcIdx];
        srcIdx++;
        if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
        advanceCursor();
        break;
      } else if (slotType.isAggregate()) {
        // Brace elision: descend into aggregate without consuming srcIdx
        descend();
        continue;
      } else {
        // Scalar at scalar slot
        top.output.elements[top.index] = src[srcIdx];
        srcIdx++;
        if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
        advanceCursor();
        break;
      }
    }
  }

  // For unsized arrays, finalize type based on actual extent.
  if (containerType.isArray() && (containerType.arraySize || 0) === 0) {
    const finalSize = Math.max(maxExtent, initList.elements.length);
    const elemType = containerType.baseType;
    effectiveType = Types.arrayOf(elemType, finalSize);
    while (initList.elements.length < finalSize) initList.elements.push(null);
  }

  // fillZeros: recursively replace null elements with zero values
  function fillZeros(list, type) {
    if (type.isArray()) {
      const elemType = type.baseType;
      const sz = type.arraySize || 0;
      while (list.elements.length < sz) list.elements.push(null);
      for (let i = 0; i < sz; i++) {
        if (list.elements[i] === null) {
          if (elemType.isAggregate()) {
            const sub = new AST.EInitList(Lexer.Loc.generated(), elemType, []);
            list.elements[i] = sub;
            fillZeros(sub, elemType);
          } else {
            list.elements[i] = makeZero(elemType);
          }
        } else if (list.elements[i] instanceof AST.EInitList) {
          fillZeros(list.elements[i], elemType);
        }
      }
    } else if (type.isTag() && type.tagDecl) {
      const tag = type.tagDecl;
      if (tag.tagKind === Types.TagKind.STRUCT) {
        const members = getVarMembers(tag);
        const mc = members.length;
        while (list.elements.length < mc) list.elements.push(null);
        for (let i = 0; i < mc; i++) {
          const mt = members[i].type;
          if (list.elements[i] === null) {
            if (mt.isAggregate()) {
              const sub = new AST.EInitList(Lexer.Loc.generated(), mt, []);
              list.elements[i] = sub;
              fillZeros(sub, mt);
            } else {
              list.elements[i] = makeZero(mt);
            }
          } else if (list.elements[i] instanceof AST.EInitList) {
            fillZeros(list.elements[i], mt);
          }
        }
      } else if (tag.tagKind === Types.TagKind.UNION) {
        // Union: ensure single element exists
        if (list.elements.length === 0 || list.elements[0] === null) {
          if (list.elements.length === 0) list.elements.push(null);
          const members = getVarMembers(tag);
          const umi = list.unionMemberIndex >= 0 ? list.unionMemberIndex : 0;
          if (umi < members.length) {
            const mt = members[umi].type;
            if (mt.isAggregate()) {
              const sub = new AST.EInitList(Lexer.Loc.generated(), mt, []);
              list.elements[0] = sub;
              fillZeros(sub, mt);
            } else {
              list.elements[0] = makeZero(mt);
            }
          }
        } else if (list.elements[0] instanceof AST.EInitList) {
          const members = getVarMembers(tag);
          const umi = list.unionMemberIndex;
          if (umi >= 0 && umi < members.length) {
            fillZeros(list.elements[0], members[umi].type);
          }
        }
      }
    }
  }
  fillZeros(initList, effectiveType);
  // If the type was refined (unsized → sized array), build a new
  // EInitList sharing the now-mutated elements/designators arrays.
  if (effectiveType !== initList.type) {
    return new AST.EInitList(initList.loc, effectiveType,
      initList.elements, initList.designators, initList.unionMemberIndex);
  }
  return initList;
}

// ====================
// Parser — Main Parser Class
// ====================

class Parser {
  constructor(tokens, errors, warnings) {
    this.tokens = tokens;
    this.errors = errors;
    this.warnings = warnings;
    this.pos = 0;
    this.typeScope = new AST.Scope();
    this.tagScope = new AST.Scope();
    this.varScope = new AST.Scope();
    this.anonCounter = 0;
    this.tagTypeCache = new Map();
    this.gcStructTypeCache = new Map();
    this.currentParsingFunc = null;
    this.currentCompound = null;
    this.requiredSources = new Set();
    this.exportDirectives = [];
    this.parsedExceptionTags = [];
    this.parsedLabels = new Map();
    this.pendingGotos = new Map();
    this.warningFlags = { pointerDecay: false, circularDependency: false };
  }

  // --- Lexer.Token helpers ---
  atEnd() { return this.pos >= this.tokens.length || this.tokens[this.pos].kind === Lexer.TokenKind.EOS; }
  peek(offset) {
    const i = this.pos + (offset || 0);
    if (i < 0 || i >= this.tokens.length) return this.tokens[this.tokens.length - 1];
    return this.tokens[i];
  }
  advance() {
    if (!this.atEnd()) this.pos++;
    return this.tokens[this.pos - 1];
  }
  atKind(kind) { return !this.atEnd() && this.peek().kind === kind; }
  atText(text) { return !this.atEnd() && this.peek().text === text; }
  atKW(kw) { return !this.atEnd() && this.peek().kind === Lexer.TokenKind.KEYWORD && this.peek().keyword === kw; }
  matchText(text) { if (this.atText(text)) { this.advance(); return true; } return false; }
  matchKW(kw) { if (this.atKW(kw)) { this.advance(); return true; } return false; }
  matchKind(kind) { if (this.atKind(kind)) { this.advance(); return true; } return false; }
  expect(text, msg) {
    if (this.atText(text)) return this.advance();
    this.error(this.peek(), msg || `Expected '${text}'`);
  }
  expectKW(kw, msg) {
    if (this.atKW(kw)) return this.advance();
    this.error(this.peek(), msg || `Expected '${kw}'`);
  }
  expectKind(kind, msg) {
    if (this.atKind(kind)) return this.advance();
    this.error(this.peek(), msg || `Expected ${kind}`);
  }
  // Token-flavored shorthands that delegate to the module-level diag pool.
  // New code should prefer reportError / reportWarning / fatalError on a
  // Loc directly; these stay because the parser has many existing callers.
  error(tok, msg) { fatalError(Lexer.Loc.fromTok(tok), msg); }
  recoverableError(tok, msg) { reportError(Lexer.Loc.fromTok(tok), msg); }
  warning(tok, msg) { reportWarning(Lexer.Loc.fromTok(tok), msg); }

  // --- isTypeName ---
  isTypeName() {
    const t = this.peek();
    if (t.kind === Lexer.TokenKind.KEYWORD) {
      switch (t.keyword) {
        case Lexer.Keyword.VOID: case Lexer.Keyword.BOOL: case Lexer.Keyword.CHAR:
        case Lexer.Keyword.SHORT: case Lexer.Keyword.INT: case Lexer.Keyword.LONG:
        case Lexer.Keyword.FLOAT: case Lexer.Keyword.DOUBLE:
        case Lexer.Keyword.SIGNED: case Lexer.Keyword.UNSIGNED:
        case Lexer.Keyword.STRUCT: case Lexer.Keyword.UNION: case Lexer.Keyword.ENUM:
        case Lexer.Keyword.CONST: case Lexer.Keyword.VOLATILE: case Lexer.Keyword.RESTRICT:
        case Lexer.Keyword.TYPEDEF: case Lexer.Keyword.STATIC: case Lexer.Keyword.EXTERN:
        case Lexer.Keyword.REGISTER: case Lexer.Keyword.AUTO:
        case Lexer.Keyword.INLINE: case Lexer.Keyword.NORETURN:
        case Lexer.Keyword.ALIGNAS: case Lexer.Keyword.THREAD_LOCAL:
        case Lexer.Keyword.TYPEOF: case Lexer.Keyword.TYPEOF_UNQUAL:
        case Lexer.Keyword.X_IMPORT:
        case Lexer.Keyword.X_EXTERNREF:
        case Lexer.Keyword.X_REFEXTERN:
        case Lexer.Keyword.X_EQREF:
        case Lexer.Keyword.X_STRUCT_GC:
        case Lexer.Keyword.X_ARRAY_GC:
          return true;
      }
    }
    if (t.kind === Lexer.TokenKind.IDENT) {
      const typeLevel = this.typeScope.getLevel(t.text);
      if (typeLevel !== -1) {
        const varLevel = this.varScope.getLevel(t.text);
        return typeLevel >= varLevel;
      }
    }
    return false;
  }

  // --- GCC __attribute__((...)) parsing ---
  skipBalancedParens() {
    let depth = 1;
    while (depth > 0 && !this.atEnd()) {
      if (this.matchText("(")) depth++;
      else if (this.matchText(")")) depth--;
      else this.advance();
    }
  }

  parseSingleAttribute(attrs) {
    if (this.atText(")") || this.atText(",")) return;
    const nameTok = this.advance();
    let name = nameTok.text;
    // Normalize __foo__ -> foo
    if (name.length > 4 && name.startsWith("__") && name.endsWith("__")) {
      name = name.slice(2, -2);
    }

    // --- Attributes with dedicated handling ---
    if (name === "packed") {
      attrs.packed = true;
      if (this.matchText("(")) this.skipBalancedParens();
      return;
    }
    if (name === "aligned") {
      if (this.matchText("(")) {
        if (this.atText(")")) {
          attrs.aligned = Math.max(attrs.aligned, 8);
        } else {
          const alignExpr = this.parseAssignmentExpression();
          const v = this._constEvalInt(alignExpr);
          if (v !== null) attrs.aligned = Math.max(attrs.aligned, Number(v));
        }
        this.expect(")");
      } else {
        attrs.aligned = Math.max(attrs.aligned, 8);
      }
      return;
    }

    // --- No-arg attributes stored in flags ---
    const noArgAttrs = new Set([
      "noinline", "noipa", "always_inline", "noclone", "noreturn", "cold", "hot",
      "unused", "used",
      "const", "pure", "nothrow", "malloc",
      "no_instrument_function", "externally_visible", "may_alias",
      "flatten", "leaf",
      "returns_twice", "warn_unused_result", "deprecated", "visibility",
    ]);
    if (noArgAttrs.has(name)) {
      attrs.flags.add(name);
      if (this.matchText("(")) this.skipBalancedParens();
      return;
    }

    // --- Attributes with args that are safe to parse and store ---
    const argAttrs = new Set([
      "format", "nonnull", "optimize", "section", "sentinel",
      "alloc_size", "assume_aligned", "target",
    ]);
    if (argAttrs.has(name)) {
      attrs.flags.add(name);
      if (this.matchText("(")) this.skipBalancedParens();
      return;
    }

    // --- Attributes that change semantics — error ---
    if (name === "vector_size" || name === "mode" || name === "scalar_storage_order" ||
        name === "constructor" || name === "destructor" || name === "alias" ||
        name === "ifunc" || name === "weak") {
      if (this.matchText("(")) this.skipBalancedParens();
      this.error(nameTok, `__attribute__((${name})) is not supported`);
      return;
    }

    // --- Unknown attribute — error ---
    if (this.matchText("(")) this.skipBalancedParens();
    this.error(nameTok, `unknown __attribute__((${name}))`);
  }

  parseGCCAttributes() {
    const attrs = { packed: false, aligned: 0, flags: new Set() };
    while (this.atKW(Lexer.Keyword.X_ATTRIBUTE)) {
      this.advance();
      this.expect("(");
      this.expect("(");
      while (!this.atText(")") && !this.atEnd()) {
        this.parseSingleAttribute(attrs);
        if (!this.matchText(",")) break;
      }
      this.expect(")");
      this.expect(")");
    }
    return attrs;
  }

  // --- parseDeclSpecifiers ---
  parseDeclSpecifiers() {
    let type = null;
    let storageClass = Types.StorageClass.NONE;
    let isInline = false;
    let requestedAlignment = 0;
    let importModule = null, importName = null;
    let isConst = false, isVolatile = false;
    let isSigned = false, isUnsigned = false;
    let longCount = 0, shortCount = 0;
    let hasChar = false, hasInt = false, hasFloat = false, hasDouble = false;
    let hasVoid = false, hasBool = false;
    let sawAuto = false;

    while (!this.atEnd()) {
      const t = this.peek();

      // Storage class specifiers
      if (this.matchKW(Lexer.Keyword.TYPEDEF)) { storageClass = Types.StorageClass.TYPEDEF; continue; }
      if (this.matchKW(Lexer.Keyword.STATIC)) { storageClass = Types.StorageClass.STATIC; continue; }
      if (this.matchKW(Lexer.Keyword.EXTERN)) { storageClass = Types.StorageClass.EXTERN; continue; }
      if (this.matchKW(Lexer.Keyword.REGISTER)) { storageClass = Types.StorageClass.REGISTER; continue; }
      if (this.matchKW(Lexer.Keyword.AUTO)) {
        // C23: `auto` is a storage-class specifier (legacy meaning) that may
        // additionally trigger type inference when no other type spec is
        // given. Per spec strict reading (matching clang), it's mutually
        // exclusive with other storage-class specifiers — `static auto x`
        // is invalid. For `static`-with-inference, write `static int x` etc.
        if (storageClass !== Types.StorageClass.NONE) {
          this.error(this.peek(-1),
            `'auto' cannot be combined with another storage-class specifier`);
        }
        storageClass = Types.StorageClass.AUTO;
        sawAuto = true;
        continue;
      }
      if (this.matchKW(Lexer.Keyword.X_IMPORT)) {
        storageClass = Types.StorageClass.IMPORT;
        if (this.atText("(")) {
          this.advance();
          const first = this.expectKind(Lexer.TokenKind.STRING);
          if (this.matchText(",")) {
            const second = this.expectKind(Lexer.TokenKind.STRING);
            importModule = first.text.replace(/^"(.*)"$/, '$1');
            importName = second.text.replace(/^"(.*)"$/, '$1');
          } else {
            importModule = first.text.replace(/^"(.*)"$/, '$1');
          }
          this.expect(")");
        }
        continue;
      }

      // Qualifiers
      if (this.matchKW(Lexer.Keyword.CONST)) { isConst = true; continue; }
      if (this.matchKW(Lexer.Keyword.VOLATILE)) { isVolatile = true; continue; }
      if (this.matchKW(Lexer.Keyword.RESTRICT)) { continue; } // ignore restrict

      // Function specifiers
      if (this.matchKW(Lexer.Keyword.INLINE)) { isInline = true; continue; }
      if (this.matchKW(Lexer.Keyword.NORETURN)) { continue; }
      if (this.matchKW(Lexer.Keyword.THREAD_LOCAL)) { continue; }
      if (this.atKW(Lexer.Keyword.X_ATTRIBUTE)) {
        const attrs = this.parseGCCAttributes();
        if (attrs.aligned > requestedAlignment) requestedAlignment = attrs.aligned;
        continue;
      }

      // _Alignas
      if (this.matchKW(Lexer.Keyword.ALIGNAS)) {
        const alignTok = this.peek(-1);
        this.expect("(");
        let alignVal;
        if (this.isTypeName()) {
          const alignType = this.parseDeclSpecifiers().type;
          alignVal = alignType.align;
        } else {
          const alignExpr = this.parseAssignmentExpression();
          alignVal = Number(constEvalInt(alignExpr) ?? 0n);
        }
        this.expect(")");
        if (alignVal < 0 || (alignVal & (alignVal - 1)) !== 0) {
          this.error(alignTok, "_Alignas value must be a positive power of 2");
        }
        // C11 6.2.8: extended alignments (> max_align_t = 8 on wasm32) are
        // implementation-defined. We don't support them.
        if (alignVal > 8) {
          this.error(alignTok, `_Alignas(${alignVal}) exceeds maximum supported alignment of 8`);
        }
        if (alignVal > requestedAlignment) requestedAlignment = alignVal;
        continue;
      }

      // _Static_assert
      if (this.matchKW(Lexer.Keyword.STATIC_ASSERT)) {
        this.expect("(");
        const condExpr = this.parseAssignmentExpression();
        let msg = "";
        if (this.matchText(",")) {
          const msgTok = this.expectKind(Lexer.TokenKind.STRING);
          msg = msgTok.text.replace(/^"(.*)"$/, '$1');
        }
        this.expect(")");
        this.expect(";");
        const val = constEvalInt(condExpr);
        if (val === 0n) this.recoverableError(this.peek(-1) || this.peek(), `_Static_assert failed: ${msg}`);
        continue;
      }

      // Type specifiers
      if (this.matchKW(Lexer.Keyword.VOID)) { hasVoid = true; continue; }
      if (this.matchKW(Lexer.Keyword.BOOL)) { hasBool = true; continue; }
      if (this.matchKW(Lexer.Keyword.CHAR)) { hasChar = true; continue; }
      if (this.matchKW(Lexer.Keyword.SHORT)) { shortCount++; continue; }
      if (this.matchKW(Lexer.Keyword.INT)) { hasInt = true; continue; }
      if (this.matchKW(Lexer.Keyword.LONG)) { longCount++; continue; }
      if (this.matchKW(Lexer.Keyword.FLOAT)) { hasFloat = true; continue; }
      if (this.matchKW(Lexer.Keyword.DOUBLE)) { hasDouble = true; continue; }
      if (this.matchKW(Lexer.Keyword.SIGNED)) { isSigned = true; continue; }
      if (this.matchKW(Lexer.Keyword.UNSIGNED)) { isUnsigned = true; continue; }
      if (this.matchKW(Lexer.Keyword.X_EXTERNREF)) { type = Types.TEXTERNREF; continue; }
      if (this.matchKW(Lexer.Keyword.X_REFEXTERN)) { type = Types.TREFEXTERN; continue; }
      if (this.matchKW(Lexer.Keyword.X_EQREF)) { type = Types.TEQREF; continue; }

      // GC struct/array (WASM GC extension)
      if (this.atKW(Lexer.Keyword.X_STRUCT_GC)) {
        type = this.parseGCStructSpecifier();
        continue;
      }
      if (this.atKW(Lexer.Keyword.X_ARRAY_GC)) {
        type = this.parseGCArraySpecifier();
        continue;
      }

      // typeof / typeof_unqual / __typeof__ (C23 + GCC). Acts as a type
      // specifier — yields the type of an expression (without lvalue/decay
      // conversion) or a type name. typeof_unqual additionally strips
      // const/volatile from the result.
      if (this.atKW(Lexer.Keyword.TYPEOF) || this.atKW(Lexer.Keyword.TYPEOF_UNQUAL)) {
        const isUnqual = this.atKW(Lexer.Keyword.TYPEOF_UNQUAL);
        const tok = this.peek();
        this.advance();
        this.expect("(");
        let resolved;
        if (this.isTypeName()) {
          const specs = this.parseDeclSpecifiers();
          resolved = specs.type;
          if (this.atText("*") || this.atText("[") || this.atText("(")) {
            const decl = this.parseDeclarator(resolved);
            resolved = decl.type;
          }
        } else {
          const expr = this.parseExpression();
          resolved = expr.type;
        }
        this.expect(")");
        if (isUnqual) resolved = resolved.removeQualifiers();
        type = resolved;
        continue;
      }

      // struct/union/enum
      if (this.atKW(Lexer.Keyword.STRUCT) || this.atKW(Lexer.Keyword.UNION)) {
        type = this.parseTagSpecifier();
        continue;
      }
      if (this.atKW(Lexer.Keyword.ENUM)) {
        type = this.parseEnumSpecifier();
        continue;
      }

      // typedef name — only if no base type specifiers already seen
      const hasBase = hasVoid || hasBool || hasChar || hasInt || hasFloat || hasDouble ||
          shortCount > 0 || longCount > 0 || isSigned || isUnsigned;
      if (t.kind === Lexer.TokenKind.IDENT && this.typeScope.has(t.text) && type === null && !hasBase) {
        this.advance();
        type = this.typeScope.get(t.text);
        continue;
      }

      // __attribute__ can appear after base type too
      if (this.atKW(Lexer.Keyword.X_ATTRIBUTE)) {
        const attrs = this.parseGCCAttributes();
        if (attrs.aligned > requestedAlignment) requestedAlignment = attrs.aligned;
        continue;
      }

      break; // not a decl specifier
    }

    // Resolve type from accumulated specifiers
    if (type === null) {
      const hasBase = hasVoid || hasBool || hasChar || hasInt || hasFloat || hasDouble ||
          shortCount > 0 || longCount > 0 || isSigned || isUnsigned;
      // C23: bare `auto` (no other type spec) means type-inference. The actual
      // type is filled in by the declarator/init handler.
      if (sawAuto && !hasBase) {
        type = Types.TAUTO;
        // `auto` here was consumed as a storage class above; for the inference
        // role it should be treated as 'auto storage' (the legacy meaning),
        // which is the default for locals — leave storageClass as AUTO so it
        // still resolves naturally.
      } else if (hasVoid) type = Types.TVOID;
      else if (hasBool) type = Types.TBOOL;
      else if (hasChar) type = isSigned ? Types.TSCHAR : (isUnsigned ? Types.TUCHAR : Types.TCHAR);
      else if (shortCount > 0) type = isUnsigned ? Types.TUSHORT : Types.TSHORT;
      else if (hasFloat) type = Types.TFLOAT;
      else if (hasDouble) type = longCount > 0 ? Types.TLDOUBLE : Types.TDOUBLE;
      else if (longCount >= 2) type = isUnsigned ? Types.TULLONG : Types.TLLONG;
      else if (longCount === 1) type = isUnsigned ? Types.TULONG : Types.TLONG;
      else if (isUnsigned) type = Types.TUINT;
      else {
        if (!hasBase && !this._allowImplicitInt) {
          this.error(this.peek(), "type specifier missing (implicit int is not allowed in C99)");
        }
        type = Types.TINT;
      }
    }

    // In C, enum types are compatible with int. Erase enum types to int
    // early so codegen never needs to handle them as a special case.
    if (type.isEnum()) type = Types.TINT;

    if (isConst) type = type.addConst();
    if (isVolatile) type = type.addVolatile();

    return { type, storageClass, isInline, requestedAlignment, importModule, importName };
  }

  // --- Tag specifier (struct/union) ---
  parseTagSpecifier() {
    let tagKind;
    if (this.matchKW(Lexer.Keyword.STRUCT)) tagKind = Types.TagKind.STRUCT;
    else { this.advance(); tagKind = Types.TagKind.UNION; }

    // Parse optional __attribute__ after struct/union keyword
    const tagAttrs = this.parseGCCAttributes();

    let name = null;

    if (this.atKind(Lexer.TokenKind.IDENT)) {
      name = this.advance().text;
    }

    if (this.matchText("{")) {
      // Tag body definition
      if (!name) name = "__anon_" + this.anonCounter++;
      const tagType = Types.getOrCreateTagType(this.tagTypeCache, tagKind, name);
      const members = [];

      // Create tag decl
      const tagDecl = new AST.DTag({ filename: this.peek().filename, line: this.peek().line },
        tagKind, name, true, members);

      // Parse members
      while (!this.atEnd() && !this.atText("}")) {
        if (this.matchText(";")) continue;
        // C11 6.7.2.1p1: _Static_assert is allowed as a struct-declaration
        if (this.matchKW(Lexer.Keyword.STATIC_ASSERT)) {
          this.expect("(");
          const condExpr = this.parseAssignmentExpression();
          let msg = "";
          if (this.matchText(",")) {
            const msgTok = this.expectKind(Lexer.TokenKind.STRING);
            msg = msgTok.text.replace(/^"(.*)"$/, '$1');
          }
          this.expect(")");
          this.expect(";");
          const val = constEvalInt(condExpr);
          if (val === 0) this.recoverableError(this.peek(-1) || this.peek(), `_Static_assert failed: ${msg}`);
          continue;
        }
        const memSpecs = this.parseDeclSpecifiers();
        let memType = memSpecs.type;

        if (this.atText(";")) {
          // Anonymous struct/union member — create unnamed DVar
          if (memType.isTag()) {
            const mVar = new AST.DVar({ filename: this.peek().filename, line: this.peek().line },
              null, memType, Types.StorageClass.NONE, null);
            members.push(mVar);
          }
          this.advance();
          continue;
        }

        // Parse member declarators
        let first = true;
        while (!this.atEnd()) {
          if (!first) { if (!this.matchText(",")) break; }
          first = false;

          // Bitfield without declarator (anonymous bitfield)
          if (this.atText(":")) {
            this.advance();
            const widthExpr = this.parseAssignmentExpression();
            const bitW = Number(constEvalInt(widthExpr) ?? 0n);
            const mVar = new AST.DVar({ filename: this.peek().filename, line: this.peek().line },
              null, memType, Types.StorageClass.NONE, null);
            mVar.bitWidth = bitW;
            members.push(mVar);
            break; // anonymous bit-fields end the declarator list
          }

          const { type: mType, name: mName } = this.parseDeclarator(memType);
          if (mType.removeQualifiers().isRef()) {
            this.error(this.peek(), `${mType.removeQualifiers().toString()} cannot be used as a struct/union member`);
          }
          Types.validateNoHeapInValueType(mType, msg => this.error(this.peek(), msg));

          // Parse __attribute__ after member declarator
          const memAttrs = this.parseGCCAttributes();
          if (memAttrs.aligned > 0 && memSpecs.requestedAlignment < memAttrs.aligned) {
            memSpecs.requestedAlignment = memAttrs.aligned;
          }

          // Check for bitfield
          let bitWidth = -1;
          if (this.matchText(":")) {
            const widthExpr = this.parseAssignmentExpression();
            bitWidth = Number(constEvalInt(widthExpr) ?? 0n);
            if (!mType.isInteger || !mType.isInteger()) {
              this.error(this.peek(-1), "Bit-field must have integer type");
            } else if (mType.size > 8) {
              this.error(this.peek(-1), "Bit-field storage type must be at most 8 bytes");
            }
            if (bitWidth > mType.size * 8) {
              this.error(this.peek(-1), `Bit-field width ${bitWidth} exceeds storage type's ${mType.size * 8} bits`);
            }
          }

          const mVar = new AST.DVar({ filename: this.peek().filename, line: this.peek().line },
            mName, mType, Types.StorageClass.NONE, null);
          mVar.bitWidth = bitWidth;
          if (memSpecs.requestedAlignment > 0) {
            if (bitWidth >= 0) {
              this.error(this.peek(), "_Alignas cannot be applied to a bit-field");
            }
            if (memSpecs.requestedAlignment < (mType.align || 1)) {
              this.error(this.peek(), `_Alignas cannot reduce alignment below natural alignment of type '${mType.toString()}'`);
            }
            mVar.requestedAlignment = memSpecs.requestedAlignment;
          }
          members.push(mVar);
        }
        this.expect(";");
      }
      this.expect("}");

      // Parse __attribute__ after closing }
      const postTagAttrs = this.parseGCCAttributes();
      if (tagAttrs.packed || postTagAttrs.packed) tagDecl.isPacked = true;

      // Compute layout
      if (tagKind === Types.TagKind.STRUCT) {
        const layout = Types.computeStructLayout(members, tagDecl.isPacked);
        tagType.size = layout.size;
        tagType.align = layout.align;
      } else if (tagKind === Types.TagKind.UNION) {
        const layout = Types.computeUnionLayout(members, tagDecl.isPacked);
        tagType.size = layout.size;
        tagType.align = layout.align;
      }
      tagType.isComplete = true;
      tagType.tagDecl = tagDecl;
      tagDecl.members = members;

      // Validate flexible array members (C99)
      {
        let foundFAM = false, famIdx = -1;
        const varMembers = members.filter(m => m instanceof AST.DVar);
        for (let i = 0; i < varMembers.length; i++) {
          const mv = varMembers[i];
          if (mv.type.isArray() && mv.type.arraySize === 0) {
            if (tagKind === Types.TagKind.UNION) {
              this.error(this.peek(), "flexible array member not allowed in a union");
            }
            if (foundFAM) {
              this.error(this.peek(), "only one flexible array member is allowed per struct");
            }
            foundFAM = true;
            famIdx = i;
          }
        }
        if (foundFAM && famIdx < varMembers.length - 1) {
          this.error(this.peek(), "flexible array member must be the last member of a struct");
        }
      }

      // Propagate updates to existing const/volatile variants
      const propagate = (variant) => {
        if (!variant) return;
        variant.size = tagType.size;
        variant.align = tagType.align;
        variant.isComplete = true;
        variant.tagDecl = tagDecl;
      };
      propagate(tagType._constVariant);
      propagate(tagType._volatileVariant);
      if (tagType._constVariant) propagate(tagType._constVariant._volatileVariant);
      if (tagType._volatileVariant) propagate(tagType._volatileVariant._constVariant);

      this.tagScope.set(name, tagType);

      return tagType;
    }

    // Forward declaration or reference
    if (!name) this.error(this.peek(), "Expected tag name or '{'");
    let tagType = this.tagScope.get(name);
    if (!tagType) {
      tagType = Types.getOrCreateTagType(this.tagTypeCache, tagKind, name);
      this.tagScope.set(name, tagType);
    }
    return tagType;
  }

  // --- GC struct specifier: __struct [Name] [{ member; member; ... }] ---
  parseGCStructSpecifier() {
    this.advance(); // consume '__struct'
    let name = null;
    if (this.atKind(Lexer.TokenKind.IDENT)) name = this.advance().text;

    if (this.matchText("{")) {
      // GC struct definition
      if (!name) name = "__anon_gc_" + this.anonCounter++;
      const gcType = Types.getOrCreateGCStructType(this.gcStructTypeCache, name);
      const members = [];
      const tagDecl = new AST.DTag({ filename: this.peek().filename, line: this.peek().line },
        Types.TagKind.GC_STRUCT, name, true, members);
      // Optional __extends(__struct Parent); — must be the very first body statement.
      let parentType = null;
      if (this.atKW(Lexer.Keyword.X_EXTENDS)) {
        const extTok = this.peek();
        this.advance();
        this.expect("(");
        if (!this.atKW(Lexer.Keyword.X_STRUCT_GC)) {
          this.error(extTok, "__extends(...) requires a __struct type");
        }
        parentType = this.parseGCStructSpecifier();
        // Heap form only — reject `__extends(__struct Foo *)`.
        if (this.atText("*")) {
          this.error(this.peek(), "__extends(...) takes a heap-type spelling — write '__extends(__struct Foo)' without '*'");
        }
        this.expect(")");
        this.expect(";");
        if (!parentType.isGCStructHeap() || !parentType.isComplete) {
          this.error(extTok, `__extends parent must be a complete __struct, got '${parentType.toString()}'`);
        }
      }
      while (!this.atEnd() && !this.atText("}")) {
        if (this.matchText(";")) continue;
        const memSpecs = this.parseDeclSpecifiers();
        let memBaseType = memSpecs.type;
        let firstM = true;
        while (!this.atEnd()) {
          if (!firstM) { if (!this.matchText(",")) break; }
          firstM = false;
          const { type: mType, name: mName } = this.parseDeclarator(memBaseType);
          if (!mName) this.error(this.peek(), "GC struct members must be named");
          if (mType.isArray()) {
            this.error(this.peek(), "C arrays are not allowed as GC struct members; use __array(T) instead");
          }
          if (mType.isFunction()) {
            this.error(this.peek(), "function types are not allowed as GC struct members");
          }
          Types.validateNoHeapInValueType(mType, msg => this.error(this.peek(), msg));
          const mVar = new AST.DVar({ filename: this.peek().filename, line: this.peek().line },
            mName, mType, Types.StorageClass.NONE, null);
          members.push(mVar);
        }
        this.expect(";");
      }
      this.expect("}");
      // Validate prefix: child's first N fields must match parent's fields exactly
      // by name and type (WASM GC subtype rule — fields can't be reordered or
      // re-typed, only appended).
      if (parentType) {
        const parentMembers = parentType.tagDecl.members;
        if (members.length < parentMembers.length) {
          this.error(this.peek(-1),
            `__struct ${name} extends '${parentType.tagName}' but has only ${members.length} fields (parent has ${parentMembers.length})`);
        }
        for (let i = 0; i < parentMembers.length; i++) {
          const p = parentMembers[i], c = members[i];
          if (p.name !== c.name) {
            this.error(this.peek(-1),
              `__struct ${name}: field #${i} must be named '${p.name}' to match parent '${parentType.tagName}', got '${c.name}'`);
          }
          if (!p.type.isCompatibleWith(c.type)) {
            this.error(this.peek(-1),
              `__struct ${name}: field '${c.name}' must have type '${p.type.toString()}' to match parent '${parentType.tagName}', got '${c.type.toString()}'`);
          }
        }
      }
      // Assign field indices
      for (let i = 0; i < members.length; i++) members[i].byteOffset = i;
      gcType.tagDecl = tagDecl;
      gcType.isComplete = true;
      gcType.parentType = parentType;
      // The ref form (`__struct Foo *`), if previously created during a
      // forward reference, reads tagDecl/isComplete through getters that
      // delegate to the heap — no sync needed.
      this.tagScope.set(name, gcType);
      return gcType;
    }

    // Forward reference
    if (!name) this.error(this.peek(), "Expected GC struct name or '{'");
    let gcType = this.tagScope.get(name);
    if (!gcType || !gcType.isGCStructHeap()) {
      gcType = Types.getOrCreateGCStructType(this.gcStructTypeCache, name);
      this.tagScope.set(name, gcType);
    }
    return gcType;
  }

  // --- GC array specifier: __array(ElementType) ---
  parseGCArraySpecifier() {
    this.advance(); // consume '__array'
    this.expect("(");
    const elemSpecs = this.parseDeclSpecifiers();
    let elemType = elemSpecs.type;
    if (this.atText("*") || this.atText("[") || this.atText("(")) {
      const decl = this.parseDeclarator(elemType);
      elemType = decl.type;
    }
    this.expect(")");
    if (elemType.isArray()) {
      this.error(this.peek(), "C arrays are not allowed as __array element type");
    }
    if (elemType.isFunction()) {
      this.error(this.peek(), "function types are not allowed as __array element type");
    }
    return Types.gcArrayOf(elemType);
  }

  // --- Enum specifier ---
  parseEnumSpecifier() {
    this.advance(); // consume 'enum'
    let name = null;
    if (this.atKind(Lexer.TokenKind.IDENT) && !this.typeScope.has(this.peek().text)) {
      name = this.advance().text;
    }

    if (this.matchText("{")) {
      if (!name) name = "__anon_" + this.anonCounter++;
      const tagType = Types.getOrCreateTagType(this.tagTypeCache, Types.TagKind.ENUM, name);
      tagType.size = 4; tagType.align = 4; tagType.isComplete = true;
      const tagDecl = new AST.DTag({ filename: this.peek().filename, line: this.peek().line },
        Types.TagKind.ENUM, name, true, []);

      let nextVal = 0n;
      while (!this.atEnd() && !this.atText("}")) {
        const eName = this.expectKind(Lexer.TokenKind.IDENT).text;
        let val = nextVal;
        if (this.matchText("=")) {
          const valExpr = this.parseAssignmentExpression();
          val = constEvalInt(valExpr) ?? nextVal;
        }
        nextVal = val + 1n;
        const ec = new AST.DEnumConst({ filename: this.peek().filename, line: this.peek().line }, eName, val);
        tagDecl.members.push(ec);
        // Register enum constant in varScope
        this.varScope.set(eName, ec);
        if (!this.matchText(",")) break;
      }
      this.expect("}");
      tagType.tagDecl = tagDecl;
      this.tagScope.set(name, tagType);
      return tagType;
    }

    if (!name) this.error(this.peek(), "Expected enum name or '{'");
    let tagType = this.tagScope.get(name);
    if (!tagType) {
      tagType = Types.getOrCreateTagType(this.tagTypeCache, Types.TagKind.ENUM, name);
      this.tagScope.set(name, tagType);
    }
    return tagType;
  }

  // --- Declarator parsing ---

  isStartOfParamList() {
    // Look ahead to determine if ( starts a parameter list or a grouping paren
    // This is the ambiguity between function declarator and parenthesized declarator
    const saved = this.pos;
    this.advance(); // skip (

    // Empty parens or void = parameter list
    if (this.atText(")")) { this.pos = saved; return true; }
    if (this.isTypeName()) { this.pos = saved; return true; }
    if (this.atText("...")) { this.pos = saved; return true; }

    this.pos = saved;
    return false;
  }

  combineDeclaratorTypes(innerType, outerBase, outerResult, innerPtrCount) {
    // For parenthesized declarators: replace the base in inner with outerResult.
    // Handles things like: int (*fp)(void) where inner = *<base>, outer suffix = (void).
    // We need to replace the deepest base in inner with outerResult.
    //
    // Special case: GC ref types collapse `*` (so inner.type may equal
    // outerBase even when the user wrote `*`s). innerPtrCount tells us how
    // many were consumed at the top of the inner declarator — re-apply them
    // to outerResult so things like `__eqref (*fn)(int)` get the right
    // pointer-to-function-returning-eqref type rather than just function.
    if (innerType === outerBase) {
      let r = outerResult;
      if (innerPtrCount) {
        for (let i = 0; i < innerPtrCount; i++) r = r.pointer();
      }
      return r;
    }
    if (innerType.isPointer()) {
      const newBase = this.combineDeclaratorTypes(innerType.baseType, outerBase, outerResult);
      const result = newBase.pointer();
      if (innerType.isConst) return result.addConst();
      if (innerType.isVolatile) return result.addVolatile();
      return result;
    }
    if (innerType.isArray()) {
      const newBase = this.combineDeclaratorTypes(innerType.baseType, outerBase, outerResult);
      return Types.arrayOf(newBase, innerType.arraySize);
    }
    return innerType;
  }

  // --- Expression parsing ---

  parsePrimaryExpression() {
    const t = this.peek();

    // Integer literal (includes char literals converted by Lexer.postProcess)
    if (t.kind === Lexer.TokenKind.INT) {
      this.advance();
      let type = Types.TINT;
      const val = t.integer;  // keep as BigInt for full precision
      // Check for char literal prefixes (Lexer.postProcess converts CHAR -> INT)
      if (t.flags.stringPrefix === Lexer.StringPrefix.PREFIX_u) type = Types.TUSHORT;
      else if (t.flags.stringPrefix === Lexer.StringPrefix.PREFIX_U || t.flags.stringPrefix === Lexer.StringPrefix.PREFIX_L) type = Types.TINT;
      else {
        // C99 §6.4.4.1: Determine type from suffix, then promote based on value.
        if (t.flags.isUnsigned && t.flags.isLongLong) type = Types.TULLONG;
        else if (t.flags.isUnsigned && t.flags.isLong) type = Types.TULONG;
        else if (t.flags.isUnsigned) type = Types.TUINT;
        else if (t.flags.isLongLong) type = Types.TLLONG;
        else if (t.flags.isLong) type = Types.TLONG;

        const isDecimal = t.flags.isDecimal;
        const fitsI32 = val <= 0x7FFFFFFFn;
        const fitsU32 = val <= 0xFFFFFFFFn;
        const fitsI64 = val <= 0x7FFFFFFFFFFFFFFFn;

        if (!t.flags.isUnsigned && !t.flags.isLong && !t.flags.isLongLong) {
          if (fitsI32) type = Types.TINT;
          else if (!isDecimal && fitsU32) type = Types.TUINT;
          else if (fitsI64) type = Types.TLLONG;
          else type = isDecimal ? Types.TLLONG : Types.TULLONG;
        } else if (t.flags.isUnsigned && !t.flags.isLong && !t.flags.isLongLong) {
          if (fitsU32) type = Types.TUINT;
          else type = Types.TULLONG;
        } else if (!t.flags.isUnsigned && t.flags.isLong && !t.flags.isLongLong) {
          if (fitsI32) type = Types.TLONG;
          else if (!isDecimal && fitsU32) type = Types.TULONG;
          else if (fitsI64) type = Types.TLLONG;
          else type = isDecimal ? Types.TLLONG : Types.TULLONG;
        } else if (t.flags.isUnsigned && t.flags.isLong && !t.flags.isLongLong) {
          if (fitsU32) type = Types.TULONG;
          else type = Types.TULLONG;
        } else if (!t.flags.isUnsigned && t.flags.isLongLong) {
          if (fitsI64) type = Types.TLLONG;
          else type = isDecimal ? Types.TLLONG : Types.TULLONG;
        }
        // ULL: always Types.TULLONG, already set
      }
      return new AST.EInt(Lexer.Loc.fromTok(t), type, val);
    }

    // Float literal
    if (t.kind === Lexer.TokenKind.FLOAT) {
      this.advance();
      let type = Types.TDOUBLE;
      if (t.flags.isFloat) type = Types.TFLOAT;
      else if (t.flags.isLong) type = Types.TLDOUBLE;
      return new AST.EFloat(Lexer.Loc.fromTok(t), type, t.floating);
    }

    // Note: CHAR tokens are converted to INT by Lexer.postProcess, handled above

    // String literal (with concatenation)
    if (t.kind === Lexer.TokenKind.STRING) {
      return this.parseStringLiteral();
    }

    // Identifier
    if (t.kind === Lexer.TokenKind.IDENT) {
      this.advance();
      const name = t.text;
      const loc = Lexer.Loc.fromTok(t);
      // Check __func__ / __FUNCTION__
      if ((name === "__func__" || name === "__FUNCTION__") && this.currentParsingFunc) {
        const funcName = this.currentParsingFunc.name;
        const bytes = [];
        for (let i = 0; i < funcName.length; i++) bytes.push(funcName.charCodeAt(i));
        bytes.push(0);
        return new AST.EString(loc, Types.arrayOf(Types.TCHAR, bytes.length), bytes);
      }
      // Implicit function declaration: C89 allowed calling undeclared functions.
      // Gated behind --allow-implicit-function-decl / --allow-old-c. We
      // create the decl ourselves here so makeIdent's lookup succeeds.
      if (!this.varScope.get(name) && this._allowImplicitFunctionDecl && this.atText("(")) {
        const ftype = Types.functionType(Types.TINT, [], false);
        const fdecl = new AST.DFunc({ filename: t.filename, line: t.line }, name, ftype, [], Types.StorageClass.EXTERN, false, null);
        this.varScope.set(name, fdecl);
      }
      return AST.makeIdent(loc, name, this.varScope);
    }

    // Parenthesized expression or compound literal
    if (t.kind === Lexer.TokenKind.PUNCT && t.text === "(") {
      const startLoc = Lexer.Loc.fromTok(t);
      // Check if it's a compound literal: (type){...}
      const saved = this.pos;
      this.advance(); // skip (
      if (this.isTypeName()) {
        // Could be cast or compound literal
        const specs = this.parseDeclSpecifiers();
        let castType = specs.type;
        // Parse abstract declarator
        if (this.atText("*") || this.atText("[") || this.atText("(")) {
          const decl = this.parseDeclarator(castType);
          castType = decl.type;
        }
        this.expect(")");
        if (this.atText("{")) {
          // Compound literal
          let initList = this.parseInitList(castType);
          // Handle string-initialized char array (e.g., `(char[]){"hi"}`).
          if (castType.isArray() && castType.arraySize === 0 &&
              initList.elements.length === 1 && initList.elements[0] instanceof AST.EString) {
            castType = initList.elements[0].type;
            initList = new AST.EInitList(initList.loc, castType,
              initList.elements, initList.designators, initList.unionMemberIndex);
          } else if (castType.isArray() && castType.arraySize === 0) {
            initList = normalizeInitList(initList, castType);
            castType = initList.type;
          } else if (castType.isAggregate()) {
            initList = normalizeInitList(initList, castType);
          }
          return new AST.ECompoundLiteral(startLoc, castType, initList);
        }
        // Cast expression
        const expr = this.parseCastExpression();
        // GCC extension: cast-to-union — (union_type) expr → compound literal
        if (castType.isUnion()) {
          let initList = new AST.EInitList(startLoc, castType, [expr], []);
          initList = normalizeInitList(initList, castType);
          return new AST.ECompoundLiteral(startLoc, castType, initList);
        }
        return AST.makeCast(startLoc, castType, expr);
      }
      // Regular parenthesized expression
      this.pos = saved;
      this.advance();
      const expr = this.parseExpression();
      this.expect(")");
      return expr;
    }

    // sizeof
    if (this.atKW(Lexer.Keyword.SIZEOF)) {
      const sizeofLoc = Lexer.Loc.fromTok(t);
      this.advance();
      if (this.matchText("(")) {
        if (this.isTypeName()) {
          const specs = this.parseDeclSpecifiers();
          let sType = specs.type;
          if (this.atText("*") || this.atText("[") || this.atText("(")) {
            const decl = this.parseDeclarator(sType);
            sType = decl.type;
          }
          this.expect(")");
          if (sType.removeQualifiers().isRef()) this.error(this.peek(-1), `sizeof(${sType.removeQualifiers().toString()}) is not allowed`);
          return new AST.ESizeofType(sizeofLoc, Types.TULONG, sType);
        }
        const expr = this.parseExpression();
        this.expect(")");
        return new AST.ESizeofExpr(sizeofLoc, Types.TULONG, expr);
      }
      const expr = this.parseUnaryExpression();
      return new AST.ESizeofExpr(sizeofLoc, Types.TULONG, expr);
    }

    // _Alignof
    if (this.atKW(Lexer.Keyword.ALIGNOF)) {
      const alignofLoc = Lexer.Loc.fromTok(t);
      this.advance();
      this.expect("(");
      if (this.isTypeName()) {
        const specs = this.parseDeclSpecifiers();
        let aType = specs.type;
        if (this.atText("*") || this.atText("[") || this.atText("(")) {
          const decl = this.parseDeclarator(aType);
          aType = decl.type;
        }
        this.expect(")");
        if (aType.isFunction()) {
          this.error(this.peek(-1), "_Alignof cannot be applied to a function type");
        }
        if (!aType.isComplete) {
          this.error(this.peek(-1), "_Alignof cannot be applied to incomplete type '" + aType.toString() + "'");
        }
        return new AST.EAlignofType(alignofLoc, Types.TULONG, aType);
      }
      const expr = this.parseExpression();
      this.expect(")");
      return new AST.EAlignofExpr(alignofLoc, Types.TULONG, expr);
    }

    // __builtin_va_start/va_arg/va_end/va_copy
    if (this.atKW(Lexer.Keyword.X_BUILTIN_VA_START)) { return this.parseIntrinsic(Types.IntrinsicKind.VA_START); }
    if (this.atKW(Lexer.Keyword.X_BUILTIN_VA_ARG)) { return this.parseVaArg(); }
    if (this.atKW(Lexer.Keyword.X_BUILTIN_VA_END)) { return this.parseIntrinsic(Types.IntrinsicKind.VA_END); }
    if (this.atKW(Lexer.Keyword.X_BUILTIN_VA_COPY)) { return this.parseIntrinsic(Types.IntrinsicKind.VA_COPY); }
    if (this.atKW(Lexer.Keyword.X_BUILTIN_UNREACHABLE)) { return this.parseIntrinsic(Types.IntrinsicKind.UNREACHABLE); }
    if (this.atKW(Lexer.Keyword.X_BUILTIN_ABORT)) { return this.parseIntrinsic(Types.IntrinsicKind.UNREACHABLE); }
    if (this.matchKW(Lexer.Keyword.X_BUILTIN_EXPECT)) {
      this.expect("(");
      const first = this.parseAssignmentExpression();
      this.expect(",");
      this.parseAssignmentExpression(); // discard the hint
      this.expect(")");
      return first;
    }

    // __struct_new(__struct Foo, args...) — struct.new / struct.new_default
    // __new(__struct Foo, args...) — alias for __struct_new
    // The type-arg is the bare heap form (e.g. `__struct Foo`, possibly via a
    // typedef). The expression's value type is the corresponding ref form.
    if (this.matchKW(Lexer.Keyword.X_STRUCT_NEW) || this.matchKW(Lexer.Keyword.X_NEW)) {
      const newTok = this.peek(-1);
      const callName = newTok.text;
      this.expect("(");
      if (!this.isTypeName()) this.error(this.peek(), `${callName} requires a __struct type`);
      const specs = this.parseDeclSpecifiers();
      let nType = specs.type;
      if (this.atText("*") || this.atText("[") || this.atText("(")) {
        const decl = this.parseDeclarator(nType);
        nType = decl.type;
      }
      const nq = nType.removeQualifiers();
      if (!nq.isGCStructHeap()) {
        this.error(newTok, `${callName} requires a heap-form __struct type (e.g. '__struct Foo', no '*'), got '${nType.toString()}'`);
      }
      if (!nq.isComplete) this.error(newTok, `${callName} of incomplete GC struct '${nq.tagName}'`);
      const args = [];
      while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      this.expect(")");
      const fields = nq.tagDecl.members;
      if (args.length !== 0 && args.length !== fields.length) {
        this.error(newTok, `${callName}(__struct ${nq.tagName}, ...): expected ${fields.length} field args, got ${args.length}`);
      }
      // Reject implicit non-zero int → non-eqref ref field (silent-null bug).
      const newLoc = Lexer.Loc.fromTok(newTok);
      for (let i = 0; i < args.length; i++) {
        AST.rejectNonZeroToRef(fields[i].type, args[i], newLoc);
      }
      return new AST.EGCNew(newLoc, nq.pointer(), args);
    }

    // __array_new(elemType, length [, init]) — array.new / array.new_default
    if (this.matchKW(Lexer.Keyword.X_ARRAY_NEW)) {
      const newTok = this.peek(-1);
      this.expect("(");
      if (!this.isTypeName()) this.error(this.peek(), `__array_new requires an element type as the first argument`);
      const specs = this.parseDeclSpecifiers();
      let elemType = specs.type;
      if (this.atText("*") || this.atText("[") || this.atText("(")) {
        const decl = this.parseDeclarator(elemType);
        elemType = decl.type;
      }
      if (elemType.isArray() || elemType.isFunction()) {
        this.error(newTok, `__array_new element type must not be a C array or function`);
      }
      const arrType = Types.gcArrayOf(elemType);
      const args = [];
      while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      this.expect(")");
      if (args.length < 1 || args.length > 2) {
        this.error(newTok, `__array_new(...): expected length [, init], got ${args.length} args`);
      }
      // Reject non-zero int as fill value when element type is a non-eqref ref.
      const newLoc = Lexer.Loc.fromTok(newTok);
      if (args.length === 2) AST.rejectNonZeroToRef(elemType, args[1], newLoc);
      return new AST.EGCNew(newLoc, arrType, args);
    }

    // __memory_size, __memory_grow
    if (this.matchKW(Lexer.Keyword.X_MEMORY_SIZE)) {
      const kwLoc = Lexer.Loc.fromTok(this.peek(-1));
      this.expect("(");
      this.expect(")");
      return new AST.EIntrinsic(kwLoc, Types.TULONG, Types.IntrinsicKind.MEMORY_SIZE, []);
    }
    if (this.matchKW(Lexer.Keyword.X_MEMORY_GROW)) {
      const kwLoc = Lexer.Loc.fromTok(this.peek(-1));
      this.expect("(");
      const arg = this.parseAssignmentExpression();
      this.expect(")");
      return new AST.EIntrinsic(kwLoc, Types.TULONG, Types.IntrinsicKind.MEMORY_GROW, [arg]);
    }

    // __ref_is_null(ref)
    if (this.matchKW(Lexer.Keyword.X_REF_IS_NULL)) {
      const tok = this.peek(-1);
      this.expect("(");
      const arg = this.parseAssignmentExpression();
      this.expect(")");
      if (!arg.type.removeQualifiers().isRef()) {
        this.error(tok, `__ref_is_null requires a reference type, got '${arg.type.toString()}'`);
      }
      return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), Types.TINT, Types.IntrinsicKind.REF_IS_NULL, [arg]);
    }

    // __ref_eq(ref, ref)
    if (this.matchKW(Lexer.Keyword.X_REF_EQ)) {
      const tok = this.peek(-1);
      this.expect("(");
      const a = this.parseAssignmentExpression();
      this.expect(",");
      const b = this.parseAssignmentExpression();
      this.expect(")");
      const at = a.type.removeQualifiers(), bt = b.type.removeQualifiers();
      if (!at.isRef() || !bt.isRef()) {
        this.error(tok, `__ref_eq requires two reference operands, got '${a.type.toString()}' and '${b.type.toString()}'`);
      }
      return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), Types.TINT, Types.IntrinsicKind.REF_EQ, [a, b]);
    }

    // __ref_null(type) — produces a null of the given reference type.
    // The type-arg is the heap form for GC structs (`__struct Foo`, no `*`)
    // mirroring wasm's `ref.null heaptype`. For arrays / externref / eqref
    // (which have no separate heap-form spelling), pass the type directly.
    if (this.matchKW(Lexer.Keyword.X_REF_NULL)) {
      const tok = this.peek(-1);
      this.expect("(");
      if (!this.isTypeName()) this.error(tok, "__ref_null requires a reference type");
      const specs = this.parseDeclSpecifiers();
      let nType = specs.type;
      if (this.atText("*") || this.atText("[") || this.atText("(")) {
        const decl = this.parseDeclarator(nType);
        nType = decl.type;
      }
      this.expect(")");
      const nq = nType.removeQualifiers();
      if (nq.isGCStruct()) {
        this.error(tok, `__ref_null takes the heap form '__struct ${nq.tagName}' (no '*'), got '${nType.toString()}'`);
      } else if (!nq.isRef() && !nq.isGCStructHeap()) {
        this.error(tok, `__ref_null requires a reference type, got '${nType.toString()}'`);
      }
      if (nq === Types.TREFEXTERN) {
        this.error(tok, `__ref_null(__refextern) is not allowed — non-nullable refs cannot be null; use __externref instead`);
      }
      // The expression's value type is the ref form (for GC structs) or the
      // type itself (already a ref for externref/eqref/array).
      const valueType = nq.isGCStructHeap() ? nq.pointer() : nq;
      return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), valueType, Types.IntrinsicKind.REF_NULL, [], nq);
    }

    // __ref_test(target_type, ref) — runtime type test
    // __ref_test / __ref_test_null — runtime type test.
    //   __ref_test(T, x)      → false on null (instance-of semantics)
    //   __ref_test_null(T, x) → true on null (type-lattice semantics, pairs
    //                           with __ref_cast_null which doesn't trap on null)
    {
      const isNullable = this.atKW(Lexer.Keyword.X_REF_TEST_NULL);
      const isPlain = this.atKW(Lexer.Keyword.X_REF_TEST);
      if (isNullable || isPlain) {
        this.advance();
        const opName = isNullable ? "__ref_test_null" : "__ref_test";
        const tok = this.peek(-1);
        this.expect("(");
        if (!this.isTypeName()) this.error(tok, `${opName} requires a target heap-type`);
        const specs = this.parseDeclSpecifiers();
        let tType = specs.type;
        if (this.atText("*") || this.atText("[") || this.atText("(")) {
          const decl = this.parseDeclarator(tType);
          tType = decl.type;
        }
        this.expect(",");
        const refExpr = this.parseAssignmentExpression();
        this.expect(")");
        const tq = tType.removeQualifiers();
        if (tq.isGCStruct()) {
          this.error(tok, `${opName} target takes the heap form '__struct ${tq.tagName}' (no '*'), got '${tType.toString()}'`);
        } else if (!tq.isGCStructHeap() && !tq.isGCArray()) {
          this.error(tok, `${opName} target must be a heap-form __struct or __array type, got '${tType.toString()}'`);
        }
        if (!refExpr.type.removeQualifiers().isGCRef()) {
          this.error(tok, `${opName} second argument must be a GC-universe ref, got '${refExpr.type.toString()}'`);
        }
        const kind = isNullable ? Types.IntrinsicKind.REF_TEST_NULL : Types.IntrinsicKind.REF_TEST;
        return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), Types.TINT, kind, [refExpr], tq);
      }
    }

    // __ref_cast / __ref_cast_null — runtime downcast (traps on type mismatch).
    //   __ref_cast(T, x)      → traps on null (matches WASM `ref.cast`).
    //   __ref_cast_null(T, x) → null passes through unchanged
    //                           (matches WASM `ref.cast null`).
    {
      const isNullable = this.atKW(Lexer.Keyword.X_REF_CAST_NULL);
      const isPlain = this.atKW(Lexer.Keyword.X_REF_CAST);
      if (isNullable || isPlain) {
        this.advance();
        const opName = isNullable ? "__ref_cast_null" : "__ref_cast";
        const tok = this.peek(-1);
        this.expect("(");
        if (!this.isTypeName()) this.error(tok, `${opName} requires a target heap-type`);
        const specs = this.parseDeclSpecifiers();
        let tType = specs.type;
        if (this.atText("*") || this.atText("[") || this.atText("(")) {
          const decl = this.parseDeclarator(tType);
          tType = decl.type;
        }
        this.expect(",");
        const refExpr = this.parseAssignmentExpression();
        this.expect(")");
        const tq = tType.removeQualifiers();
        if (tq.isGCStruct()) {
          this.error(tok, `${opName} target takes the heap form '__struct ${tq.tagName}' (no '*'), got '${tType.toString()}'`);
        } else if (!tq.isGCStructHeap() && !tq.isGCArray()) {
          this.error(tok, `${opName} target must be a heap-form __struct or __array type, got '${tType.toString()}'`);
        }
        if (!refExpr.type.removeQualifiers().isGCRef()) {
          this.error(tok, `${opName} second argument must be a GC-universe ref, got '${refExpr.type.toString()}'`);
        }
        // Result value type: the ref form (for struct heap) or the array (already a ref).
        const valueType = tq.isGCStructHeap() ? tq.pointer() : tq;
        const kind = isNullable ? Types.IntrinsicKind.REF_CAST_NULL : Types.IntrinsicKind.REF_CAST;
        return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), valueType, kind, [refExpr], tq);
      }
    }

    // __array_len(arr) — array length
    if (this.matchKW(Lexer.Keyword.X_ARRAY_LEN)) {
      const tok = this.peek(-1);
      this.expect("(");
      const arg = this.parseAssignmentExpression();
      this.expect(")");
      if (!arg.type.removeQualifiers().isGCArray()) {
        this.error(tok, `__array_len requires a __array(...) operand, got '${arg.type.toString()}'`);
      }
      return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), Types.TINT, Types.IntrinsicKind.ARRAY_LEN, [arg]);
    }

    // __array_of(elemType, v1, v2, ...) — array.new_fixed
    if (this.matchKW(Lexer.Keyword.X_ARRAY_OF)) {
      const tok = this.peek(-1);
      this.expect("(");
      if (!this.isTypeName()) this.error(tok, "__array_of first argument must be the element type");
      const specs = this.parseDeclSpecifiers();
      let elemType = specs.type;
      if (this.atText("*") || this.atText("[") || this.atText("(")) {
        const decl = this.parseDeclarator(elemType);
        elemType = decl.type;
      }
      const args = [];
      while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      this.expect(")");
      if (elemType.isArray() || elemType.isFunction()) {
        this.error(tok, `__array_of element type must not be a C array or function`);
      }
      // Reject implicit non-zero int → non-eqref ref element (silent-null bug).
      const tokLoc = Lexer.Loc.fromTok(tok);
      for (let i = 0; i < args.length; i++) {
        AST.rejectNonZeroToRef(elemType, args[i], tokLoc);
      }
      const arrType = Types.gcArrayOf(elemType);
      return new AST.EIntrinsic(tokLoc, arrType, Types.IntrinsicKind.GC_NEW_ARRAY, args, elemType);
    }

    // __array_fill(arr, offset, value, count) — bulk fill of a GC array slice
    if (this.matchKW(Lexer.Keyword.X_ARRAY_FILL)) {
      const tok = this.peek(-1);
      this.expect("(");
      const arr = this.parseAssignmentExpression();
      this.expect(",");
      const off = this.parseAssignmentExpression();
      this.expect(",");
      const val = this.parseAssignmentExpression();
      this.expect(",");
      const count = this.parseAssignmentExpression();
      this.expect(")");
      if (!arr.type.removeQualifiers().isGCArray()) {
        this.error(tok, `__array_fill first argument must be a __array(...), got '${arr.type.toString()}'`);
      }
      const elemType = arr.type.removeQualifiers().baseType;
      const tokLoc = Lexer.Loc.fromTok(tok);
      AST.rejectNonZeroToRef(elemType, val, tokLoc);
      return new AST.EIntrinsic(tokLoc, Types.TVOID, Types.IntrinsicKind.ARRAY_FILL, [arr, off, val, count]);
    }

    // __ref_as_extern(gc_ref) — wrap a GC-universe ref (struct/array/eqref)
    // as an externref. Cheap retag (extern.convert_any).
    if (this.matchKW(Lexer.Keyword.X_REF_AS_EXTERN)) {
      const tok = this.peek(-1);
      this.expect("(");
      const arg = this.parseAssignmentExpression();
      this.expect(")");
      if (!arg.type.removeQualifiers().isGCRef()) {
        this.error(tok, `__ref_as_extern requires a GC-universe ref (__struct/__array/__eqref), got '${arg.type.toString()}'`);
      }
      return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), Types.TEXTERNREF, Types.IntrinsicKind.REF_AS_EXTERN, [arg]);
    }

    // __ref_as_any(extern_ref) — unwrap an externref to eqref. Cheap retag
    // (any.convert_extern). Result is __eqref — use __ref_cast(T, ...) to
    // narrow to a specific GC type.
    if (this.matchKW(Lexer.Keyword.X_REF_AS_EQ)) {
      const tok = this.peek(-1);
      this.expect("(");
      const arg = this.parseAssignmentExpression();
      this.expect(")");
      const at = arg.type.removeQualifiers();
      if (at !== Types.TEXTERNREF && at !== Types.TREFEXTERN) {
        this.error(tok, `__ref_as_any requires an __externref/__refextern, got '${arg.type.toString()}'`);
      }
      return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), Types.TEQREF, Types.IntrinsicKind.REF_AS_EQ, [arg]);
    }

    // __cast(TargetType, expr) — universal conversion. Dispatch on the
    // (source, target) type combo at codegen time. Supports:
    //   - prim ↔ __eqref       (auto-boxes/unboxes via internal box structs)
    //   - GC ref ↔ __eqref     (subtype upcast / ref.cast downcast)
    //   - GC ref → GC ref       (ref.cast — same as __ref_cast)
    //   - GC ref ↔ __externref  (extern bridges)
    //   - prim → prim           (numeric conversion)
    //   - same type             (identity)
    if (this.matchKW(Lexer.Keyword.X_CAST)) {
      const tok = this.peek(-1);
      this.expect("(");
      if (!this.isTypeName()) this.error(tok, "__cast requires a target type as first arg");
      const specs = this.parseDeclSpecifiers();
      let tType = specs.type;
      if (this.atText("*") || this.atText("[") || this.atText("(")) {
        const decl = this.parseDeclarator(tType);
        tType = decl.type;
      }
      this.expect(",");
      const expr = this.parseAssignmentExpression();
      this.expect(")");
      const tq = tType.removeQualifiers();
      // For GC structs, require heap-form spelling (matches __ref_cast).
      if (tq.isGCStruct()) {
        this.error(tok, `__cast target takes the heap form '__struct ${tq.tagName}' (no '*'), got '${tType.toString()}'`);
      }
      // Result value type and codegen-target are the ref form for GC struct heap;
      // for everything else the user-spelled type is already a value type.
      const valueType = tq.isGCStructHeap() ? tq.pointer() : tq;
      const sq = expr.type.removeQualifiers();
      // Validate combinations at parse time. The codegen path handles the
      // mechanics; here we just reject combos that don't have a defined
      // conversion (e.g. prim ↔ extern, prim → GC struct, etc.).
      const isPrim = (t) => t.isArithmetic();
      const isEqref = (t) => t === Types.TEQREF;
      const isExternref = (t) => t === Types.TEXTERNREF || t === Types.TREFEXTERN;
      const ok = (sq === valueType) ||
        (isPrim(sq) && isPrim(tq)) ||
        (isPrim(sq) && isEqref(tq)) ||                        // box
        (isEqref(sq) && isPrim(tq)) ||                        // unbox
        (sq.isGCRef() && isEqref(tq)) ||                      // upcast
        (isEqref(sq) && valueType.isGCRef()) ||               // downcast
        (sq.isGCRef() && valueType.isGCRef()) ||              // GC sidecast/downcast
        (sq.isGCRef() && isExternref(tq)) ||                   // GC → extern bridge
        (isExternref(sq) && tq === Types.TEQREF);             // extern → any bridge
      if (!ok) {
        this.error(tok,
          `__cast: no conversion defined from '${expr.type.toString()}' to '${tType.toString()}'`);
      }
      return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), valueType, Types.IntrinsicKind.CAST, [expr], valueType);
    }

    // __array_copy(dst, dst_off, src, src_off, count) — bulk copy between GC arrays
    if (this.matchKW(Lexer.Keyword.X_ARRAY_COPY)) {
      const tok = this.peek(-1);
      this.expect("(");
      const dst = this.parseAssignmentExpression();
      this.expect(",");
      const dstOff = this.parseAssignmentExpression();
      this.expect(",");
      const src = this.parseAssignmentExpression();
      this.expect(",");
      const srcOff = this.parseAssignmentExpression();
      this.expect(",");
      const count = this.parseAssignmentExpression();
      this.expect(")");
      if (!dst.type.removeQualifiers().isGCArray()) {
        this.error(tok, `__array_copy dst must be a __array(...), got '${dst.type.toString()}'`);
      }
      if (!src.type.removeQualifiers().isGCArray()) {
        this.error(tok, `__array_copy src must be a __array(...), got '${src.type.toString()}'`);
      }
      const dstElem = dst.type.removeQualifiers().baseType;
      const srcElem = src.type.removeQualifiers().baseType;
      if (dstElem.removeQualifiers() !== srcElem.removeQualifiers()) {
        this.error(tok,
          `__array_copy element type mismatch: dst is '${dst.type.toString()}', src is '${src.type.toString()}'`);
      }
      return new AST.EIntrinsic(Lexer.Loc.fromTok(tok), Types.TVOID, Types.IntrinsicKind.ARRAY_COPY, [dst, dstOff, src, srcOff, count]);
    }

    // __builtin(kind, args...)
    if (this.matchKW(Lexer.Keyword.X_BUILTIN)) {
      const builtinTok = this.peek(-1);
      this.expect("(");
      const kindTok = this.expectKind(Lexer.TokenKind.IDENT);
      const kindName = kindTok.text;
      const args = [];
      while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      this.expect(")");
      let ik = Types.IntrinsicKind[kindName.toUpperCase()] || kindName;
      // Map common names
      if (kindName === "alloca") ik = Types.IntrinsicKind.ALLOCA;
      else if (kindName === "memory_copy") ik = Types.IntrinsicKind.MEMORY_COPY;
      else if (kindName === "memory_fill") ik = Types.IntrinsicKind.MEMORY_FILL;
      else if (kindName === "heap_base") ik = Types.IntrinsicKind.HEAP_BASE;
      let retType = Types.TVOID;
      if (ik === Types.IntrinsicKind.ALLOCA) retType = Types.TVOID.pointer();
      else if (ik === Types.IntrinsicKind.HEAP_BASE || ik === Types.IntrinsicKind.MEMORY_SIZE || ik === Types.IntrinsicKind.MEMORY_GROW) retType = Types.TULONG;
      return new AST.EIntrinsic(Lexer.Loc.fromTok(builtinTok), retType, ik, args);
    }

    // __wasm(type, (args...), instruction, ...)
    if (this.matchKW(Lexer.Keyword.X_WASM)) {
      const wasmTok = this.peek(-1);
      this.expect("(");
      const retSpecs = this.parseDeclSpecifiers();
      let retType = retSpecs.type;
      while (this.matchText("*")) {
        if (retType.isGCStruct()) {
          this.error(this.peek(-1), `'${retType.toString()}' is already a reference; '__struct Foo **' is not allowed`);
          break;
        }
        retType = retType.pointer();
      }
      const args = [];
      const bytes = [];
      // Parse required argument list
      this.expect(",");
      this.expect("(");
      if (!this.atText(")")) {
        args.push(this.parseAssignmentExpression());
        while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      }
      this.expect(")");
      // Parse instructions
      while (this.matchText(",")) {
        const instrTok = this.advance();
        if (instrTok.text === "op") {
          while (this.atKind(Lexer.TokenKind.INT)) {
            bytes.push(Number(this.advance().integer) & 0xff);
          }
        } else if (instrTok.text === "lebU") {
          const numTok = this.advance();
          if (numTok.kind !== Lexer.TokenKind.INT) this.error(numTok, "Expected integer after lebU");
          lebU(bytes, Number(numTok.integer));
        } else if (instrTok.text === "lebI") {
          const negative = this.matchText("-");
          const numTok = this.advance();
          if (numTok.kind !== Lexer.TokenKind.INT) this.error(numTok, "Expected integer after lebI");
          let val = Number(numTok.integer);
          if (negative) val = -val;
          lebI(bytes, val);
        } else if (instrTok.text === "i32") {
          const negative = this.matchText("-");
          const numTok = this.advance();
          if (numTok.kind !== Lexer.TokenKind.INT) this.error(numTok, "Expected integer after i32");
          let val = Number(numTok.integer) | 0;
          if (negative) val = -val;
          bytes.push(0x41); // i32.const
          lebI(bytes, val);
        } else if (instrTok.text === "i64") {
          const negative = this.matchText("-");
          const numTok = this.advance();
          if (numTok.kind !== Lexer.TokenKind.INT) this.error(numTok, "Expected integer after i64");
          let val = BigInt(numTok.integer);
          if (negative) val = -val;
          bytes.push(0x42); // i64.const
          lebI64(bytes, val);
        } else if (instrTok.text === "f32") {
          const negative = this.matchText("-");
          const numTok = this.advance();
          let val;
          if (numTok.kind === Lexer.TokenKind.INT) val = Number(numTok.integer);
          else if (numTok.kind === Lexer.TokenKind.FLOAT) val = numTok.floating;
          else this.error(numTok, "Expected number after f32");
          if (negative) val = -val;
          bytes.push(0x43); // f32.const
          const f32buf = new ArrayBuffer(4);
          new Float32Array(f32buf)[0] = val;
          for (const b of new Uint8Array(f32buf)) bytes.push(b);
        } else if (instrTok.text === "f64") {
          const negative = this.matchText("-");
          const numTok = this.advance();
          let val;
          if (numTok.kind === Lexer.TokenKind.INT) val = Number(numTok.integer);
          else if (numTok.kind === Lexer.TokenKind.FLOAT) val = numTok.floating;
          else this.error(numTok, "Expected number after f64");
          if (negative) val = -val;
          bytes.push(0x44); // f64.const
          const f64buf = new ArrayBuffer(8);
          new Float64Array(f64buf)[0] = val;
          for (const b of new Uint8Array(f64buf)) bytes.push(b);
        }
      }
      this.expect(")");
      return new AST.EWasm(Lexer.Loc.fromTok(wasmTok), retType, args, bytes);
    }

    // _Generic
    if (this.matchKW(Lexer.Keyword.GENERIC)) {
      const genericTok = this.peek(-1);
      this.expect("(");
      const controlExpr = this.parseAssignmentExpression();
      let result = null;
      let defaultExpr = null;
      while (this.matchText(",")) {
        if (this.matchKW(Lexer.Keyword.DEFAULT)) {
          this.expect(":");
          defaultExpr = this.parseAssignmentExpression();
        } else {
          const specs = this.parseDeclSpecifiers();
          let gType = specs.type;
          if (this.atText("*")) {
            const d = this.parseDeclarator(gType);
            gType = d.type;
          }
          this.expect(":");
          const gExpr = this.parseAssignmentExpression();
          if (controlExpr.type.removeQualifiers() === gType.removeQualifiers()) result = gExpr;
        }
      }
      this.expect(")");
      if (!result && !defaultExpr) {
        this.error(this.peek(-1), "_Generic: no matching type and no 'default' association");
      }
      return result || defaultExpr || new AST.EInt(Lexer.Loc.fromTok(genericTok), Types.TINT, 0n);
    }

    this.error(t, `Unexpected token in expression: ${t.kind} '${t.text}'`);
  }

  parseStringLiteral() {
    // Determine string prefix from first token
    const startTok = this.peek();
    let prefix = startTok.flags.stringPrefix || Lexer.StringPrefix.NONE;
    const startLoc = Lexer.Loc.fromTok(startTok);
    const codepoints = [];
    while (this.atKind(Lexer.TokenKind.STRING)) {
      const tok = this.advance();
      // Upgrade prefix if any token has a wider prefix
      if (tok.flags.stringPrefix && tok.flags.stringPrefix !== Lexer.StringPrefix.NONE) {
        if (prefix === Lexer.StringPrefix.NONE || prefix === Lexer.StringPrefix.PREFIX_u8) prefix = tok.flags.stringPrefix;
      }
      const text = tok.text;
      const start = text.startsWith('"') ? 1 : (text.indexOf('"') + 1);
      const end = text.lastIndexOf('"');
      const inner = text.substring(start, end);
      const pos = { i: 0 };
      while (pos.i < inner.length) {
        codepoints.push(Lexer.unescape(inner, pos, inner.length));
      }
    }
    if (prefix === Lexer.StringPrefix.PREFIX_u) {
      // UTF-16 string: element type is unsigned short (char16_t)
      const bytes = [];
      for (const cp of codepoints) Lexer.encodeUtf16LE(cp, bytes);
      bytes.push(0); bytes.push(0); // null terminator (2 bytes)
      const elemCount = bytes.length / 2;
      return new AST.EString(startLoc, Types.arrayOf(Types.TUSHORT, elemCount), bytes);
    }
    if (prefix === Lexer.StringPrefix.PREFIX_L) {
      // UTF-32 string: element type is int (wchar_t)
      const bytes = [];
      for (const cp of codepoints) Lexer.encodeUtf32LE(cp, bytes);
      bytes.push(0); bytes.push(0); bytes.push(0); bytes.push(0); // null terminator (4 bytes)
      const elemCount = bytes.length / 4;
      return new AST.EString(startLoc, Types.arrayOf(Types.TINT, elemCount), bytes);
    }
    if (prefix === Lexer.StringPrefix.PREFIX_U) {
      // UTF-32 string: element type is unsigned int (char32_t)
      const bytes = [];
      for (const cp of codepoints) Lexer.encodeUtf32LE(cp, bytes);
      bytes.push(0); bytes.push(0); bytes.push(0); bytes.push(0); // null terminator (4 bytes)
      const elemCount = bytes.length / 4;
      return new AST.EString(startLoc, Types.arrayOf(Types.TUINT, elemCount), bytes);
    }
    // Regular or u8 string: element type is char
    // Codepoints <= 0xFF are raw bytes (from \xNN escapes).
    // Codepoints > 0xFF (literal Unicode or \uNNNN) are encoded as UTF-8.
    const bytes = [];
    for (const cp of codepoints) {
      if (cp <= 0xff) bytes.push(cp);
      else Lexer.encodeUtf8(cp, bytes);
    }
    bytes.push(0);
    return new AST.EString(startLoc, Types.arrayOf(Types.TCHAR, bytes.length), bytes);
  }

  parseIntrinsic(ikind) {
    const kwTok = this.peek();
    this.advance();
    this.expect("(");
    const args = [];
    if (!this.atText(")")) {
      args.push(this.parseAssignmentExpression());
      while (this.matchText(",")) args.push(this.parseAssignmentExpression());
    }
    this.expect(")");
    let retType = Types.TVOID;
    if (ikind === Types.IntrinsicKind.VA_START || ikind === Types.IntrinsicKind.VA_END || ikind === Types.IntrinsicKind.VA_COPY) retType = Types.TVOID;
    return new AST.EIntrinsic(Lexer.Loc.fromTok(kwTok), retType, ikind, args);
  }

  parseVaArg() {
    const kwTok = this.peek();
    this.advance();
    this.expect("(");
    const ap = this.parseAssignmentExpression();
    this.expect(",");
    const specs = this.parseDeclSpecifiers();
    let argType = specs.type;
    if (this.atText("*")) {
      const d = this.parseDeclarator(argType);
      argType = d.type;
    }
    this.expect(")");
    if (argType.removeQualifiers().isRef()) {
      this.error(this.peek(-1),
        `va_arg cannot retrieve a reference type '${argType.toString()}' — vararg storage uses linear memory which can't hold GC references`);
    }
    return new AST.EIntrinsic(Lexer.Loc.fromTok(kwTok), argType, Types.IntrinsicKind.VA_ARG, [ap], argType);
  }

  // Matches CC's parsePostfixExpression (compiler.cc ~line 10495)
  parsePostfixExpression() {
    const expr = this.parsePrimaryExpression();
    return this.parsePostfixTail(expr);
  }

  _validateCond(expr, tok, ctxName) {
    // Controlling expressions (if/while/for/do/?:) must be scalar.
    // We extend C with refs (sugar for !__ref_is_null), but reject
    // structs / unions / arrays / void.
    if (!AST.isBoolContextType(expr.type)) {
      this.error(tok,
        `controlling expression of '${ctxName}' must be scalar, got '${expr.type.toString()}'`);
    }
  }

  // C23 `auto`: validate that the declarator is a plain identifier (no
  // pointer / array / function modifiers) and that an initializer is present.
  // Returns the inferred type (post lvalue/decay), or null if validation fails.
  _resolveAuto(baseType, declType, name, initExpr, declTok) {
    if (baseType !== Types.TAUTO) return null;
    // declType may have been "wrapped" by parseDeclarator if user wrote
    // `auto *x` etc. Detect by checking if declType differs from TAUTO.
    if (declType !== Types.TAUTO) {
      this.error(declTok, `'auto' cannot be combined with declarator modifiers (no '*', '[]', or '()' allowed)`);
      return Types.TINT;
    }
    if (!initExpr) {
      this.error(declTok, `'auto ${name}' requires an initializer`);
      return Types.TINT;
    }
    if (initExpr instanceof AST.EInitList) {
      this.error(declTok, `'auto ${name}' cannot be initialized from a braced initializer list`);
      return Types.TINT;
    }
    // Apply lvalue conversion (decay arrays/functions to pointers); strip
    // top-level qualifiers (matches C23 semantics).
    const initType = initExpr.type.decay().removeQualifiers();
    if (initType === Types.TVOID) {
      this.error(declTok, `'auto ${name}' cannot infer type 'void'`);
      return Types.TINT;
    }
    return initType;
  }

  // Matches CC's parseUnaryExpression (compiler.cc ~line 10538)
  parseUnaryExpression() {
    const PREFIX_OPS = {
      "++": "OP_PRE_INC", "--": "OP_PRE_DEC",
      "+": "OP_POS", "-": "OP_NEG", "~": "OP_BNOT", "!": "OP_LNOT",
    };
    for (const [text, op] of Object.entries(PREFIX_OPS)) {
      if (this.matchText(text)) {
        const loc = Lexer.Loc.fromTok(this.peek(-1));
        // ++/-- recurse into parseUnaryExpression; everything else into parseCastExpression.
        const e = (op === "OP_PRE_INC" || op === "OP_PRE_DEC")
          ? this.parseUnaryExpression() : this.parseCastExpression();
        return AST.makeUnary(loc, op, e);
      }
    }
    if (this.matchText("&")) {
      const loc = Lexer.Loc.fromTok(this.peek(-1));
      return AST.makeUnary(loc, "OP_ADDR", this.parseCastExpression());
    }
    if (this.matchText("*")) {
      const loc = Lexer.Loc.fromTok(this.peek(-1));
      return AST.makeUnary(loc, "OP_DEREF", this.parseCastExpression());
    }

    if (this.atKW(Lexer.Keyword.SIZEOF)) return this.parsePrimaryExpression(); // handled there
    if (this.atKW(Lexer.Keyword.ALIGNOF)) return this.parsePrimaryExpression();

    return this.parsePostfixExpression();
  }

  parseCastExpression() {
    if (this.atText("(")) {
      // Look ahead: is this a cast or a parenthesized expression?
      const startTok = this.peek();
      const saved = this.pos;
      this.advance();
      if (this.isTypeName()) {
        const specs = this.parseDeclSpecifiers();
        let castType = specs.type;
        if (this.atText("*") || this.atText("[") || this.atText("(")) {
          const d = this.parseDeclarator(castType);
          castType = d.type;
        }
        if (this.matchText(")")) {
          const startLoc = Lexer.Loc.fromTok(startTok);
          if (this.atText("{")) {
            // Compound literal: (type){...}
            let initList = this.parseInitList(castType);
            if (castType.isArray() && castType.arraySize === 0 &&
                initList.elements.length === 1 && initList.elements[0] instanceof AST.EString) {
              castType = initList.elements[0].type;
              initList = new AST.EInitList(initList.loc, castType,
                initList.elements, initList.designators, initList.unionMemberIndex);
            } else if (castType.isArray() && castType.arraySize === 0) {
              initList = normalizeInitList(initList, castType);
              castType = initList.type;
            } else if (castType.isAggregate()) {
              initList = normalizeInitList(initList, castType);
            }
            return this.parsePostfixTail(new AST.ECompoundLiteral(startLoc, castType, initList));
          }
          const expr = this.parseCastExpression();
          // GCC extension: cast-to-union — (union_type) expr → compound literal
          if (castType.isUnion()) {
            let initList = new AST.EInitList(startLoc, castType, [expr], []);
            initList = normalizeInitList(initList, castType);
            return this.parsePostfixTail(new AST.ECompoundLiteral(startLoc, castType, initList));
          }
          return AST.makeCast(startLoc, castType, expr);
        }
      }
      this.pos = saved;
    }
    return this.parseUnaryExpression();
  }

  parsePostfixTail(expr) {
    while (true) {
      if (this.matchText("(")) {
        // Function call
        const callTok = this.peek(-1);
        const args = [];
        if (!this.atText(")")) {
          do {
            args.push(this.parseAssignmentExpression());
          } while (this.matchText(","));
        }
        this.expect(")");
        expr = AST.makeCall(Lexer.Loc.fromTok(callTok), expr, args);
        continue;
      }
      if (this.matchText("[")) {
        const lbrTok = this.peek(-1);
        const index = this.parseExpression();
        this.expect("]");
        expr = AST.makeSubscript(Lexer.Loc.fromTok(lbrTok), expr, index);
        continue;
      }
      if (this.matchText(".")) {
        const dotLoc = Lexer.Loc.fromTok(this.peek(-1));
        const name = this.expectKind(Lexer.TokenKind.IDENT).text;
        expr = AST.makeMember(dotLoc, expr, name);
        continue;
      }
      if (this.matchText("->")) {
        const arrowLoc = Lexer.Loc.fromTok(this.peek(-1));
        const name = this.expectKind(Lexer.TokenKind.IDENT).text;
        expr = AST.makeArrow(arrowLoc, expr, name);
        continue;
      }
      if (this.matchText("++")) {
        expr = AST.makeUnary(Lexer.Loc.fromTok(this.peek(-1)), "OP_POST_INC", expr);
        continue;
      }
      if (this.matchText("--")) {
        expr = AST.makeUnary(Lexer.Loc.fromTok(this.peek(-1)), "OP_POST_DEC", expr);
        continue;
      }
      break;
    }
    return expr;
  }

  getBinaryPrecedence(op) {
    if (op === ",") return 1;
    if (op === "=" || op === "+=" || op === "-=" || op === "*=" || op === "/=" ||
        op === "%=" || op === "&=" || op === "|=" || op === "^=" || op === "<<=" || op === ">>=") return 2;
    if (op === "?") return 3;
    if (op === "||") return 4;
    if (op === "&&") return 5;
    if (op === "|") return 6;
    if (op === "^") return 7;
    if (op === "&") return 8;
    if (op === "==" || op === "!=") return 9;
    if (op === "<" || op === ">" || op === "<=" || op === ">=") return 10;
    if (op === "<<" || op === ">>") return 11;
    if (op === "+" || op === "-") return 12;
    if (op === "*" || op === "/" || op === "%") return 13;
    return 0;
  }

  isRightAssociative(op) {
    return op === "=" || op === "+=" || op === "-=" || op === "*=" || op === "/=" ||
        op === "%=" || op === "&=" || op === "|=" || op === "^=" || op === "<<=" || op === ">>=";
  }

  textToBop(op) {
    const map = {
      "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD",
      "==": "EQ", "!=": "NE", "<": "LT", ">": "GT", "<=": "LE", ">=": "GE",
      "&&": "LAND", "||": "LOR", "&": "BAND", "|": "BOR", "^": "BXOR",
      "<<": "SHL", ">>": "SHR", "=": "ASSIGN",
      "+=": "ADD_ASSIGN", "-=": "SUB_ASSIGN", "*=": "MUL_ASSIGN",
      "/=": "DIV_ASSIGN", "%=": "MOD_ASSIGN", "&=": "BAND_ASSIGN",
      "|=": "BOR_ASSIGN", "^=": "BXOR_ASSIGN", "<<=": "SHL_ASSIGN", ">>=": "SHR_ASSIGN",
    };
    return map[op];
  }

  // C99 6.3.1.1: integer promotions for bitfield expressions

  inferArraySizeFromInit(arrayType, initExpr) {
    const elemSize = arrayType.baseType.size || 1;
    if (initExpr instanceof AST.EString) {
      return Types.arrayOf(arrayType.baseType, initExpr.value.length / elemSize);
    }
    if (initExpr instanceof AST.EInitList) {
      // For char/short/int arrays initialized with a single string literal
      const bt = arrayType.baseType.removeQualifiers();
      if ((bt === Types.TCHAR || bt === Types.TSCHAR || bt === Types.TUCHAR ||
           bt === Types.TSHORT || bt === Types.TUSHORT || bt === Types.TINT || bt === Types.TUINT) &&
          initExpr.elements.length === 1 &&
          initExpr.elements[0] instanceof AST.EString) {
        return Types.arrayOf(arrayType.baseType, initExpr.elements[0].value.length / elemSize);
      }
      return Types.arrayOf(arrayType.baseType, initExpr.elements.length);
    }
    return arrayType;
  }

  computeTernaryType(thenType, elseType) {
    if (thenType === elseType) return thenType;
    const tIsRef = thenType.removeQualifiers().isRef();
    const eIsRef = elseType.removeQualifiers().isRef();
    if (tIsRef && eIsRef) return thenType;
    if (tIsRef) return thenType;          // (ref ? ref : 0) → ref (null branch)
    if (eIsRef) return elseType;
    if (thenType.isPointer() && elseType.isPointer()) {
      // C99 6.5.15.6: result is a pointer to a type with the union of
      // qualifiers from both operands. Picking either side as-is can
      // drop const/volatile and silently miscompile (e.g. lua's ternary
      // `(line == 0) ? "main" : pushfstring(...)`).
      const tBase = thenType.baseType, eBase = elseType.baseType;
      const wantConst = tBase.isConst || eBase.isConst;
      const wantVolatile = tBase.isVolatile || eBase.isVolatile;
      let base = tBase.removeQualifiers();
      if (wantConst) base = base.addConst();
      if (wantVolatile) base = base.toggleVolatile();
      return base.pointer();
    }
    if (thenType.isPointer()) return thenType;
    if (elseType.isPointer()) return elseType;
    return Types.usualArithmeticConversions(thenType, elseType);
  }

  parseBinaryExpression(minPrec) {
    let left = this.parseCastExpression();

    while (!this.atEnd()) {
      const opTok = this.peek();
      if (opTok.kind !== Lexer.TokenKind.PUNCT) break;
      const op = opTok.text;
      const prec = this.getBinaryPrecedence(op);
      if (prec === 0 || prec < minPrec) break;

      this.advance();

      // Ternary
      if (op === "?") {
        this._validateCond(left, opTok, "ternary");
        let thenExpr = this.parseExpression();
        this.expect(":");
        let elseExpr = this.parseBinaryExpression(3);
        // Decay array/function-typed branches; ternary results are
        // always pointer-typed (or scalar/aggregate).
        thenExpr = maybeDecay(thenExpr);
        elseExpr = maybeDecay(elseExpr);
        const resType = this.computeTernaryType(thenExpr.type, elseExpr.type);
        // Both branches must produce the same type — wrap each in an
        // implicit cast to resType when needed.
        thenExpr = maybeImplicitCast(thenExpr, resType);
        elseExpr = maybeImplicitCast(elseExpr, resType);
        left = new AST.ETernary(left.loc, resType, left, thenExpr, elseExpr);
        continue;
      }

      // Comma operator
      if (op === ",") {
        const exprs = [left];
        exprs.push(this.parseBinaryExpression(2)); // above comma precedence
        while (this.matchText(",")) {
          exprs.push(this.parseBinaryExpression(2));
        }
        left = new AST.EComma(left.loc, exprs[exprs.length - 1].type, exprs);
        continue;
      }

      const nextMinPrec = this.isRightAssociative(op) ? prec : prec + 1;
      const right = this.parseBinaryExpression(nextMinPrec);
      const bop = this.textToBop(op);
      // Parser-side warning for array-decay arithmetic (gated by --pedantic).
      if (this.warningFlags.pointerDecay && (bop === "ADD" || bop === "SUB")) {
        if ((left.type.isArray() && right.type.isInteger()) ||
            (right.type.isArray() && left.type.isInteger())) {
          this.warning(this.peek(-1), "array used in arithmetic expression; decaying to pointer");
        }
      }
      left = AST.makeBinary(left.loc, bop, left, right);
    }
    return left;
  }

  parseAssignmentExpression() { return this.parseBinaryExpression(2); }
  parseExpression() { return this.parseBinaryExpression(1); }

  // --- Init list parsing ---
  parseInitList(type) {
    const startTok = this.peek();
    this.expect("{");
    const elements = [];
    const designators = [];
    let hasDesignators = false;
    if (!this.atText("}")) {
      do {
        if (this.atText("}")) break;
        // Parse designators
        const desig = { steps: [] };
        let inDesig = false;
        if (this.atText(".") && this.peek(1)?.kind === Lexer.TokenKind.IDENT &&
            this.peek(2)?.kind === Lexer.TokenKind.PUNCT &&
            (this.peek(2)?.text === "=" || this.peek(2)?.text === "." || this.peek(2)?.text === "[")) {
          inDesig = true;
        } else if (this.atText("[")) {
          inDesig = true;
        }
        while (inDesig) {
          if (this.atText(".") && this.peek(1)?.kind === Lexer.TokenKind.IDENT) {
            this.advance(); // consume '.'
            const name = this.advance().text; // consume field name
            desig.steps.push({ kind: "FIELD", fieldName: name });
            hasDesignators = true;
          } else if (this.atText("[")) {
            this.advance(); // consume '['
            const indexExpr = this.parseAssignmentExpression();
            this.expect("]");
            desig.steps.push({ kind: "INDEX", indexExpr });
            hasDesignators = true;
          } else {
            break;
          }
          if (!this.atText(".") && !this.atText("[")) break;
        }
        if (desig.steps.length > 0) {
          this.expect("=");
        }
        designators.push(desig);
        if (this.atText("{")) {
          // Nested init list - determine element type for sub-list
          let elemType = Types.TINT;
          if (type.isArray()) elemType = type.baseType;
          else if (type.isTag() && type.tagDecl && type.tagDecl.members) {
            const varMembers = getVarMembers(type.tagDecl);
            if (elements.length < varMembers.length) {
              elemType = varMembers[elements.length].type;
            }
          }
          elements.push(this.parseInitList(elemType));
        } else {
          elements.push(this.parseAssignmentExpression());
        }
      } while (this.matchText(",") && !this.atText("}"));
    }
    this.expect("}");
    return new AST.EInitList(Lexer.Loc.fromTok(startTok), type, elements, hasDesignators ? designators : null);
  }

  // --- Statement parsing ---

  parseStatement() {
    return this._parseStatement(Lexer.Loc.fromTok(this.peek()));
  }

  _parseStatement(loc) {
    // Empty statement
    if (this.matchText(";")) return new AST.SEmpty(loc);

    // Compound statement
    if (this.atText("{")) return this.parseCompoundStatement();

    // if
    if (this.matchKW(Lexer.Keyword.IF)) {
      const kwTok = this.peek(-1);
      this.expect("(");
      const cond = this.parseExpression();
      this._validateCond(cond, kwTok, "if");
      this.expect(")");
      const thenBranch = this.parseStatement();
      let elseBranch = null;
      if (this.matchKW(Lexer.Keyword.ELSE)) elseBranch = this.parseStatement();
      return new AST.SIf(loc, cond, thenBranch, elseBranch);
    }

    // while
    if (this.matchKW(Lexer.Keyword.WHILE)) {
      const kwTok = this.peek(-1);
      this.expect("(");
      const cond = this.parseExpression();
      this._validateCond(cond, kwTok, "while");
      this.expect(")");
      return new AST.SWhile(loc, cond, this.parseStatement());
    }

    // do-while
    if (this.matchKW(Lexer.Keyword.DO)) {
      const kwTok = this.peek(-1);
      const body = this.parseStatement();
      this.expectKW(Lexer.Keyword.WHILE);
      this.expect("(");
      const cond = this.parseExpression();
      this._validateCond(cond, kwTok, "do-while");
      this.expect(")");
      this.expect(";");
      return new AST.SDoWhile(loc, body, cond);
    }

    // for
    if (this.matchKW(Lexer.Keyword.FOR)) {
      const kwTok = this.peek(-1);
      this.expect("(");
      this.typeScope.push(); this.tagScope.push(); this.varScope.push();
      let init = null, cond = null, incr = null;
      if (!this.matchText(";")) {
        if (this.isTypeName()) {
          init = this.parseDeclarationStatement();
        } else {
          const eTok = this.peek();
          const e = this.parseExpression();
          this.expect(";");
          init = new AST.SExpr(Lexer.Loc.fromTok(eTok), e);
        }
      }
      if (!this.matchText(";")) {
        cond = this.parseExpression();
        this._validateCond(cond, kwTok, "for");
        this.expect(";");
      }
      if (!this.atText(")")) incr = this.parseExpression();
      this.expect(")");
      const body = this.parseStatement();
      this.typeScope.pop(); this.tagScope.pop(); this.varScope.pop();
      return new AST.SFor(loc, init, cond, incr, body);
    }

    // switch
    if (this.matchKW(Lexer.Keyword.SWITCH)) {
      const switchTok = this.peek(-1);
      this.expect("(");
      const expr = this.parseExpression();
      const exprType = expr.type.removeQualifiers();
      if (exprType.isRef()) {
        this.error(switchTok, `cannot switch on reference type '${expr.type.toString()}'`);
      } else if (!exprType.isInteger()) {
        this.error(switchTok, `switch expression must have integer type, got '${expr.type.toString()}'`);
      }
      this.expect(")");
      // Body parses with `_inSwitch = true` so `case`/`default` labels
      // are accepted (they are SCase nodes in the body's statement list).
      // `_switchSeen` tracks case values + default within the enclosing
      // switch so we can diagnose duplicates. Nested switches save/restore.
      const savedInSwitch = this._inSwitch;
      const savedSeen = this._switchSeen;
      this._inSwitch = true;
      this._switchSeen = { values: new Map(), hasDefault: false };
      const body = this.parseStatement();
      this._inSwitch = savedInSwitch;
      this._switchSeen = savedSeen;
      return new AST.SSwitch(loc, expr, body);
    }

    // case — emits an SCase node and returns it. The next statement
    // in the enclosing compound is the case's target (same pattern
    // as SLabel for goto labels). Multiple cases for one target
    // (`case 1: case 2: foo();`) produce consecutive SCase nodes.
    if (this.matchKW(Lexer.Keyword.CASE)) {
      const caseTok = this.peek(-1);
      const caseExpr = this.parseAssignmentExpression();
      const loVal = constEvalInt(caseExpr);
      if (loVal === null) {
        this.error(caseTok, "case label must be an integer constant expression");
      }
      let lo = loVal ?? 0n;
      let hi = lo;
      // GNU case range extension: case low ... high:
      if (this.atText("...")) {
        this.advance();
        const highExpr = this.parseAssignmentExpression();
        const hiVal = constEvalInt(highExpr);
        if (hiVal === null) {
          this.error(caseTok, "case range upper bound must be an integer constant expression");
        }
        hi = hiVal ?? lo;
        if (hi < lo) {
          this.error(caseTok, `case range is empty (${lo} > ${hi})`);
        }
      }
      this.expect(":");
      if (!this._inSwitch) {
        this.error(caseTok, "'case' label not within a switch statement");
      } else if (loVal !== null) {
        // Duplicate-case detection. For ranges we enumerate up to a cap
        // so we don't blow memory on `case 0 ... 0xFFFFFFFFFFFFFFFF:`;
        // beyond the cap we skip the check (codegen still works).
        const span = hi - lo;
        if (span <= 1024n) {
          for (let v = lo; v <= hi; v++) {
            const key = String(v);
            if (this._switchSeen.values.has(key)) {
              this.error(caseTok, `duplicate case label value ${v}`);
              break;
            }
            this._switchSeen.values.set(key, caseTok);
          }
        }
      }
      return new AST.SCase(loc, lo, hi, false);
    }

    // default — same idea as case.
    if (this.matchKW(Lexer.Keyword.DEFAULT)) {
      const defTok = this.peek(-1);
      this.expect(":");
      if (!this._inSwitch) {
        this.error(defTok, "'default' label not within a switch statement");
      } else {
        if (this._switchSeen.hasDefault) {
          this.error(defTok, "duplicate 'default' label in switch");
        }
        this._switchSeen.hasDefault = true;
      }
      return new AST.SCase(loc, 0n, 0n, true);
    }

    // break
    if (this.matchKW(Lexer.Keyword.BREAK)) { this.expect(";"); return new AST.SBreak(loc); }

    // continue
    if (this.matchKW(Lexer.Keyword.CONTINUE)) { this.expect(";"); return new AST.SContinue(loc); }

    // return
    if (this.matchKW(Lexer.Keyword.RETURN)) {
      const retType = this.currentParsingFunc?.type.getReturnType() || null;
      if (this.matchText(";")) return AST.makeReturn(loc, null, retType);
      const expr = this.parseExpression();
      this.expect(";");
      return AST.makeReturn(loc, expr, retType);
    }

    // goto
    if (this.matchKW(Lexer.Keyword.GOTO)) {
      const tok = this.expectKind(Lexer.TokenKind.IDENT);
      const label = tok.text;
      this.expect(";");
      const sg = new AST.SGoto(Lexer.Loc.fromTok(tok), label);
      if (this.parsedLabels.has(label)) {
        // Backward goto — label already defined.
        const target = this.parsedLabels.get(label);
        // Promote labelKind based on what's already there:
        //   FORWARD (with prior forward gotos)         → BOTH
        //   BOTH    (already had both kinds)           → BOTH (stays)
        //   FORWARD (constructor default, no prior gotos) → LOOP
        //   LOOP    (already had only backward gotos)  → LOOP (stays)
        // The hasGotos check distinguishes "FORWARD because forward gotos
        // were resolved" from "FORWARD because that's just the default."
        if (target.hasGotos && target.labelKind === Types.LabelKind.FORWARD) {
          target.labelKind = Types.LabelKind.BOTH;
        } else if (target.labelKind !== Types.LabelKind.BOTH) {
          target.labelKind = Types.LabelKind.LOOP;
        }
        target.hasGotos = true;
        sg.target = target;
      } else {
        // Forward goto — label not yet seen
        if (!this.pendingGotos.has(label)) this.pendingGotos.set(label, []);
        this.pendingGotos.get(label).push(sg);
      }
      return sg;
    }

    // label: statement
    if (this.atKind(Lexer.TokenKind.IDENT) && this.peek(1)?.text === ":") {
      const labelTok = this.peek();
      const name = this.advance().text;
      this.advance(); // skip :
      if (this.parsedLabels.has(name)) {
        this.error(this.peek(-2), `Duplicate label '${name}'`);
      }
      const sl = new AST.SLabel(Lexer.Loc.fromTok(labelTok), name, this.currentCompound);
      this.parsedLabels.set(name, sl);
      if (this.currentCompound) {
        if (!this.currentCompound.labels) this.currentCompound.labels = [];
        this.currentCompound.labels.push(sl);
      }
      // Resolve pending forward gotos
      if (this.pendingGotos.has(name)) {
        sl.labelKind = Types.LabelKind.FORWARD;
        sl.hasGotos = true;
        for (const sg of this.pendingGotos.get(name)) {
          sg.target = sl;
        }
        this.pendingGotos.delete(name);
      }
      return sl;
    }

    // __try/__catch
    if (this.matchKW(Lexer.Keyword.X_TRY)) {
      const tryBody = this.parseCompoundStatement();
      const catches = [];
      while (this.matchKW(Lexer.Keyword.X_CATCH)) {
        if (this.atText("{")) {
          // catch_all
          const body = this.parseCompoundStatement();
          catches.push({ tag: null, bindings: [], body });
        } else {
          // __catch TagName(binding1, binding2) { ... }
          const tagName = this.expectKind(Lexer.TokenKind.IDENT).text;
          const tag = this.findExceptionTag(tagName);
          this.expect("(");
          const bindings = [];
          if (!this.atText(")")) {
            bindings.push(this.expectKind(Lexer.TokenKind.IDENT).text);
            while (this.matchText(",")) {
              bindings.push(this.expectKind(Lexer.TokenKind.IDENT).text);
            }
          }
          this.expect(")");
          // Push scope and register binding variables
          this.typeScope.push(); this.tagScope.push(); this.varScope.push();
          const bindingVars = [];
          for (let i = 0; i < bindings.length; i++) {
            const paramType = (tag && tag.paramTypes && i < tag.paramTypes.length) ? tag.paramTypes[i] : Types.TINT;
            const bvar = new AST.DVar({ filename: this.peek().filename, line: this.peek().line },
              bindings[i], paramType, Types.StorageClass.NONE, null);
            bvar.definition = bvar;
            this.varScope.set(bindings[i], bvar);
            bindingVars.push(bvar);
          }
          const body = this.parseCompoundStatement();
          this.typeScope.pop(); this.tagScope.pop(); this.varScope.pop();
          catches.push({ tag, bindings, bindingVars, body });
        }
      }
      if (catches.length === 0) {
        this.error(this.peek(), "__try without any __catch clauses");
      }
      for (let i = 0; i < catches.length - 1; i++) {
        if (!catches[i].tag) {
          this.error(this.peek(), "catch-all (__catch without type) must be the last catch clause");
        }
      }
      return new AST.STryCatch(loc, tryBody, catches);
    }

    // __throw
    if (this.matchKW(Lexer.Keyword.X_THROW)) {
      const throwTok = this.peek(-1);
      const tagName = this.expectKind(Lexer.TokenKind.IDENT).text;
      this.expect("(");
      const args = [];
      if (!this.atText(")")) {
        args.push(this.parseAssignmentExpression());
        while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      }
      this.expect(")");
      this.expect(";");
      // Decay array/function-typed throw args; tag params are pointer types.
      for (let i = 0; i < args.length; i++) args[i] = maybeDecay(args[i]);
      let tag = this.findExceptionTag(tagName);
      if (!tag) {
        // Recovery: synthesize a placeholder tag with divergent param
        // types so SThrow has the uniform tag shape downstream code
        // expects.
        this.recoverableError(throwTok, `Unknown exception tag '${tagName}'`);
        tag = new AST.DExceptionTag(Lexer.Loc.fromTok(throwTok), tagName,
          args.map(() => Types.TDIVERGENT));
        tag.definition = tag;
      }
      // Insert implicit casts on args matching the tag's parameter types.
      for (let i = 0; i < args.length && i < tag.paramTypes.length; i++) {
        args[i] = maybeImplicitCast(args[i], tag.paramTypes[i]);
      }
      return new AST.SThrow(loc, tag, args);
    }

    // _Static_assert inside function body
    if (this.matchKW(Lexer.Keyword.STATIC_ASSERT)) {
      this.expect("(");
      const condExpr = this.parseAssignmentExpression();
      let msg = "";
      if (this.matchText(",")) {
        const msgTok = this.expectKind(Lexer.TokenKind.STRING);
        msg = msgTok.text.replace(/^"(.*)"$/, '$1');
      }
      this.expect(")");
      this.expect(";");
      const val = constEvalInt(condExpr);
      if (val === 0n) this.recoverableError(this.peek(-1) || this.peek(), `_Static_assert failed: ${msg}`);
      return new AST.SCompound(loc, []);
    }

    // Declaration statement
    if (this.isTypeName()) {
      return this.parseDeclarationStatement();
    }

    // Expression statement
    const expr = this.parseExpression();
    this.expect(";");
    return new AST.SExpr(loc, expr);
  }

  findExceptionTag(name) {
    for (const tag of this.parsedExceptionTags) {
      if (tag.name === name) return tag;
    }
    return null;
  }

  parseCompoundStatement() {
    const startTok = this.peek();
    this.expect("{");
    this.typeScope.push(); this.tagScope.push(); this.varScope.push();
    const statements = [];
    const compound = new AST.SCompound(Lexer.Loc.fromTok(startTok), statements);
    const savedCompound = this.currentCompound;
    this.currentCompound = compound;
    while (!this.atEnd() && !this.atText("}")) {
      const stmt = this.parseStatement();
      statements.push(stmt);
    }
    this.currentCompound = savedCompound;
    this.expect("}");
    this.typeScope.pop(); this.tagScope.pop(); this.varScope.pop();
    return compound;
  }

  parseDeclarationStatement() {
    const startTok = this.peek();
    const startLoc = Lexer.Loc.fromTok(startTok);
    const declarations = [];
    const specs = this.parseDeclSpecifiers();
    let baseType = specs.type;

    if (this.matchText(";")) {
      // Anonymous struct/union/enum declaration
      return new AST.SDecl(startLoc, declarations);
    }

    let first = true;
    while (!this.atEnd()) {
      if (!first) { if (!this.matchText(",")) break; }
      first = false;

      const declTok = this.peek();
      const decl = this.parseDeclarator(baseType, specs.storageClass === Types.StorageClass.TYPEDEF);
      let type = decl.type;
      const name = decl.name || "__unnamed";

      // Parse __attribute__ after declarator
      const localAttrs = this.parseGCCAttributes();
      if (localAttrs.aligned > 0 && specs.requestedAlignment < localAttrs.aligned) {
        specs.requestedAlignment = localAttrs.aligned;
      }

      if (specs.storageClass === Types.StorageClass.TYPEDEF) {
        if (specs.requestedAlignment > 0) {
          this.error(this.peek(-1), "_Alignas cannot be applied to a typedef");
        }
        const prevType = this.typeScope.getInCurrentScope(name);
        if (prevType && prevType.removeQualifiers() !== type.removeQualifiers()) {
          this.error(this.peek(), `redefinition of typedef '${name}'`);
        }
        this.typeScope.set(name, type);
        if (this.matchText(";")) return new AST.SDecl(startLoc, declarations);
        continue;
      }

      // Reject heap-form GC struct types in value-position slots.
      Types.validateNoHeapInValueType(type, msg => this.error(this.peek(), msg));

      // Local extern function declaration (e.g. extern int f(void);)
      if (type.isFunction()) {
        if (specs.requestedAlignment > 0) {
          this.error(this.peek(-1), "_Alignas cannot be applied to a function declaration");
        }
        const funcDecl = new AST.DFunc({ filename: this.peek().filename, line: this.peek().line },
          name, type, [], specs.storageClass, false, null);
        funcDecl.importModule = specs.importModule;
        funcDecl.importName = specs.importName;
        this.varScope.set(name, funcDecl);
        if (this.currentParsingFunc) {
          this.currentParsingFunc.externLocalFuncs.push(funcDecl);
        }
        // Don't include in declaration statement (diverted like C++ does)
        continue;
      }

      const dvar = new AST.DVar({ filename: this.peek().filename, line: this.peek().line },
        name, type, specs.storageClass, null);
      if (specs.requestedAlignment > 0) {
        if (specs.storageClass === Types.StorageClass.REGISTER) {
          this.error(this.peek(-1), "_Alignas cannot be applied to a register variable");
        }
        if (specs.requestedAlignment < (type.align || 1)) {
          this.error(this.peek(), `_Alignas cannot reduce alignment below natural alignment of type '${type.toString()}'`);
        }
        dvar.requestedAlignment = specs.requestedAlignment;
      }
      // Local non-extern variables are always definitions
      if (specs.storageClass !== Types.StorageClass.EXTERN) dvar.definition = dvar;

      // Set allocClass
      if (type.isAggregate()) dvar.allocClass = Types.AllocClass.MEMORY;
      else if (specs.storageClass === Types.StorageClass.EXTERN) dvar.allocClass = Types.AllocClass.MEMORY;

      // Add to scope before parsing initializer (C11 §6.2.1p7: scope begins
      // after the declarator, so sizeof(*p) in `T *p = malloc(sizeof(*p))` is valid).
      this.varScope.set(name, dvar);

      // Parse initializer
      if (this.matchText("=")) {
        const eqTok = this.peek(-1);
        if (this.atText("{")) {
          if (baseType === Types.TAUTO) {
            this.error(declTok, `'auto ${name}' cannot be initialized from a braced initializer list`);
          }
          dvar.initExpr = this.parseInitList(type);
        } else {
          dvar.initExpr = this.parseAssignmentExpression();
          // C23 `auto`: infer type from init before applying any other checks.
          if (baseType === Types.TAUTO) {
            type = this._resolveAuto(baseType, type, name, dvar.initExpr, declTok);
            dvar.type = type;
            // Re-evaluate allocClass: aggregates need MEMORY storage.
            if (type.isAggregate()) dvar.allocClass = Types.AllocClass.MEMORY;
          }
        }
        // Handle string-initialized char array
        if (type.isArray() && type.arraySize === 0 && dvar.initExpr &&
            dvar.initExpr instanceof AST.EString) {
          type = dvar.initExpr.type;
          dvar.type = type;
        }
        // Normalize init list
        if (dvar.initExpr && dvar.initExpr instanceof AST.EInitList) {
          if (type.isArray() && type.arraySize === 0) {
            dvar.initExpr = normalizeInitList(dvar.initExpr, type);
            type = dvar.initExpr.type;
            dvar.type = type;
          } else if (type.isAggregate()) {
            dvar.initExpr = normalizeInitList(dvar.initExpr, type);
          }
        }
        // Insert an implicit cast for scalar inits whose source type
        // doesn't match the declared type. Aggregate / EInitList inits
        // handle conversion per-element via normalizeInitList.
        if (dvar.initExpr && !type.isAggregate() &&
            !(dvar.initExpr instanceof AST.EInitList)) {
          // Initializing a pointer from an array/function decays first.
          if (type.isPointer()) dvar.initExpr = maybeDecay(dvar.initExpr);
          dvar.initExpr = maybeImplicitCast(dvar.initExpr, type);
        }
      }

      // Catch `auto x;` (no initializer).
      if (baseType === Types.TAUTO && dvar.type === Types.TAUTO) {
        this.error(declTok, `'auto ${name}' requires an initializer`);
        dvar.type = Types.TINT;
      }

      // Divert static/extern locals: treat them as globals for allocation/linking
      if (this.currentParsingFunc) {
        if (specs.storageClass === Types.StorageClass.STATIC) {
          this.currentParsingFunc.staticLocals.push(dvar);
          // Don't include in declaration statement
        } else if (specs.storageClass === Types.StorageClass.EXTERN) {
          this.currentParsingFunc.externLocals.push(dvar);
        } else {
          declarations.push(dvar);
        }
      } else {
        declarations.push(dvar);
      }
    }
    this.expect(";");
    return new AST.SDecl(startLoc, declarations);
  }

  // --- External declaration parsing ---

  parseExternalDeclaration(unit) {
    const loc = Lexer.Loc.fromTok(this.peek());
    // Empty declaration: a bare `;` at file scope. C2x makes this
    // standard; GCC and clang accept it in C99/C11 as an extension. We
    // accept it silently so projects that use `MACRO;` where MACRO
    // expands to empty (e.g. SQLite's SQLITE_EXTENSION_INIT1 inside the
    // amalgamated shell.c) compile cleanly.
    if (this.matchText(";")) return;
    const specs = this.parseDeclSpecifiers();
    let baseType = specs.type;

    // Handle bare tag declaration: struct Foo { ... };
    if (this.matchText(";")) return;

    if (baseType === Types.TAUTO) {
      this.error(this.peek(), "'auto' type inference is only supported at function scope");
    }

    let first = true;
    while (true) {
      if (!first) { if (!this.matchText(",")) break; }
      first = false;

      const decl = this.parseDeclarator(baseType, specs.storageClass === Types.StorageClass.TYPEDEF);
      let type = decl.type;
      const name = decl.name || "__unnamed";

      // Parse __attribute__ after declarator
      const declAttrs = this.parseGCCAttributes();
      if (declAttrs.aligned > 0 && specs.requestedAlignment < declAttrs.aligned) {
        specs.requestedAlignment = declAttrs.aligned;
      }

      if (specs.storageClass === Types.StorageClass.TYPEDEF) {
        if (specs.requestedAlignment > 0) {
          this.error(this.peek(-1), "_Alignas cannot be applied to a typedef");
        }
        const prevType = this.typeScope.get(name);
        if (prevType && prevType.removeQualifiers() !== type.removeQualifiers()) {
          this.error(this.peek(), `redefinition of typedef '${name}'`);
        }
        this.typeScope.set(name, type);
        continue;
      }

      // Reject heap-form GC struct types at any value-position slot of the
      // declared variable / function (return type, params).
      Types.validateNoHeapInValueType(type, msg => this.error(this.peek(), msg));

      // K&R parameter declarations: parse type declarations between ')' and '{'
      if (decl._isKnR && type.isFunction() &&
          !this.atText("{") && !this.atText(";") && !this.atText(",")) {
        const knrParamNames = decl._paramNames || [];
        const knrParamTypes = [...(type.paramTypes || [])];
        while (!this.atText("{") && !this.atEnd()) {
          const pSpecs = this.parseDeclSpecifiers();
          do {
            const pDecl = this.parseDeclarator(pSpecs.type);
            const finalType = pDecl.type.decay();
            const idx = knrParamNames.indexOf(pDecl.name);
            if (idx >= 0) knrParamTypes[idx] = finalType;
          } while (this.matchText(","));
          this.expect(";");
        }
        type = Types.functionType(type.returnType, knrParamTypes, type.isVarArg, false);
        decl.type = type;
      }

      // For functions: every GC struct/array referenced in the signature must
      // be complete. WASM function signatures need a concrete type idx, and
      // there's no way to encode `(ref null incomplete)`. Recurse through
      // pointer/array/function types so a typedef like
      //   typedef __struct Foo *(*Fp)(int); Fp get_fp(void);
      // also gets caught when Foo is incomplete.
      if (type.isFunction()) {
        const seen = new Set();
        const checkComplete = (t) => {
          if (!t || seen.has(t)) return;
          seen.add(t);
          const u = t.removeQualifiers();
          if (u.isGCStruct() && !u.isComplete) {
            this.error(this.peek(), `function '${name}' references incomplete GC struct '${u.tagName}' in its signature; define '${u.tagName}' first`);
          }
          if (u.isPointer() || u.isArray()) checkComplete(u.baseType);
          else if (u.isGCArray()) checkComplete(u.baseType);
          else if (u.isFunction()) {
            checkComplete(u.returnType);
            for (const pt of (u.paramTypes || [])) checkComplete(pt);
          }
        };
        checkComplete(type.returnType);
        for (const pt of (type.paramTypes || [])) checkComplete(pt);
      }

      // Check if this is a function definition
      if (type.isFunction() && this.atText("{")) {
        if (specs.requestedAlignment > 0) {
          this.error(this.peek(-1), "_Alignas cannot be applied to a function declaration");
        }
        const funcDecl = new AST.DFunc(loc, name, type,
          [], specs.storageClass, specs.isInline, null);
        funcDecl.importModule = specs.importModule;
        funcDecl.importName = specs.importName;

        // Update previous declaration's definition pointer
        const prev = this.varScope.get(name);
        if (prev && prev instanceof AST.DFunc) {
          if (!prev.type.isCompatibleWith(funcDecl.type)) {
            this.error(this.peek(), `conflicting types for '${name}' (previously declared as '${prev.type.toString()}', now defined as '${funcDecl.type.toString()}')`);
          }
          prev.definition = funcDecl;
        }

        // Register function in scope before pushing param scope (so it persists globally)
        this.varScope.set(name, funcDecl);

        // Push scope for parameters
        this.typeScope.push(); this.tagScope.push(); this.varScope.push();
        const paramTypes = type.paramTypes || [];
        const params = [];
        if (decl._paramNames) {
          for (let i = 0; i < decl._paramNames.length; i++) {
            const pname = decl._paramNames[i] || ("__param" + i);
            const ptype = i < paramTypes.length ? paramTypes[i] : Types.TINT;
            const pvar = new AST.DVar(loc, pname, ptype, Types.StorageClass.AUTO, null);
            if (ptype.isAggregate()) pvar.allocClass = Types.AllocClass.MEMORY;
            pvar.definition = pvar; // parameters are always definitions
            params.push(pvar);
            this.varScope.set(pname, pvar);
          }
        } else {
          // No param names available (abstract declarator)
          for (let i = 0; i < paramTypes.length; i++) {
            const pvar = new AST.DVar(loc, "__param" + i, paramTypes[i], Types.StorageClass.AUTO, null);
            if (paramTypes[i].isAggregate()) pvar.allocClass = Types.AllocClass.MEMORY;
            pvar.definition = pvar; // parameters are always definitions
            params.push(pvar);
          }
        }
        funcDecl.parameters = params;

        const savedFunc = this.currentParsingFunc;
        this.currentParsingFunc = funcDecl;
        this.parsedLabels.clear();
        this.pendingGotos.clear();

        funcDecl.body = this.parseCompoundStatement();

        // Check for unresolved gotos
        for (const [name] of this.pendingGotos) {
          this.recoverableError(this.peek(), `Undefined label '${name}'`);
        }
        this.pendingGotos.clear();
        this.parsedLabels.clear();
        this.currentParsingFunc = savedFunc;
        this.typeScope.pop(); this.tagScope.pop(); this.varScope.pop();

        // Categorize
        if (specs.storageClass === Types.StorageClass.IMPORT) unit.importedFunctions.push(funcDecl);
        else if (specs.storageClass === Types.StorageClass.STATIC) unit.staticFunctions.push(funcDecl);
        else unit.definedFunctions.push(funcDecl);

        // Move extern locals to unit
        for (const v of funcDecl.externLocals) unit.localExternVariables.push(v);
        for (const f of funcDecl.externLocalFuncs) unit.localDeclaredFunctions.push(f);

        return; // function definition ends the declarator list
      }

      // Function declaration (no body)
      if (type.isFunction()) {
        if (specs.requestedAlignment > 0) {
          this.error(this.peek(-1), "_Alignas cannot be applied to a function declaration");
        }
        const funcDecl = new AST.DFunc(loc, name, type,
          [], specs.storageClass, specs.isInline, null);
        funcDecl.importModule = specs.importModule;
        funcDecl.importName = specs.importName;

        // Build parameter list
        const paramTypes = type.paramTypes || [];
        if (decl._paramNames) {
          for (let i = 0; i < decl._paramNames.length; i++) {
            const pname = decl._paramNames[i] || ("__param" + i);
            const ptype = i < paramTypes.length ? paramTypes[i] : Types.TINT;
            const pvar = new AST.DVar(loc, pname, ptype, Types.StorageClass.AUTO, null);
            if (ptype.isAggregate()) pvar.allocClass = Types.AllocClass.MEMORY;
            funcDecl.parameters.push(pvar);
          }
        } else {
          for (let i = 0; i < paramTypes.length; i++) {
            const pvar = new AST.DVar(loc, "__param" + i, paramTypes[i], Types.StorageClass.AUTO, null);
            if (paramTypes[i].isAggregate()) pvar.allocClass = Types.AllocClass.MEMORY;
            funcDecl.parameters.push(pvar);
          }
        }

        const prevFunc = this.varScope.get(name);
        if (prevFunc && prevFunc instanceof AST.DFunc && !prevFunc.type.isCompatibleWith(funcDecl.type)) {
          this.error(this.peek(), `conflicting types for '${name}' (previously declared as '${prevFunc.type.toString()}', now declared as '${funcDecl.type.toString()}')`);
        }
        // Plain re-declaration of an existing import: keep the original
        // import decl in scope. Otherwise the new EXTERN would shadow
        // it, all callers would bind to the new node, and the per-TU
        // tree-shake would drop the import as unreached (it isn't —
        // the callers just point at its replacement). Example: SQLite's
        // shell.c writes `extern int isatty(int);` after <unistd.h>
        // already provided `__import int isatty(int);`.
        if (prevFunc && prevFunc instanceof AST.DFunc &&
            prevFunc.storageClass === Types.StorageClass.IMPORT &&
            specs.storageClass !== Types.StorageClass.IMPORT &&
            specs.storageClass !== Types.StorageClass.STATIC) {
          continue;  // drop redundant re-declaration, keep import binding
        }
        this.varScope.replace(name, funcDecl);
        if (specs.storageClass === Types.StorageClass.IMPORT) unit.importedFunctions.push(funcDecl);
        else unit.declaredFunctions.push(funcDecl);
        continue;
      }

      // Variable declaration
      const dvar = new AST.DVar(loc, name, type, specs.storageClass, null);
      // Check for conflicting variable declarations
      const prevVar = this.varScope.get(name);
      if (prevVar && prevVar instanceof AST.DVar && !prevVar.type.isCompatibleWith(type)) {
        this.error(this.peek(), `conflicting types for '${name}' (previously declared as '${prevVar.type.toString()}', now declared as '${type.toString()}')`);
      }
      if (specs.requestedAlignment > 0) {
        if (specs.requestedAlignment < (type.align || 1)) {
          this.error(this.peek(), `_Alignas cannot reduce alignment below natural alignment of type '${type.toString()}'`);
        }
        dvar.requestedAlignment = specs.requestedAlignment;
      }
      if (type.isAggregate() || type.isArray()) dvar.allocClass = Types.AllocClass.MEMORY;
      else if (specs.storageClass === Types.StorageClass.EXTERN) dvar.allocClass = Types.AllocClass.MEMORY;

      if (this.matchText("=")) {
        const eqTok = this.peek(-1);
        if (this.atText("{")) {
          dvar.initExpr = this.parseInitList(type);
        } else {
          dvar.initExpr = this.parseAssignmentExpression();
          // File-scope ref-typed globals: WASM constant init expressions
          // can only emit ref.null. Allocation (e.g. boxing a primitive)
          // is not allowed at module-init time.
          if (type.removeQualifiers().isRef() && !AST.isNullPointerConstant(dvar.initExpr) &&
              !dvar.initExpr.type.removeQualifiers().isRef()) {
            this.error(eqTok,
              `global '${name}': reference-typed globals can only be initialized to null/0 ` +
              `(WASM constant init expressions can't allocate); set the value in main() or a startup function`);
          }
        }
        // Handle string-initialized char array
        if (type.isArray() && type.arraySize === 0 && dvar.initExpr &&
            dvar.initExpr instanceof AST.EString) {
          type = Types.arrayOf(type.baseType, dvar.initExpr.type.arraySize);
          dvar.type = type;
        }
        // Normalize init list
        if (dvar.initExpr && dvar.initExpr instanceof AST.EInitList) {
          if (type.isArray() && type.arraySize === 0) {
            dvar.initExpr = normalizeInitList(dvar.initExpr, type);
            type = dvar.initExpr.type;
            dvar.type = type;
          } else if (type.isAggregate()) {
            dvar.initExpr = normalizeInitList(dvar.initExpr, type);
          }
        }
        // Insert an implicit cast for scalar inits whose source type
        // doesn't match the declared type. Aggregate / EInitList inits
        // handle conversion per-element via normalizeInitList.
        if (dvar.initExpr && !type.isAggregate() &&
            !(dvar.initExpr instanceof AST.EInitList)) {
          // Initializing a pointer from an array/function decays first.
          if (type.isPointer()) dvar.initExpr = maybeDecay(dvar.initExpr);
          dvar.initExpr = maybeImplicitCast(dvar.initExpr, type);
        }
      }

      // Check for previous declaration and update scope
      const prevDecl = this.varScope.get(name);
      if (prevDecl && prevDecl instanceof AST.DVar && specs.storageClass !== Types.StorageClass.EXTERN) {
        prevDecl.definition = dvar;
      }
      // Use replace to update the scope entry (varScope.set fails if name already exists)
      this.varScope.replace(name, dvar);
      if (specs.storageClass === Types.StorageClass.EXTERN) unit.externVariables.push(dvar);
      else unit.definedVariables.push(dvar);
    }
    this.expect(";");
  }

  // Override parseDeclarator to capture param names for functions
  parseDeclarator(baseType, isTypedef) {
    let type = baseType;
    let ptrCount = 0;
    while (this.matchText("*")) {
      const starTok = this.peek(-1);
      // GC arrays don't take the `*` sugar — there's no C "pointer to array"
      // idiom to mirror. Reject it explicitly so users use `__array(T)` directly.
      if (type.isGCArray()) {
        this.error(starTok, `'__array(...)' types do not take a '*' — write '__array(T) name' (the array is already a reference)`);
      }
      // Double-`*` on a GC struct (`__struct Foo **`) — wasm has no `(ref ref T)`.
      if (type.isGCStruct()) {
        this.error(starTok, `'${type.toString()}' is already a reference; '__struct Foo **' is not allowed`);
        break;
      }
      ptrCount++;
      type = type.pointer();
      while (true) {
        if (this.matchKW(Lexer.Keyword.CONST)) { type = type.addConst(); continue; }
        if (this.matchKW(Lexer.Keyword.VOLATILE)) { type = type.addVolatile(); continue; }
        if (this.matchKW(Lexer.Keyword.RESTRICT)) continue;
        break;
      }
    }
    let name = null;
    let paramNames = null;

    // Parenthesized declarator: int (*fp)(...)
    if (this.atText("(") && !this.isStartOfParamList()) {
      this.advance();
      const saved = type;
      const inner = this.parseDeclarator(type);
      this.expect(")");
      type = this.parseDeclaratorSuffixWithNames(saved);
      const combined = this.combineDeclaratorTypes(inner.type, saved, type.type, inner._ptrCount);
      return { type: combined, name: inner.name, _paramNames: inner._paramNames || type._paramNames, _isKnR: inner._isKnR || type._isKnR, _ptrCount: ptrCount };
    }

    if (this.atKind(Lexer.TokenKind.IDENT)) {
      name = this.advance().text;
    }

    const suffix = this.parseDeclaratorSuffixWithNames(type);
    return { type: suffix.type, name, _paramNames: suffix._paramNames, _isKnR: suffix._isKnR, _ptrCount: ptrCount };
  }

  parseDeclaratorSuffixWithNames(type) {
    let paramNames = null;
    let isKnRResult = false;
    while (true) {
      if (this.atText("[")) {
        // Collect all consecutive array dimensions and apply in REVERSE order
        // because C's int arr[2][3] means array of 2 elements, each being int[3]
        const arrayDims = [];
        while (this.matchText("[")) {
          let size = 0;
          if (!this.atText("]")) {
            const sizeExpr = this.parseAssignmentExpression();
            size = Number(constEvalInt(sizeExpr) ?? 0n);
          }
          this.expect("]");
          arrayDims.push(size);
        }
        if (type.removeQualifiers().isRef()) {
          this.error(this.peek(-1),
            `cannot have a C array of reference type '${type.toString()}' (refs live on the GC heap, not in linear memory) — use __array(${type.toString()}) instead`);
        }
        for (let i = arrayDims.length - 1; i >= 0; i--) {
          type = Types.arrayOf(type, arrayDims[i]);
        }
        continue;
      }
      if (this.matchText("(")) {
        const params = [];
        const pNames = [];
        let isVarArg = false;
        let hasUnspecifiedParams = false;
        let isKnR = false;
        if (this.atText(")")) {
          hasUnspecifiedParams = true; // f() means unspecified params
        } else if (this.atKW(Lexer.Keyword.VOID) && this.peek(1)?.text === ")") {
          this.advance(); // f(void) means zero params
        } else if (this._allowKnRDefinitions &&
                   this.peek().kind === Lexer.TokenKind.IDENT && !this.isTypeName() &&
                   (this.peek(1)?.text === "," || this.peek(1)?.text === ")")) {
          // K&R identifier list: f(a, b, c)
          isKnR = true;
          while (this.peek().kind === Lexer.TokenKind.IDENT) {
            const pName = this.advance().text;
            params.push(Types.TINT); // placeholder
            pNames.push(pName);
            if (!this.matchText(",")) break;
          }
        } else {
            while (true) {
              if (this.matchText("...")) { isVarArg = true; break; }
              const pSpecs = this.parseDeclSpecifiers();
              let pType = pSpecs.type;
              // C11 6.7.5p2: _Alignas shall not be specified in a declaration of a parameter
              if (pSpecs.requestedAlignment > 0) {
                this.error(this.peek(-1), "_Alignas cannot be applied to a function parameter");
              }
              // Parse parameter declarator
              let pName = null;
              // Handle pointer prefix. Qualifiers after `*` apply to the
              // pointer itself: `T *const` is a const pointer to T.
              while (this.matchText("*")) {
                const starTok = this.peek(-1);
                if (pType.isGCArray()) {
                  this.error(starTok, `'__array(...)' types do not take a '*' — write '__array(T) name' (the array is already a reference)`);
                }
                if (pType.isGCStruct()) {
                  this.error(starTok, `'${pType.toString()}' is already a reference; '__struct Foo **' is not allowed`);
                  break;
                }
                pType = pType.pointer();
                while (true) {
                  if (this.matchKW(Lexer.Keyword.CONST)) pType = pType.addConst();
                  else if (this.matchKW(Lexer.Keyword.VOLATILE)) pType = pType.toggleVolatile();
                  else if (this.matchKW(Lexer.Keyword.RESTRICT)) { /* restrict is a hint; we don't model it */ }
                  else break;
                }
              }
              // Handle parenthesized: void (*callback)(...)
              if (this.atText("(") && !this.isStartOfParamList()) {
                const inner = this.parseDeclarator(pType);
                pType = inner.type;
                pName = inner.name;
              } else {
                if (this.atKind(Lexer.TokenKind.IDENT)) pName = this.advance().text;
                // Array suffix on param -> first dim decays to pointer, rest are arrays
                if (this.atText("[")) {
                  if (pType.removeQualifiers().isRef()) {
                    this.error(this.peek(),
                      `cannot have a C array of reference type '${pType.toString()}' (refs live on the GC heap, not in linear memory) — use __array(${pType.toString()}) instead`);
                  }
                  const arrayDims = [];
                  let firstDim = true;
                  while (this.matchText("[")) {
                    if (firstDim) {
                      // C99: skip 'static' and qualifiers inside first array bracket
                      this.matchKW(Lexer.Keyword.STATIC);
                      while (this.matchKW(Lexer.Keyword.CONST) || this.matchKW(Lexer.Keyword.VOLATILE) || this.matchKW(Lexer.Keyword.RESTRICT)) {}
                      this.matchKW(Lexer.Keyword.STATIC);
                    }
                    let arrSize = 0;
                    if (!this.atText("]")) {
                      const se = this.parseAssignmentExpression();
                      arrSize = Number(constEvalInt(se) ?? 0n);
                    }
                    this.expect("]");
                    if (firstDim) {
                      firstDim = false;
                      arrayDims.push(-1); // sentinel: first dim decays to pointer
                    } else {
                      arrayDims.push(arrSize);
                    }
                  }
                  // Build type from inner to outer (reverse), then decay first to pointer
                  for (let i = arrayDims.length - 1; i >= 1; i--) {
                    pType = Types.arrayOf(pType, arrayDims[i]);
                  }
                  pType = pType.pointer(); // first dim decays to pointer
                }
                // Function suffix on param -> decay to pointer
                if (this.atText("(")) {
                  pType = this.parseDeclaratorSuffixWithNames(pType).type;
                  pType = pType.pointer(); // func params decay to func pointers
                }
              }
              params.push(pType.decay());
              pNames.push(pName);
              if (!this.matchText(",")) break;
            }
        }
        this.expect(")");
        type = Types.functionType(type, params, isVarArg, hasUnspecifiedParams);
        paramNames = pNames;
        isKnRResult = isKnR;
        continue;
      }
      break;
    }
    return { type, _paramNames: paramNames, _isKnR: isKnRResult };
  }
}

// ====================
// Parser — Entry Point
// ====================

function parseTokens(tokens, options) {
  const sink = { errors: [], warnings: [] };

  if (tokens.length === 0) {
    sink.errors.push(new Lexer.LexError("No tokens to parse", null, 0));
    return { translationUnit: AST.makeTUnit(null), errors: sink.errors, warnings: sink.warnings };
  }

  const unit = AST.makeTUnit(tokens[0].filename);
  const parser = new Parser(tokens, sink.errors, sink.warnings);
  if (options?.warningFlags) parser.warningFlags = options.warningFlags;
  if (options?.compilerOptions?.allowImplicitInt) parser._allowImplicitInt = true;
  if (options?.compilerOptions?.allowKnRDefinitions) parser._allowKnRDefinitions = true;
  if (options?.compilerOptions?.allowImplicitFunctionDecl) parser._allowImplicitFunctionDecl = true;
  if (options?.exceptionTagRegistry) parser._exceptionTagRegistry = options.exceptionTagRegistry;

  withDiag(sink, () => {
  try {
    while (!parser.atEnd()) {
      // __require_source
      if (parser.atKW(Lexer.Keyword.X_REQUIRE_SOURCE)) {
        parser.advance();
        parser.expect("(");
        const tok = parser.expectKind(Lexer.TokenKind.STRING);
        const filename = tok.text.substring(1, tok.text.length - 1);
        parser.requiredSources.add(filename);
        parser.expect(")");
        parser.expect(";");
        continue;
      }
      // __minstack
      if (parser.atKW(Lexer.Keyword.X_MINSTACK)) {
        parser.advance();
        parser.expect("(");
        const sizeExpr = parser.parseAssignmentExpression();
        parser.expect(")");
        parser.expect(";");
        const val = constEvalInt(sizeExpr);
        if (val !== null && val >= 0n) {
          unit.minStackBytes = Math.max(unit.minStackBytes, Number(val));
        }
        continue;
      }
      // __export
      if (parser.atKW(Lexer.Keyword.X_EXPORT)) {
        parser.advance();
        const exportNameTok = parser.expectKind(Lexer.TokenKind.IDENT);
        const exportName = exportNameTok.text;
        parser.expect("=");
        const funcNameTok = parser.expectKind(Lexer.TokenKind.IDENT);
        const funcName = funcNameTok.text;
        parser.expect(";");
        const decl = parser.varScope.get(funcName);
        if (decl && decl instanceof AST.DFunc) {
          parser.exportDirectives.push([exportName, decl]);
        }
        continue;
      }
      // __exception
      if (parser.atKW(Lexer.Keyword.X_EXCEPTION)) {
        parser.advance();
        const tagName = parser.expectKind(Lexer.TokenKind.IDENT).text;
        parser.expect("(");
        const paramTypes = [];
        if (!parser.atText(")")) {
          while (true) {
            const pSpecs = parser.parseDeclSpecifiers();
            let pType = pSpecs.type;
            while (parser.matchText("*")) {
              if (pType.isGCStruct()) {
                parser.error(parser.peek(-1), `'${pType.toString()}' is already a reference; '__struct Foo **' is not allowed`);
                break;
              }
              pType = pType.pointer();
            }
            if (parser.atKind(Lexer.TokenKind.IDENT)) parser.advance(); // skip param name
            paramTypes.push(pType);
            if (!parser.matchText(",")) break;
          }
        }
        parser.expect(")");
        parser.expect(";");
        for (const pt of paramTypes) {
          if (pt.isTag() && (pt.tagDecl?.tagKind === Types.TagKind.STRUCT || pt.tagDecl?.tagKind === Types.TagKind.UNION)) {
            parser.error(parser.peek(), `struct/union types are not allowed in __exception parameters`);
          }
        }
        // Cross-TU unification: reuse existing tag if registered
        const registry = parser._exceptionTagRegistry;
        let tag;
        if (registry && registry.has(tagName)) {
          tag = registry.get(tagName);
          // Check param type compatibility
          if (tag.paramTypes.length !== paramTypes.length ||
              tag.paramTypes.some((t, i) => t !== paramTypes[i])) {
            parser.recoverableError(parser.peek(-1),
              `Conflicting types for __exception tag '${tagName}'`);
          }
        } else {
          tag = new AST.DExceptionTag(Lexer.Loc.fromTok(parser.peek(-1)), tagName, paramTypes);
          tag.definition = tag;
          if (registry) registry.set(tagName, tag);
        }
        parser.parsedExceptionTags.push(tag);
        unit.exceptionTags.push(tag);
        continue;
      }
      parser.parseExternalDeclaration(unit);
    }
  } catch (e) {
    // FatalDiag: error is already in the sink, just stop parsing.
    if (e instanceof FatalDiag) return;
    // Programming bug: surface as a generic diagnostic.
    sink.errors.push(new Lexer.LexError(e.message, null, 0));
  }
  });

  unit.requiredSources = parser.requiredSources;
  unit.exportDirectives = parser.exportDirectives;

  return { translationUnit: unit, errors: sink.errors, warnings: sink.warnings };
}

function parseSource(filename, source, ppRegistry) {
  const result = Lexer.tokenize(filename, source, ppRegistry);
  if (result.errors.length > 0) {
    return { translationUnit: AST.makeTUnit(filename), errors: result.errors, warnings: result.warnings };
  }
  const parseResult = parseTokens(result.tokens);
  parseResult.warnings = [...result.warnings, ...parseResult.warnings];
  return parseResult;
}

// Module-scope shorthand for the IIFE-internal builders that get called
// from many parser sites — saves typing AST.maybeDecay(...) everywhere.
const maybeImplicitCast = AST.maybeImplicitCast;
const maybeDecay = AST.maybeDecay;

// ========== setjmp/longjmp lowering ==========

// Check if an expression is a call to a named function, return the ECall or null
// Find a direct call to `name` in `expr`. If `expr` is a comma expression,
// looks through to the last sub-expression and (on a match) collects the
// LEADING sub-expressions into `prefix` — they're side-effecting and must
// be evaluated before the call site is rewritten. Used to preserve calls
// like `nlr_push_tail(...)` in `nlr_push`'s expansion:
//   #define nlr_push(buf) (nlr_push_tail(buf), setjmp((buf)->jmpbuf))
// where setjmp lowering otherwise would silently drop nlr_push_tail.
//
// Returns { call, prefix } on match (prefix may be empty), or null.
function getNamedCallWithPrefix(expr, name) {
  const prefix = [];
  while (expr instanceof AST.EComma) {
    for (let i = 0; i < expr.expressions.length - 1; i++) prefix.push(expr.expressions[i]);
    expr = expr.expressions[expr.expressions.length - 1];
  }
  if (!(expr instanceof AST.ECall)) return null;
  let callee = expr.callee;
  if (callee instanceof AST.EDecay) callee = callee.operand;
  if (!(callee instanceof AST.EIdent)) return null;
  if (callee.name !== name) return null;
  return { call: expr, prefix };
}

function getNamedCall(expr, name) {
  const r = getNamedCallWithPrefix(expr, name);
  return r ? r.call : null;
}

// Detect setjmp patterns in an if-condition.
// Returns {call, zeroIsTrue, prefix} on match (prefix = side-effecting
// expressions to evaluate before the rewritten setjmp), or {call: null}.
function extractSetjmpCall(cond) {
  if (cond instanceof AST.EBinary) {
    if (cond.op === "EQ" || cond.op === "NE") {
      const zeroIsTrue = cond.op === "EQ";
      let r = getNamedCallWithPrefix(cond.left, "setjmp");
      if (r && cond.right instanceof AST.EInt && cond.right.value === 0n)
        return { call: r.call, zeroIsTrue, prefix: r.prefix };
      r = getNamedCallWithPrefix(cond.right, "setjmp");
      if (r && cond.left instanceof AST.EInt && cond.left.value === 0n)
        return { call: r.call, zeroIsTrue, prefix: r.prefix };
    }
  }
  // Pattern: setjmp(buf) used directly as condition (truthy = longjmp fired)
  const direct = getNamedCallWithPrefix(cond, "setjmp");
  if (direct) return { call: direct.call, zeroIsTrue: false, prefix: direct.prefix };
  // Pattern: !setjmp(buf)
  if (cond instanceof AST.EUnary && cond.op === "OP_LNOT") {
    const neg = getNamedCallWithPrefix(cond.operand, "setjmp");
    if (neg) return { call: neg.call, zeroIsTrue: true, prefix: neg.prefix };
  }
  return { call: null, zeroIsTrue: false };
}

// Build expression: buf[0]
function makeBufIdExpr(bufExpr) {
  const loc = bufExpr.loc;
  return AST.makeSubscript(loc, bufExpr, new AST.EInt(loc, Types.TINT, 0n));
}

// Build: buf[0] = ++counterVar
function makeSetBufIdStmt(bufExpr, counterVar) {
  const loc = bufExpr.loc;
  const lhs = makeBufIdExpr(bufExpr);
  const counterRef = new AST.EIdent(loc, Types.TINT, counterVar);
  const rhs = new AST.EUnary(loc, Types.TINT, "OP_PRE_INC", counterRef);
  const assign = new AST.EBinary(loc, Types.TINT, "ASSIGN", lhs, rhs);
  return new AST.SExpr(loc, assign);
}

// Build: __throw tag(idExpr, valExpr)
function makeThrowLongJump(tag, idExpr, valExpr) {
  // tag.paramTypes are [int, int]; idExpr / valExpr are already int in
  // practice but maybeImplicitCast is a no-op when types match anyway.
  const args = [idExpr, valExpr];
  if (tag && tag.paramTypes) {
    for (let i = 0; i < args.length && i < tag.paramTypes.length; i++) {
      args[i] = maybeImplicitCast(args[i], tag.paramTypes[i]);
    }
  }
  return new AST.SThrow(idExpr.loc, tag, args);
}

// Build catch body: { if (id != buf[0]) rethrow; <userBody> }
function makeCatchBody(tag, idVar, valVar, bufExpr, userBody) {
  const loc = bufExpr.loc;
  const idRef = new AST.EIdent(loc, Types.TINT, idVar);
  const myIdExpr = makeBufIdExpr(bufExpr);
  const cond = new AST.EBinary(loc, Types.TINT, "NE", idRef, myIdExpr);

  const idRef2 = new AST.EIdent(loc, Types.TINT, idVar);
  const valRef = new AST.EIdent(loc, Types.TINT, valVar);
  const rethrow = makeThrowLongJump(tag, idRef2, valRef);

  const rethrowIf = new AST.SIf(loc, cond, rethrow, null);
  return new AST.SCompound(loc, [rethrowIf, userBody]);
}

// Transform longjmp calls in a statement tree into __throw __LongJump(buf[0], val)
// Returns a replacement statement if changed, or the same statement if not.
function lowerLongjmpInStmt(stmt, tag) {
  switch (stmt.constructor) {
    case AST.SExpr: {
      const call = getNamedCall(stmt.expr, "longjmp");
      if (call && call.arguments.length === 2) {
        const idExpr = makeBufIdExpr(call.arguments[0]);
        const valExpr = call.arguments[1];
        return makeThrowLongJump(tag, idExpr, valExpr);
      }
      return stmt;
    }
    case AST.SCompound: {
      // SCompound.statements is a mutable array — write through it
      // (frozen `this` doesn't lock array contents).
      for (let i = 0; i < stmt.statements.length; i++) {
        stmt.statements[i] = lowerLongjmpInStmt(stmt.statements[i], tag);
      }
      return stmt;
    }
    case AST.SIf: {
      const newThen = lowerLongjmpInStmt(stmt.thenBranch, tag);
      const newElse = stmt.elseBranch ? lowerLongjmpInStmt(stmt.elseBranch, tag) : null;
      return (newThen === stmt.thenBranch && newElse === stmt.elseBranch)
        ? stmt
        : new AST.SIf(stmt.loc, stmt.condition, newThen, newElse);
    }
    case AST.SWhile: {
      const newBody = lowerLongjmpInStmt(stmt.body, tag);
      return newBody === stmt.body ? stmt
        : new AST.SWhile(stmt.loc, stmt.condition, newBody);
    }
    case AST.SDoWhile: {
      const newBody = lowerLongjmpInStmt(stmt.body, tag);
      return newBody === stmt.body ? stmt
        : new AST.SDoWhile(stmt.loc, newBody, stmt.condition);
    }
    case AST.SFor: {
      const newInit = stmt.init ? lowerLongjmpInStmt(stmt.init, tag) : null;
      const newBody = lowerLongjmpInStmt(stmt.body, tag);
      return (newInit === stmt.init && newBody === stmt.body) ? stmt
        : new AST.SFor(stmt.loc, newInit, stmt.condition, stmt.increment, newBody);
    }
    case AST.SSwitch: {
      const newBody = lowerLongjmpInStmt(stmt.body, tag);
      return newBody === stmt.body ? stmt
        : new AST.SSwitch(stmt.loc, stmt.expr, newBody);
    }
    case AST.STryCatch: {
      const newTry = lowerLongjmpInStmt(stmt.tryBody, tag);
      let catchesChanged = false;
      const newCatches = stmt.catches.map(cc => {
        const newBody = lowerLongjmpInStmt(cc.body, tag);
        if (newBody === cc.body) return cc;
        catchesChanged = true;
        return { ...cc, body: newBody };
      });
      return (newTry === stmt.tryBody && !catchesChanged) ? stmt
        : new AST.STryCatch(stmt.loc, newTry, newCatches);
    }
    default:
      return stmt;
  }
}

// Lower setjmp patterns in a compound statement's children.
function lowerSetjmpInCompound(compound, tag, counterVar) {
  const stmts = compound.statements;

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];

    // Recurse into nested compounds first
    switch (stmt.constructor) {
      case AST.SCompound:
        lowerSetjmpInCompound(stmt, tag, counterVar);
        break;
      case AST.SIf:
        // Don't recurse into the if we're about to transform — check first
        break;
      case AST.SWhile:
        if (stmt.body instanceof AST.SCompound)
          lowerSetjmpInCompound(stmt.body, tag, counterVar);
        break;
      case AST.SDoWhile:
        if (stmt.body instanceof AST.SCompound)
          lowerSetjmpInCompound(stmt.body, tag, counterVar);
        break;
      case AST.SFor:
        if (stmt.body instanceof AST.SCompound)
          lowerSetjmpInCompound(stmt.body, tag, counterVar);
        break;
      case AST.SSwitch:
        if (stmt.body instanceof AST.SCompound)
          lowerSetjmpInCompound(stmt.body, tag, counterVar);
        break;
      case AST.SLabel:
        break;
      case AST.STryCatch:
        if (stmt.tryBody instanceof AST.SCompound)
          lowerSetjmpInCompound(stmt.tryBody, tag, counterVar);
        for (const cc of stmt.catches)
          if (cc.body instanceof AST.SCompound)
            lowerSetjmpInCompound(cc.body, tag, counterVar);
        break;
      default:
        break;
    }

    // Now check if this is an if-statement with setjmp in the condition
    if (!(stmt instanceof AST.SIf)) continue;

    const { call: setjmpCall, zeroIsTrue, prefix: setjmpPrefix } = extractSetjmpCall(stmt.condition);
    if (!setjmpCall) {
      // Not a setjmp if — but still recurse into its branches
      if (stmt.thenBranch instanceof AST.SCompound)
        lowerSetjmpInCompound(stmt.thenBranch, tag, counterVar);
      if (stmt.elseBranch && stmt.elseBranch instanceof AST.SCompound)
        lowerSetjmpInCompound(stmt.elseBranch, tag, counterVar);
      continue;
    }

    // Found a setjmp pattern! Transform it.
    const bufExpr = setjmpCall.arguments[0];

    // Create catch binding variables
    const idName = Lexer.intern("__setjmp_caught_id");
    const valName = Lexer.intern("__setjmp_caught_val");
    const loc = Lexer.Loc.generated();
    const idVar = new AST.DVar(loc, idName, Types.TINT, Types.StorageClass.NONE, null);
    idVar.definition = idVar;
    const valVar = new AST.DVar(loc, valName, Types.TINT, Types.StorageClass.NONE, null);
    valVar.definition = valVar;

    // Determine try-body and catch-body based on pattern
    let tryBody, catchUserBody;

    const stmtLoc = stmt.loc;
    if (zeroIsTrue) {
      // Pattern A: if (setjmp(buf) == 0) { Y } else { X }
      tryBody = stmt.thenBranch;
      catchUserBody = stmt.elseBranch || new AST.SEmpty(stmtLoc);
    } else {
      // Pattern B: if (setjmp(buf)) { X }  <remaining stmts>
      catchUserBody = stmt.thenBranch;

      if (stmt.elseBranch) {
        tryBody = stmt.elseBranch;
      } else {
        // Gather remaining statements from the compound as the try body
        const remaining = stmts.splice(i + 1);
        if (remaining.length === 0) {
          tryBody = new AST.SEmpty(stmtLoc);
        } else {
          tryBody = new AST.SCompound(stmtLoc, remaining);
        }
      }
    }

    // Recurse into the try body and catch body
    if (tryBody instanceof AST.SCompound)
      lowerSetjmpInCompound(tryBody, tag, counterVar);
    if (catchUserBody instanceof AST.SCompound)
      lowerSetjmpInCompound(catchUserBody, tag, counterVar);

    // Build the catch body with rethrow logic
    const fullCatchBody = makeCatchBody(tag, idVar, valVar, bufExpr, catchUserBody);

    // Build the catch clause
    const cc = {
      tag,
      bindings: [idName, valName],
      bindingVars: [idVar, valVar],
      body: fullCatchBody,
    };

    // Build the STryCatch
    const tryCatch = new AST.STryCatch(stmtLoc, tryBody, [cc]);

    // Build: buf[0] = ++__setjmp_id_counter; try { ... } catch { ... }
    const setBufStmt = makeSetBufIdStmt(bufExpr, counterVar);

    // If the setjmp call was inside a comma expression, evaluate the
    // leading operands as SExpr statements first. The canonical case:
    //
    //   if ((nlr_push_tail(buf), setjmp(buf->jmpbuf)) == 0) { … }
    //
    // expanded from `nlr_push(buf)`. Without this, nlr_push_tail (which
    // pushes onto the thread-local nlr stack) would be silently dropped
    // and the next nlr_jump would target the wrong (stale) buf, ending
    // up in nlr_jump_fail's `while(1)`.
    const prefixStmts = (setjmpPrefix || []).map(e => new AST.SExpr(e.loc, e));

    // Replace the if-statement with [...prefix, setBuf, tryCatch]
    stmts[i] = setBufStmt;
    if (prefixStmts.length > 0) {
      stmts.splice(i, 0, ...prefixStmts);
      i += prefixStmts.length;
    }
    stmts.splice(i + 1, 0, tryCatch);

    // Skip the tryCatch we just inserted
    i++;
  }
}

function lowerSetjmpLongjmp(unit, exceptionTagRegistry) {
  // Check if this unit uses setjmp.h by looking for setjmp/longjmp imports
  let hasSetjmp = false;
  for (const f of unit.importedFunctions) {
    if (f.name === "setjmp" || f.name === "longjmp") {
      hasSetjmp = true;
      break;
    }
  }
  if (!hasSetjmp) return;

  // Look up __LongJump tag (declared via __exception in setjmp.h, parsed into registry)
  const tagName = Lexer.intern("__LongJump");
  const tag = exceptionTagRegistry.get(tagName);
  if (!tag) throw new Error("__LongJump exception tag not found");

  // Remove setjmp/longjmp from importedFunctions so they don't become WASM imports
  unit.importedFunctions = unit.importedFunctions.filter(
    f => f.name !== "setjmp" && f.name !== "longjmp"
  );

  // Look up __setjmp_id_counter (declared extern in setjmp.h, defined in __setjmp.c)
  const counterName = Lexer.intern("__setjmp_id_counter");
  let counterVar = null;
  for (const v of unit.externVariables) {
    if (v.name === counterName) { counterVar = v; break; }
  }
  if (!counterVar) throw new Error("__setjmp_id_counter not found in externVariables");

  // Lower all function bodies. The irreducible lowering, if it later
  // fires on a setjmp-using function, recognizes the STryCatch shape we
  // emit here and segmentizes the try/catch contents inline — that way
  // gotos between the try and catch regions cross cleanly via state
  // transitions in the lifted while-switch.
  const lowerFunc = (func) => {
    if (!func.body) return;
    if (func.body instanceof AST.SCompound) {
      lowerSetjmpInCompound(func.body, tag, counterVar);
    }
    func.body = lowerLongjmpInStmt(func.body, tag);
  };
  for (const f of unit.definedFunctions) lowerFunc(f);
  for (const f of unit.staticFunctions) lowerFunc(f);
}

return {
  dumpAst, printC, parseTokens, parseSource,
  gcSectionsPass,
  linkTranslationUnits,
  lowerSetjmpLongjmp,
};
})();

// ====================
// WASM
// ====================

const Codegen = (() => {

function alwaysReturns(stmt) {
  switch (stmt.constructor) {
    case AST.SReturn:
    case AST.SThrow:
      return true;
    case AST.SCompound:
      if (stmt.labels && stmt.labels.length > 0) return false;
      return stmt.statements.some(alwaysReturns);
    case AST.SIf:
      return stmt.elseBranch !== null
        && alwaysReturns(stmt.thenBranch)
        && alwaysReturns(stmt.elseBranch);
    default:
      return false;
  }
}

function appendF32(out, value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true); // little-endian
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < 4; i++) out.push(bytes[i]);
}

function appendF64(out, value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true); // little-endian
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < 8; i++) out.push(bytes[i]);
}

// WASM type enums
const WasmNumType = Object.freeze({ I32: 0x7F, I64: 0x7E, F32: 0x7D, F64: 0x7C });

const WT_I32 = { tag: "num", num: WasmNumType.I32 };
const WT_I64 = { tag: "num", num: WasmNumType.I64 };
const WT_F32 = { tag: "num", num: WasmNumType.F32 };
const WT_F64 = { tag: "num", num: WasmNumType.F64 };
const WT_EXTERNREF = { tag: "ref", nullable: true, heap: 0x6F, heapIsIdx: false };
const WT_REFEXTERN = { tag: "ref", nullable: false, heap: 0x6F, heapIsIdx: false };
const WT_EQREF = { tag: "ref", nullable: true, heap: 0x6D, heapIsIdx: false };
const WT_EMPTY = { tag: "empty" };

// GC ref to a defined struct/array type. heap = type index (positive integer).
function WT_GCREF(typeIdx, nullable) {
  return { tag: "ref", nullable: !!nullable, heap: typeIdx, heapIsIdx: true };
}

function wtIsNum(wt) { return wt.tag === "num"; }
function wtIsRef(wt) { return wt.tag === "ref"; }
function wtIsIntegral(wt) { return wtIsNum(wt) && (wt.num === WasmNumType.I32 || wt.num === WasmNumType.I64); }
function wtIsFloating(wt) { return wtIsNum(wt) && (wt.num === WasmNumType.F32 || wt.num === WasmNumType.F64); }
function wtEmit(wt, buf) {
  if (wt.tag === "empty") buf.push(0x40);
  else if (wt.tag === "num") buf.push(wt.num);
  else if (wt.tag === "ref") {
    if (wt.heapIsIdx) {
      // Encoded as ref[null] (typeidx-as-signed-LEB)
      buf.push(wt.nullable ? 0x63 : 0x64);
      lebI(buf, wt.heap);
    } else if (wt.nullable) {
      buf.push(wt.heap);
    } else {
      buf.push(0x64);
      buf.push(wt.heap);
    }
  }
}
function wtEquals(a, b) {
  if (a.tag !== b.tag) return false;
  if (a.tag === "empty") return true;
  if (a.tag === "num") return a.num === b.num;
  if (a.tag === "ref") return a.nullable === b.nullable && a.heap === b.heap && !!a.heapIsIdx === !!b.heapIsIdx;
  return false;
}

// Memory opcodes
const MOP = Object.freeze({
  I32_LOAD: 0x28, I64_LOAD: 0x29, F32_LOAD: 0x2A, F64_LOAD: 0x2B,
  I32_LOAD8_S: 0x2C, I32_LOAD8_U: 0x2D, I32_LOAD16_S: 0x2E, I32_LOAD16_U: 0x2F,
  I64_LOAD8_S: 0x30, I64_LOAD8_U: 0x31, I64_LOAD16_S: 0x32, I64_LOAD16_U: 0x33,
  I64_LOAD32_S: 0x34, I64_LOAD32_U: 0x35,
  I32_STORE: 0x36, I64_STORE: 0x37, F32_STORE: 0x38, F64_STORE: 0x39,
  I32_STORE8: 0x3A, I32_STORE16: 0x3B, I64_STORE8: 0x3C, I64_STORE16: 0x3D, I64_STORE32: 0x3E,
});

// ALU opcodes
const ALU = Object.freeze({
  OP_EQZ: 0, OP_EQ: 1, OP_NE: 2, OP_LT: 3, OP_GT: 4, OP_LE: 5, OP_GE: 6,
  OP_CLZ: 7, OP_CTZ: 8, OP_POPCNT: 9,
  OP_ADD: 10, OP_SUB: 11, OP_MUL: 12, OP_DIV: 13, OP_REM: 14,
  OP_AND: 15, OP_OR: 16, OP_XOR: 17, OP_SHL: 18, OP_SHR_S: 19, OP_SHR_U: 20,
  OP_ROTL: 21, OP_ROTR: 22,
  OP_ABS: 23, OP_NEG: 24, OP_CEIL: 25, OP_FLOOR: 26, OP_TRUNC: 27, OP_NEAREST: 28, OP_SQRT: 29,
  OP_MIN: 30, OP_MAX: 31, OP_COPYSIGN: 32,
  OP_WRAP_I64: 33, OP_TRUNC_F32: 34, OP_TRUNC_F64: 35,
  OP_EXTEND_I32: 36, OP_CONVERT_I32: 37, OP_CONVERT_I64: 38,
  OP_DEMOTE_F64: 39, OP_PROMOTE_F32: 40,
  OP_REINTERPRET_F32: 41, OP_REINTERPRET_F64: 42, OP_REINTERPRET_I32: 43, OP_REINTERPRET_I64: 44,
});

function getaop(wt, op, sign) {
  if (!wtIsNum(wt)) throw new Error("getaop called with non-numeric WasmType");
  if (sign === undefined) sign = true;
  const n = wt.num;
  if (n === WasmNumType.I32) {
    switch (op) {
      case ALU.OP_EQZ: return 0x45; case ALU.OP_EQ: return 0x46; case ALU.OP_NE: return 0x47;
      case ALU.OP_LT: return sign ? 0x48 : 0x49; case ALU.OP_GT: return sign ? 0x4A : 0x4B;
      case ALU.OP_LE: return sign ? 0x4C : 0x4D; case ALU.OP_GE: return sign ? 0x4E : 0x4F;
      case ALU.OP_CLZ: return 0x67; case ALU.OP_CTZ: return 0x68; case ALU.OP_POPCNT: return 0x69;
      case ALU.OP_ADD: return 0x6A; case ALU.OP_SUB: return 0x6B; case ALU.OP_MUL: return 0x6C;
      case ALU.OP_DIV: return sign ? 0x6D : 0x6E; case ALU.OP_REM: return sign ? 0x6F : 0x70;
      case ALU.OP_AND: return 0x71; case ALU.OP_OR: return 0x72; case ALU.OP_XOR: return 0x73;
      case ALU.OP_SHL: return 0x74; case ALU.OP_SHR_S: return 0x75; case ALU.OP_SHR_U: return 0x76;
      case ALU.OP_ROTL: return 0x77; case ALU.OP_ROTR: return 0x78;
      case ALU.OP_WRAP_I64: return 0xA7;
      case ALU.OP_TRUNC_F32: return sign ? 0xA8 : 0xA9;
      case ALU.OP_TRUNC_F64: return sign ? 0xAA : 0xAB;
      case ALU.OP_REINTERPRET_F32: return 0xBC;
    }
  } else if (n === WasmNumType.I64) {
    switch (op) {
      case ALU.OP_EQZ: return 0x50; case ALU.OP_EQ: return 0x51; case ALU.OP_NE: return 0x52;
      case ALU.OP_LT: return sign ? 0x53 : 0x54; case ALU.OP_GT: return sign ? 0x55 : 0x56;
      case ALU.OP_LE: return sign ? 0x57 : 0x58; case ALU.OP_GE: return sign ? 0x59 : 0x5A;
      case ALU.OP_CLZ: return 0x79; case ALU.OP_CTZ: return 0x7A; case ALU.OP_POPCNT: return 0x7B;
      case ALU.OP_ADD: return 0x7C; case ALU.OP_SUB: return 0x7D; case ALU.OP_MUL: return 0x7E;
      case ALU.OP_DIV: return sign ? 0x7F : 0x80; case ALU.OP_REM: return sign ? 0x81 : 0x82;
      case ALU.OP_AND: return 0x83; case ALU.OP_OR: return 0x84; case ALU.OP_XOR: return 0x85;
      case ALU.OP_SHL: return 0x86; case ALU.OP_SHR_S: return 0x87; case ALU.OP_SHR_U: return 0x88;
      case ALU.OP_ROTL: return 0x89; case ALU.OP_ROTR: return 0x8A;
      case ALU.OP_EXTEND_I32: return sign ? 0xAC : 0xAD;
      case ALU.OP_TRUNC_F32: return sign ? 0xAE : 0xAF;
      case ALU.OP_TRUNC_F64: return sign ? 0xB0 : 0xB1;
      case ALU.OP_REINTERPRET_F64: return 0xBD;
    }
  } else if (n === WasmNumType.F32) {
    switch (op) {
      case ALU.OP_EQ: return 0x5B; case ALU.OP_NE: return 0x5C;
      case ALU.OP_LT: return 0x5D; case ALU.OP_GT: return 0x5E;
      case ALU.OP_LE: return 0x5F; case ALU.OP_GE: return 0x60;
      case ALU.OP_ABS: return 0x8B; case ALU.OP_NEG: return 0x8C;
      case ALU.OP_CEIL: return 0x8D; case ALU.OP_FLOOR: return 0x8E;
      case ALU.OP_TRUNC: return 0x8F; case ALU.OP_NEAREST: return 0x90; case ALU.OP_SQRT: return 0x91;
      case ALU.OP_ADD: return 0x92; case ALU.OP_SUB: return 0x93; case ALU.OP_MUL: return 0x94;
      case ALU.OP_DIV: return 0x95; case ALU.OP_MIN: return 0x96; case ALU.OP_MAX: return 0x97;
      case ALU.OP_COPYSIGN: return 0x98;
      case ALU.OP_CONVERT_I32: return sign ? 0xB2 : 0xB3;
      case ALU.OP_CONVERT_I64: return sign ? 0xB4 : 0xB5;
      case ALU.OP_DEMOTE_F64: return 0xB6;
      case ALU.OP_REINTERPRET_I32: return 0xBE;
    }
  } else if (n === WasmNumType.F64) {
    switch (op) {
      case ALU.OP_EQ: return 0x61; case ALU.OP_NE: return 0x62;
      case ALU.OP_LT: return 0x63; case ALU.OP_GT: return 0x64;
      case ALU.OP_LE: return 0x65; case ALU.OP_GE: return 0x66;
      case ALU.OP_ABS: return 0x99; case ALU.OP_NEG: return 0x9A;
      case ALU.OP_CEIL: return 0x9B; case ALU.OP_FLOOR: return 0x9C;
      case ALU.OP_TRUNC: return 0x9D; case ALU.OP_NEAREST: return 0x9E; case ALU.OP_SQRT: return 0x9F;
      case ALU.OP_ADD: return 0xA0; case ALU.OP_SUB: return 0xA1; case ALU.OP_MUL: return 0xA2;
      case ALU.OP_DIV: return 0xA3; case ALU.OP_MIN: return 0xA4; case ALU.OP_MAX: return 0xA5;
      case ALU.OP_COPYSIGN: return 0xA6;
      case ALU.OP_CONVERT_I32: return sign ? 0xB7 : 0xB8;
      case ALU.OP_CONVERT_I64: return sign ? 0xB9 : 0xBA;
      case ALU.OP_PROMOTE_F32: return 0xBB;
      case ALU.OP_REINTERPRET_I64: return 0xBF;
    }
  }
  throw new Error(`Invalid type/op combination: num=${n} op=${op}`);
}

// WasmCode builder - convenience utility for building WASM bytecode
class WasmCode {
  constructor(bytes) { this.bytes = bytes; }
  push(byte) { this.bytes.push(byte); }

  // Control flow (0x00 - 0x11)
  unreachable() { this.push(0x00); }
  nop() { this.push(0x01); }
  block(bt) { this.push(0x02); wtEmit(bt || WT_EMPTY, this.bytes); }
  loop(bt) { this.push(0x03); wtEmit(bt || WT_EMPTY, this.bytes); }
  if_(bt) { this.push(0x04); wtEmit(bt, this.bytes); }
  else_() { this.push(0x05); }
  end() { this.push(0x0B); }
  br(labelIdx) { this._checkBrDepth(labelIdx, "br"); this.push(0x0C); lebU(this.bytes, labelIdx); }
  brIf(labelIdx) { this._checkBrDepth(labelIdx, "brIf"); this.push(0x0D); lebU(this.bytes, labelIdx); }
  brTable(labels, defaultLabel) {
    for (const l of labels) this._checkBrDepth(l, "brTable entry");
    this._checkBrDepth(defaultLabel, "brTable default");
    this.push(0x0E);
    lebU(this.bytes, labels.length);
    for (const l of labels) lebU(this.bytes, l);
    lebU(this.bytes, defaultLabel);
  }
  // Catch internal codegen bugs that would emit a `br` with an out-of-range
  // depth — the wasm validator would reject the module at instantiation
  // time with a cryptic "invalid branch depth: <huge number>" message
  // (negative deltas LEB-encode to ~0xFFFFFFFD). Failing here points
  // directly at the offending emit site instead, so stale entries in
  // gotoLabelDepths / breakTarget / continueTarget surface as a clear
  // diagnostic rather than silent miscompilation.
  _checkBrDepth(d, opName) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 0xFFFFFF) {
      throw new Error(
        `internal codegen error: ${opName} depth ${d} is out of range ` +
        `(likely a stale entry in gotoLabelDepths / breakTarget / continueTarget)`);
    }
  }
  ret() { this.push(0x0F); }
  call(funcIdx) { this.push(0x10); lebU(this.bytes, funcIdx); }
  callIndirect(typeIdx) { this.push(0x11); lebU(this.bytes, typeIdx); this.push(0x00); }

  // Locals and globals (0x20 - 0x24)
  localGet(idx) { this.push(0x20); lebU(this.bytes, idx); }
  localSet(idx) { this.push(0x21); lebU(this.bytes, idx); }
  localTee(idx) { this.push(0x22); lebU(this.bytes, idx); }
  globalGet(idx) { this.push(0x23); lebU(this.bytes, idx); }
  globalSet(idx) { this.push(0x24); lebU(this.bytes, idx); }

  // Memory operations
  mop(opcode, offset, align) { this.push(opcode); lebU(this.bytes, align); lebU(this.bytes, offset); }
  memorySize() { this.push(0x3F); this.push(0x00); }
  memoryGrow() { this.push(0x40); this.push(0x00); }
  memoryCopy() { this.push(0xFC); lebU(this.bytes, 10); this.push(0x00); this.push(0x00); }
  memoryFill() { this.push(0xFC); lebU(this.bytes, 11); this.push(0x00); }

  // Non-trapping float→int conversion (WASM 2.0 §5.4.5). NaN→0,
  // out-of-range saturates to IMIN/IMAX. Encoded as the 0xFC misc
  // prefix + LEB128 subop 0..7.
  //   subop 0: i32.trunc_sat_f32_s
  //   subop 1: i32.trunc_sat_f32_u
  //   subop 2: i32.trunc_sat_f64_s
  //   subop 3: i32.trunc_sat_f64_u
  //   subop 4: i64.trunc_sat_f32_s
  //   subop 5: i64.trunc_sat_f32_u
  //   subop 6: i64.trunc_sat_f64_s
  //   subop 7: i64.trunc_sat_f64_u
  truncSat(dstWt, srcWt, sign) {
    let subop;
    if (wtEquals(dstWt, WT_I32) && wtEquals(srcWt, WT_F32)) subop = sign ? 0 : 1;
    else if (wtEquals(dstWt, WT_I32) && wtEquals(srcWt, WT_F64)) subop = sign ? 2 : 3;
    else if (wtEquals(dstWt, WT_I64) && wtEquals(srcWt, WT_F32)) subop = sign ? 4 : 5;
    else if (wtEquals(dstWt, WT_I64) && wtEquals(srcWt, WT_F64)) subop = sign ? 6 : 7;
    else throw new Error("truncSat: unsupported src/dst pair");
    this.push(0xFC); lebU(this.bytes, subop);
  }

  // Numeric constants
  i32Const(value) { this.push(0x41); lebI(this.bytes, Number(value) | 0); }
  i64Const(value) {
    this.push(0x42);
    if (typeof value === "bigint") lebI64(this.bytes, value);
    else lebI64(this.bytes, BigInt(value));
  }
  f32Const(value) { this.push(0x43); appendF32(this.bytes, value); }
  f64Const(value) { this.push(0x44); appendF64(this.bytes, value); }

  // ALU operations
  aop(wt, op, sign) { this.push(getaop(wt, op, sign)); }

  // Exception handling
  throw_(tagIdx) { this.push(0x08); lebU(this.bytes, tagIdx); }
  tryTable(blockType, catches) {
    this.push(0x1F);
    wtEmit(blockType, this.bytes);
    lebU(this.bytes, catches.length);
    for (const [kind, tagIdx, labelIdx] of catches) {
      this.push(kind);
      if (kind === 0x00 || kind === 0x01) lebU(this.bytes, tagIdx);
      lebU(this.bytes, labelIdx);
    }
  }

  // Drop
  drop() { this.push(0x1A); }

  // Reference types
  refNull(heapType) { this.push(0xD0); this.push(heapType); }
  refNullIdx(typeIdx) { this.push(0xD0); lebI(this.bytes, typeIdx); }
  refIsNull() { this.push(0xD1); }
  refEq() { this.push(0xD3); }
  refTest(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x14); lebI(this.bytes, typeIdx); }
  refTestNull(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x15); lebI(this.bytes, typeIdx); }
  refCast(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x16); lebI(this.bytes, typeIdx); }
  refCastNull(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x17); lebI(this.bytes, typeIdx); }
  // ref.cast (ref null eq) — heap type encoded as the abstract `eq` byte (0x6D).
  refCastNullEq() { this.push(0xFB); lebU(this.bytes, 0x17); this.push(0x6D); }
  // Bridges between WASM's `extern` and `any` heap-type universes. Both are
  // (near-)zero-cost retags — no copy, just a type-system cast.
  anyConvertExtern() { this.push(0xFB); lebU(this.bytes, 0x1A); }
  externConvertAny() { this.push(0xFB); lebU(this.bytes, 0x1B); }

  // GC opcodes (0xFB ...)
  structNew(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x00); lebU(this.bytes, typeIdx); }
  structNewDefault(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x01); lebU(this.bytes, typeIdx); }
  structGet(typeIdx, fieldIdx) { this.push(0xFB); lebU(this.bytes, 0x02); lebU(this.bytes, typeIdx); lebU(this.bytes, fieldIdx); }
  structGetS(typeIdx, fieldIdx) { this.push(0xFB); lebU(this.bytes, 0x03); lebU(this.bytes, typeIdx); lebU(this.bytes, fieldIdx); }
  structGetU(typeIdx, fieldIdx) { this.push(0xFB); lebU(this.bytes, 0x04); lebU(this.bytes, typeIdx); lebU(this.bytes, fieldIdx); }
  structSet(typeIdx, fieldIdx) { this.push(0xFB); lebU(this.bytes, 0x05); lebU(this.bytes, typeIdx); lebU(this.bytes, fieldIdx); }
  arrayNew(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x06); lebU(this.bytes, typeIdx); }
  arrayNewDefault(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x07); lebU(this.bytes, typeIdx); }
  arrayNewFixed(typeIdx, n) { this.push(0xFB); lebU(this.bytes, 0x08); lebU(this.bytes, typeIdx); lebU(this.bytes, n); }
  arrayGet(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x0B); lebU(this.bytes, typeIdx); }
  arrayGetS(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x0C); lebU(this.bytes, typeIdx); }
  arrayGetU(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x0D); lebU(this.bytes, typeIdx); }
  arraySet(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x0E); lebU(this.bytes, typeIdx); }
  arrayLen() { this.push(0xFB); lebU(this.bytes, 0x0F); }
  arrayFill(typeIdx) { this.push(0xFB); lebU(this.bytes, 0x10); lebU(this.bytes, typeIdx); }
  arrayCopy(dstTypeIdx, srcTypeIdx) {
    this.push(0xFB); lebU(this.bytes, 0x11);
    lebU(this.bytes, dstTypeIdx); lebU(this.bytes, srcTypeIdx);
  }
}

// ====================
// WASM Module State
// ====================

class WasmModule {
  constructor() {
    this.typeDefs = [];         // section 1 (function/struct/array types)
    this.funcTypeIndices = new Map(); // WasmFunctionType key -> index
    this.gcStructTypeIndices = new Map(); // struct fields key -> index
    this.gcArrayTypeIndices = new Map();  // array elem key -> index
    // Per-module cache mapping C GC type -> wasm type index. Kept here
    // (rather than as a field on the type object) because some GC types
    // — notably `gcArrayOf(T)` for singleton T — are interned on the
    // shared Types module and would otherwise carry indices from a
    // previous compile.
    this.gcTypeIdxByType = new Map();
    this.funcImports = [];      // section 2
    this.funcDefs = [];         // section 3 & 10
    this.memories = [];         // section 5
    this.globals = [];          // section 6
    this.exports = [];          // section 7
    this.dataSegments = [];     // section 11
    this.tags = [];             // section 13
    this.funcNames = [];        // for name custom section: [{idx, name}]
    this.globalNames = [];      // for name custom section: [{idx, name}]
    this.typeNames = [];        // for name custom section subsection 4: [{idx, name}]
    this.fieldNames = [];       // for name custom section subsection 10: [{typeIdx, fields:[{idx, name}]}]
    this.localNames = [];       // for name custom section: [{funcIdx, locals: [{idx, name}]}]
    this.sourceMapFiles = [];   // for c.sourcemap custom section
    this.sourceMapEntries = []; // [{funcIdx (def-relative), entries: [{offset, fileIdx, line}]}]
    this.embeddedSources = null; // for c.sources custom section (-g2)
  }

  addFunctionTypeId(params, results) {
    const wtKey = t => t.tag === "ref" ? `ref:${t.nullable?1:0}:${t.heapIsIdx?'i':'h'}:${t.heap}` : `${t.tag}:${t.num||''}`;
    const key = params.map(wtKey).join(",") + "->" + results.map(wtKey).join(",");
    if (this.funcTypeIndices.has(key)) return this.funcTypeIndices.get(key);
    const id = this.typeDefs.length;
    this.typeDefs.push({ kind: "func", params, results });
    this.funcTypeIndices.set(key, id);
    return id;
  }

  reserveGCStructTypeId() {
    const id = this.typeDefs.length;
    this.typeDefs.push({ kind: "struct", fields: null });
    return id;
  }
  reserveGCArrayTypeId() {
    const id = this.typeDefs.length;
    this.typeDefs.push({ kind: "array", elem: null });
    return id;
  }

  // Setters for GC type bodies populated after reservation.
  setGCStructFields(typeIdx, fields, parentIdx) {
    this.typeDefs[typeIdx].fields = fields;
    if (parentIdx !== undefined && parentIdx >= 0) this.typeDefs[typeIdx].parentIdx = parentIdx;
  }
  setGCArrayElem(typeIdx, elem) { this.typeDefs[typeIdx].elem = elem; }

  addFunctionImport(moduleName, functionName, typeId) {
    const id = this.funcImports.length;
    this.funcImports.push({ moduleName, functionName, typeId });
    return id;
  }

  addFunctionDefinition(typeId) {
    const id = this.funcImports.length + this.funcDefs.length;
    this.funcDefs.push({ typeId, locals: [], body: [] });
    return id;
  }

  addMemory(minPages, maxPages) {
    const id = this.memories.length;
    this.memories.push({ minPages, maxPages: maxPages || 0 });
    return id;
  }

  addGlobal(type, initExpr, isMutable) {
    const id = this.globals.length;
    this.globals.push({ type, initExpr, isMutable });
    return id;
  }

  addGlobalI32(value, isMutable) {
    const initExpr = [];
    const code = new WasmCode(initExpr);
    code.i32Const(value);
    code.end();
    return this.addGlobal(WT_I32, initExpr, isMutable);
  }

  addGlobalI64(value, isMutable) {
    const initExpr = [];
    const code = new WasmCode(initExpr);
    code.i64Const(value);
    code.end();
    return this.addGlobal(WT_I64, initExpr, isMutable);
  }

  addGlobalF32(value, isMutable) {
    const initExpr = [];
    const code = new WasmCode(initExpr);
    code.f32Const(value);
    code.end();
    return this.addGlobal(WT_F32, initExpr, isMutable);
  }

  addGlobalF64(value, isMutable) {
    const initExpr = [];
    const code = new WasmCode(initExpr);
    code.f64Const(value);
    code.end();
    return this.addGlobal(WT_F64, initExpr, isMutable);
  }

  addGlobalExternref(isMutable) {
    const initExpr = [];
    const code = new WasmCode(initExpr);
    code.refNull(0x6F);
    code.end();
    return this.addGlobal(WT_EXTERNREF, initExpr, isMutable);
  }

  patchGlobalI32(id, value) {
    const g = this.globals[id];
    g.initExpr = [];
    const code = new WasmCode(g.initExpr);
    code.i32Const(value);
    code.end();
  }

  addExport(name, kind, index) {
    this.exports.push({ name, kind, index });
  }

  addTag(funcTypeIdx) {
    const idx = this.tags.length;
    this.tags.push({ typeIdx: funcTypeIdx });
    return idx;
  }

  addDataSegment(offset, data) {
    const offsetExpr = [];
    const code = new WasmCode(offsetExpr);
    code.i32Const(offset);
    code.end();
    this.dataSegments.push({ memoryIndex: 0, offsetExpr, data });
  }

  // Emit full WASM binary as a Uint8Array
  emit() {
    const out = [];
    // WASM magic + version
    out.push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

    const emitSection = (id, content) => {
      out.push(id);
      lebU(out, content.length);
      for (const b of content) out.push(b);
    };
    const emitString = (buf, str) => {
      lebU(buf, str.length);
      for (let i = 0; i < str.length; i++) buf.push(str.charCodeAt(i));
    };

    let buf;

    // Type section (1).
    // Strategy: don't renumber types — eager registration already places
    // mutually-recursive types at consecutive indices (registration is driven
    // by reachability: registering type T pre-reserves T's idx, then recurses
    // into its references; back edges hit the pre-reserved idx, so an SCC's
    // members end up at consecutive indices). All we do here is GROUP them
    // into rec groups based on SCC analysis. Singleton non-recursive types
    // become singleton rec groups (or bare composites for func types).
    // WASM canonicalizes minimal rec groups by structural shape, so two
    // singleton structs with identical shapes get unified — this fixes
    // cross-TU recursive type identity.
    buf = [];
    const N = this.typeDefs.length;

    // ---- Phase 1: collect reference edges ----
    const edgesOut = Array.from({length: N}, () => []);
    const collectRefs = (td) => {
      const refs = [];
      const visitWT = (wt) => {
        if (wt && wt.tag === "ref" && wt.heapIsIdx) refs.push(wt.heap);
      };
      if (td.kind === "func") {
        for (const p of td.params) visitWT(p);
        for (const r of td.results) visitWT(r);
      } else if (td.kind === "struct") {
        if (td.parentIdx !== undefined) refs.push(td.parentIdx);
        if (td.fields) for (const f of td.fields) visitWT(f.wt);
      } else if (td.kind === "array") {
        if (td.elem) visitWT(td.elem.wt);
      }
      return refs;
    };
    for (let i = 0; i < N; i++) edgesOut[i] = collectRefs(this.typeDefs[i]);

    // ---- Phase 2: Tarjan SCC (iterative to avoid call-stack blowup) ----
    const indices = new Int32Array(N).fill(-1);
    const lowlinks = new Int32Array(N);
    const onStack = new Uint8Array(N);
    const sccOf = new Int32Array(N).fill(-1);  // sccOf[v] = SCC id (in discovery order)
    const stack = [];
    let nextIdx = 0;
    let nextSccId = 0;
    for (let root = 0; root < N; root++) {
      if (indices[root] !== -1) continue;
      // Iterative DFS using explicit stack of [v, edgeIdx]
      const dfsStack = [[root, 0]];
      indices[root] = nextIdx; lowlinks[root] = nextIdx; nextIdx++;
      stack.push(root); onStack[root] = 1;
      while (dfsStack.length) {
        const frame = dfsStack[dfsStack.length - 1];
        const u = frame[0];
        const ei = frame[1];
        const out = edgesOut[u];
        if (ei < out.length) {
          frame[1] = ei + 1;
          const w = out[ei];
          if (indices[w] === -1) {
            indices[w] = nextIdx; lowlinks[w] = nextIdx; nextIdx++;
            stack.push(w); onStack[w] = 1;
            dfsStack.push([w, 0]);
          } else if (onStack[w]) {
            if (indices[w] < lowlinks[u]) lowlinks[u] = indices[w];
          }
        } else {
          dfsStack.pop();
          if (lowlinks[u] === indices[u]) {
            const sccId = nextSccId++;
            let w;
            do { w = stack.pop(); onStack[w] = 0; sccOf[w] = sccId; } while (w !== u);
          }
          if (dfsStack.length) {
            const p = dfsStack[dfsStack.length - 1][0];
            if (lowlinks[u] < lowlinks[p]) lowlinks[p] = lowlinks[u];
          }
        }
      }
    }

    // ---- Phase 3: walk typeDefs in order, group consecutive same-SCC entries ----
    // We assert (and rely on) eager registration's invariant: if v and u are
    // in the same SCC, they are at consecutive indices. So we just scan and
    // chunk by sccOf changing.
    const groups = [];  // each: [startIdx, endIdxExclusive]
    let gi = 0;
    while (gi < N) {
      const sid = sccOf[gi];
      let gj = gi + 1;
      while (gj < N && sccOf[gj] === sid) gj++;
      groups.push([gi, gj]);
      gi = gj;
    }

    // ---- Phase 4: emit ----
    const emitStorage = (s, b) => {
      if (s.packed === "i8") b.push(0x78);
      else if (s.packed === "i16") b.push(0x77);
      else wtEmit(s.wt, b);
      b.push(s.mutable ? 0x01 : 0x00);
    };
    const emitOneTypeDef = (td, b) => {
      if (td.kind === "func") {
        b.push(0x60);
        lebU(b, td.params.length);
        for (const p of td.params) wtEmit(p, b);
        lebU(b, td.results.length);
        for (const r of td.results) wtEmit(r, b);
      } else if (td.kind === "struct") {
        // Always wrap GC structs in `sub` (open, 0x50) so they can be extended.
        // Bare composite types are treated as `final` by V8.
        b.push(0x50);
        if (td.parentIdx !== undefined) { lebU(b, 1); lebU(b, td.parentIdx); }
        else lebU(b, 0);
        b.push(0x5F);
        lebU(b, td.fields.length);
        for (const f of td.fields) emitStorage(f, b);
      } else if (td.kind === "array") {
        b.push(0x5E);
        emitStorage(td.elem, b);
      }
    };
    // Each group becomes one rec group (even singletons — being in a rec
    // group is what enables WASM canonicalization across instances).
    lebU(buf, groups.length);
    for (const [start, end] of groups) {
      buf.push(0x4E);
      lebU(buf, end - start);
      for (let k = start; k < end; k++) emitOneTypeDef(this.typeDefs[k], buf);
    }
    emitSection(1, buf);

    // Import section (2)
    buf = [];
    lebU(buf, this.funcImports.length);
    for (const imp of this.funcImports) {
      emitString(buf, imp.moduleName);
      emitString(buf, imp.functionName);
      buf.push(0x00); // func import kind
      lebU(buf, imp.typeId);
    }
    emitSection(2, buf);

    // Function section (3)
    buf = [];
    lebU(buf, this.funcDefs.length);
    for (const def of this.funcDefs) lebU(buf, def.typeId);
    emitSection(3, buf);

    // Table section (4)
    buf = [];
    const totalFuncs = this.funcImports.length + this.funcDefs.length;
    const tableSize = totalFuncs + 1;
    lebU(buf, 1); buf.push(0x70); buf.push(0x00); lebU(buf, tableSize);
    emitSection(4, buf);

    // Memory section (5)
    buf = [];
    lebU(buf, this.memories.length);
    for (const mem of this.memories) {
      const hasMax = mem.maxPages !== 0;
      buf.push(hasMax ? 0x01 : 0x00);
      lebU(buf, mem.minPages);
      if (hasMax) lebU(buf, mem.maxPages);
    }
    emitSection(5, buf);

    // Tag section (13) - before globals
    if (this.tags.length > 0) {
      buf = [];
      lebU(buf, this.tags.length);
      for (const tag of this.tags) { buf.push(0x00); lebU(buf, tag.typeIdx); }
      emitSection(13, buf);
    }

    // Global section (6)
    buf = [];
    lebU(buf, this.globals.length);
    for (const g of this.globals) {
      wtEmit(g.type, buf);
      buf.push(g.isMutable ? 0x01 : 0x00);
      for (const b of g.initExpr) buf.push(b);
    }
    emitSection(6, buf);

    // Export section (7)
    buf = [];
    lebU(buf, this.exports.length);
    for (const exp of this.exports) {
      emitString(buf, exp.name);
      buf.push(exp.kind);
      lebU(buf, exp.index);
    }
    emitSection(7, buf);

    // Element section (9)
    buf = [];
    if (totalFuncs > 0) {
      lebU(buf, 1); lebU(buf, 0);
      buf.push(0x41); lebI(buf, 1); buf.push(0x0B);
      lebU(buf, totalFuncs);
      for (let i = 0; i < totalFuncs; i++) lebU(buf, i);
    } else {
      lebU(buf, 0);
    }
    emitSection(9, buf);

    // Code section (10)
    buf = [];
    lebU(buf, this.funcDefs.length);
    var funcBodyOffsets = [];
    for (var fi = 0; fi < this.funcDefs.length; fi++) {
      const def = this.funcDefs[fi];
      const funcBody = [];
      lebU(funcBody, def.locals.length);
      for (const loc of def.locals) {
        lebU(funcBody, loc.count);
        wtEmit(loc.type, funcBody);
      }
      var preambleSize = funcBody.length;
      for (const b of def.body) funcBody.push(b);
      funcBody.push(0x0B); // end
      var sizeFieldStart = buf.length;
      lebU(buf, funcBody.length);
      var sizeFieldLen = buf.length - sizeFieldStart;
      funcBodyOffsets.push({ sectionRelOffset: buf.length + preambleSize });
      for (const b of funcBody) buf.push(b);
    }
    var codeSectionContentStart = out.length + 1 + lebSize(buf.length);
    emitSection(10, buf);

    // Data section (11)
    buf = [];
    lebU(buf, this.dataSegments.length);
    for (const seg of this.dataSegments) {
      lebU(buf, seg.memoryIndex);
      for (const b of seg.offsetExpr) buf.push(b);
      lebU(buf, seg.data.length);
      for (const b of seg.data) buf.push(b);
    }
    emitSection(11, buf);

    // Name custom section (0)
    if (this.funcNames.length > 0 || this.globalNames.length > 0 || this.localNames.length > 0 ||
        this.typeNames.length > 0 || this.fieldNames.length > 0) {
      buf = [];
      emitString(buf, "name");
      if (this.funcNames.length > 0) {
        const sub = [];
        lebU(sub, this.funcNames.length);
        for (const entry of this.funcNames) {
          lebU(sub, entry.idx);
          emitString(sub, entry.name);
        }
        buf.push(0x01);
        lebU(buf, sub.length);
        for (const b of sub) buf.push(b);
      }
      if (this.localNames.length > 0) {
        const sub = [];
        lebU(sub, this.localNames.length);
        for (const fn of this.localNames) {
          lebU(sub, fn.funcIdx);
          lebU(sub, fn.locals.length);
          for (const loc of fn.locals) {
            lebU(sub, loc.idx);
            emitString(sub, loc.name);
          }
        }
        buf.push(0x02);
        lebU(buf, sub.length);
        for (const b of sub) buf.push(b);
      }
      // Subsection 4: type names
      if (this.typeNames.length > 0) {
        const sub = [];
        // Sort by idx so the namemap is in ascending order (some tools require this)
        const sorted = this.typeNames.slice().sort((a, b) => a.idx - b.idx);
        lebU(sub, sorted.length);
        for (const entry of sorted) {
          lebU(sub, entry.idx);
          emitString(sub, entry.name);
        }
        buf.push(0x04);
        lebU(buf, sub.length);
        for (const b of sub) buf.push(b);
      }
      if (this.globalNames.length > 0) {
        const sub = [];
        lebU(sub, this.globalNames.length);
        for (const entry of this.globalNames) {
          lebU(sub, entry.idx);
          emitString(sub, entry.name);
        }
        buf.push(0x07);
        lebU(buf, sub.length);
        for (const b of sub) buf.push(b);
      }
      // Subsection 10: field names (indirect namemap)
      if (this.fieldNames.length > 0) {
        const sub = [];
        const sorted = this.fieldNames.slice().sort((a, b) => a.typeIdx - b.typeIdx);
        lebU(sub, sorted.length);
        for (const entry of sorted) {
          lebU(sub, entry.typeIdx);
          lebU(sub, entry.fields.length);
          for (const f of entry.fields) {
            lebU(sub, f.idx);
            emitString(sub, f.name);
          }
        }
        buf.push(0x0A);
        lebU(buf, sub.length);
        for (const b of sub) buf.push(b);
      }
      emitSection(0, buf);
    }

    // c.sourcemap custom section
    if (this.sourceMapEntries.length > 0) {
      buf = [];
      emitString(buf, "c.sourcemap");
      // File table
      lebU(buf, this.sourceMapFiles.length);
      for (const f of this.sourceMapFiles) emitString(buf, f);
      // Flatten all entries with absolute offsets
      var allEntries = [];
      for (const fse of this.sourceMapEntries) {
        var baseOffset = codeSectionContentStart + funcBodyOffsets[fse.funcIdx].sectionRelOffset;
        for (const e of fse.entries) {
          allEntries.push({ offset: baseOffset + e.offset, fileIdx: e.fileIdx, line: e.line });
        }
      }
      allEntries.sort((a, b) => a.offset - b.offset);
      // Delta-encoded entries
      lebU(buf, allEntries.length);
      var prevOffset = 0, prevFile = 0, prevLine = 0;
      for (var i = 0; i < allEntries.length; i++) {
        var e = allEntries[i];
        if (i === 0) {
          lebU(buf, e.offset);
          lebU(buf, e.fileIdx);
          lebU(buf, e.line);
        } else {
          lebU(buf, e.offset - prevOffset);
          lebI(buf, e.fileIdx - prevFile);
          lebI(buf, e.line - prevLine);
        }
        prevOffset = e.offset;
        prevFile = e.fileIdx;
        prevLine = e.line;
      }
      emitSection(0, buf);
    }

    // c.sources custom section (-g2: embed source files)
    if (this.embeddedSources) {
      buf = [];
      emitString(buf, "c.sources");
      var json = JSON.stringify(this.embeddedSources);
      for (var i = 0; i < json.length; i++) {
        var code = json.charCodeAt(i);
        if (code < 0x80) { buf.push(code); }
        else if (code < 0x800) { buf.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F)); }
        else { buf.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F)); }
      }
      emitSection(0, buf);
    }

    return new Uint8Array(out);
  }
}

// ====================
// Code Generator
// ====================

const EXPR_VALUE = "value";
const EXPR_DROP = "drop";

const LV_REGISTER = "register";
const LV_MEMORY = "memory";
const LV_GC_STRUCT_FIELD = "gc_struct_field";
const LV_GC_ARRAY_ELEM = "gc_array_elem";
const LV_ADDR_LOCAL = "addr_local";
const LV_ADDR_STATIC = "addr_static";
const LV_ADDR_FRAME = "addr_frame";

function isStructOrUnion(type) {
  return type.isAggregate() && !type.isArray();
}

function cToWasmType(type, wmod) {
  type = type.removeQualifiers();
  if (type === Types.TEXTERNREF) return WT_EXTERNREF;
  if (type === Types.TREFEXTERN) return WT_REFEXTERN;
  if (type === Types.TEQREF) return WT_EQREF;
  if (type.isWasmGCType()) {
    if (!wmod) throw new Error(`cToWasmType: GC type '${type.toString()}' requires wmod for registration`);
    return WT_GCREF(getOrCreateGCWasmTypeIdx(wmod, type), true);
  }
  if (type === Types.TFLOAT) return WT_F32;
  if (type === Types.TDOUBLE || type === Types.TLDOUBLE) return WT_F64;
  if (type === Types.TLLONG || type === Types.TULLONG) return WT_I64;
  return WT_I32;
}

function gcStorageTypeOf(wmod, t) {
  const ut = t.removeQualifiers();
  if (ut === Types.TCHAR || ut === Types.TSCHAR || ut === Types.TUCHAR || ut === Types.TBOOL) {
    return { wt: WT_I32, mutable: true, packed: "i8" };
  }
  if (ut === Types.TSHORT || ut === Types.TUSHORT) {
    return { wt: WT_I32, mutable: true, packed: "i16" };
  }
  return { wt: cToWasmType(t, wmod), mutable: true, packed: null };
}

// Cache key for a single WASM value type (numeric or ref).
function wtKey(wt) {
  if (wt.tag === "ref") return `ref:${wt.nullable?1:0}:${wt.heapIsIdx?'i':'h'}:${wt.heap}`;
  return `${wt.tag}:${wt.num||''}`;
}

// Cache key for a struct field / array elem storage type. Mutability is always
// true today; packed encoding distinguishes i8/i16 from i32 (signedness does
// not affect WASM storage, so it's intentionally not part of the key).
function gcStorageKey(s) {
  const tag = s.packed ? s.packed : wtKey(s.wt);
  return s.mutable ? tag : tag + ":imm";
}

// Helpers used by codegen to choose struct.get/array.get variants for packed fields.
function isSignedSubI32(t) {
  const ut = t.removeQualifiers();
  return ut === Types.TCHAR || ut === Types.TSCHAR || ut === Types.TSHORT;
}
function isPackedSubI32(t) {
  const ut = t.removeQualifiers();
  return ut === Types.TCHAR || ut === Types.TSCHAR || ut === Types.TUCHAR ||
         ut === Types.TBOOL || ut === Types.TSHORT || ut === Types.TUSHORT;
}

// Register a GC TypeInfo into the WasmModule and return its WASM type index.
// Deps are registered FIRST (so they get lower indices). Cycles are detected
// via a per-wmod "in-progress" set: if recursion re-enters a type currently
// being processed, we pre-reserve a placeholder idx so the cyclic ref has
// something to point at. SCC members end up at consecutive indices.
//
// Structural dedup happens BEFORE reservation — we compute the structural
// key from already-registered deps, then check the cache. If hit, no idx
// is reserved (no zombie typeDefs). If miss, reserve and populate.
// Compiler-internal box struct registry. For boxing primitives into __eqref,
// we need a dedicated GC struct type per primitive. We make the field IMMUTABLE
// so these boxes don't structurally collide with user-defined mutable structs
// of the same shape (preserving __ref_test discrimination).
function getOrCreateBoxStructIdx(wmod, primWt) {
  const fields = [{ wt: primWt, mutable: false, packed: null }];
  const key = 'S(' + fields.map(gcStorageKey).join(',') + ')';
  if (wmod.gcStructTypeIndices.has(key)) return wmod.gcStructTypeIndices.get(key);
  const idx = wmod.reserveGCStructTypeId();
  wmod.setGCStructFields(idx, fields);
  wmod.gcStructTypeIndices.set(key, idx);
  const name = primWt === WT_I64 ? '__Box_i64' : primWt === WT_F64 ? '__Box_f64' : '__Box';
  wmod.typeNames.push({ idx, name });
  wmod.fieldNames.push({ typeIdx: idx, fields: [{ idx: 0, name: 'v' }] });
  return idx;
}

// Map a numeric C type to the wasm storage type used for its box.
// Only two box types: __Box_i64 (all integers) and __Box_f64 (all floats).
// This lets cross-width unboxing work within the same category
// (e.g. box a float, unbox as double).
function boxStorageWtFor(type) {
  type = type.removeQualifiers();
  if (type === Types.TFLOAT || type === Types.TDOUBLE || type === Types.TLDOUBLE) return WT_F64;
  if (type.isInteger()) return WT_I64;
  return null;
}

function getOrCreateGCWasmTypeIdx(wmod, type) {
  type = type.removeQualifiers();
  // Normalize struct ref form to heap form — wasm type idx lives on the heap.
  if (type.isGCStruct()) type = type.baseType;
  const cached = wmod.gcTypeIdxByType.get(type);
  if (cached !== undefined) return cached;

  if (!wmod._gcInProgress) wmod._gcInProgress = new Set();
  if (!wmod._gcPendingIdx) wmod._gcPendingIdx = new Map();

  if (wmod._gcInProgress.has(type)) {
    // Cycle — must reserve a placeholder so the recursive ref resolves.
    let pending = wmod._gcPendingIdx.get(type);
    if (pending === undefined) {
      pending = type.isGCStructHeap()
        ? wmod.reserveGCStructTypeId()
        : wmod.reserveGCArrayTypeId();
      wmod._gcPendingIdx.set(type, pending);
    }
    return pending;
  }

  wmod._gcInProgress.add(type);

  let idx;
  if (type.isGCStructHeap()) {
    if (!type.isComplete) {
      wmod._gcInProgress.delete(type);
      throw new Error(`Cannot use incomplete GC struct '${type.tagName}'`);
    }
    // Register deps (parent + field types) first.
    const parentIdx = type.parentType ? getOrCreateGCWasmTypeIdx(wmod, type.parentType) : -1;
    const fields = type.tagDecl.members.map(m => gcStorageTypeOf(wmod, m.type));
    const key = 'S(' + (parentIdx >= 0 ? `p${parentIdx},` : '') +
                fields.map(gcStorageKey).join(',') + ')';
    const pending = wmod._gcPendingIdx.get(type);
    if (pending !== undefined) {
      // Cyclic: must use the pre-reserved placeholder. Cache it under the
      // structural key, but a future identical type with NO cycle won't
      // dedup against this (its own key would include a different
      // placeholder idx) — that's fine, WASM rec-group canonicalization
      // handles the cross-canonical-form unification at instantiation.
      idx = pending;
      wmod._gcPendingIdx.delete(type);
      wmod.gcTypeIdxByType.set(type, idx);
      wmod.setGCStructFields(idx, fields, parentIdx);
      if (!wmod.gcStructTypeIndices.has(key)) wmod.gcStructTypeIndices.set(key, idx);
      if (type.tagName && !type.tagName.startsWith('__anon_gc_')) {
        wmod.typeNames.push({ idx, name: type.tagName });
        const fieldEntries = [];
        for (let i = 0; i < type.tagDecl.members.length; i++) {
          const m = type.tagDecl.members[i];
          if (m.name) fieldEntries.push({ idx: i, name: m.name });
        }
        if (fieldEntries.length > 0) wmod.fieldNames.push({ typeIdx: idx, fields: fieldEntries });
      }
    } else if (wmod.gcStructTypeIndices.has(key)) {
      // Cache hit, no reservation needed — no zombie typeDef.
      idx = wmod.gcStructTypeIndices.get(key);
      wmod.gcTypeIdxByType.set(type, idx);
    } else {
      idx = wmod.reserveGCStructTypeId();
      wmod.gcTypeIdxByType.set(type, idx);
      wmod.setGCStructFields(idx, fields, parentIdx);
      wmod.gcStructTypeIndices.set(key, idx);
      // Record names for the name custom section. First struct registered with
      // this shape wins the name (subsequent dedupe-hit registrations don't
      // override). Anonymous tags (`__anon_gc_*`) are skipped — those are
      // compiler-internal and don't help debuggers.
      if (type.tagName && !type.tagName.startsWith('__anon_gc_')) {
        wmod.typeNames.push({ idx, name: type.tagName });
        const fieldEntries = [];
        for (let i = 0; i < type.tagDecl.members.length; i++) {
          const m = type.tagDecl.members[i];
          if (m.name) fieldEntries.push({ idx: i, name: m.name });
        }
        if (fieldEntries.length > 0) wmod.fieldNames.push({ typeIdx: idx, fields: fieldEntries });
      }
    }
  } else if (type.isGCArray()) {
    const elem = gcStorageTypeOf(wmod, type.baseType);
    const key = 'A(' + gcStorageKey(elem) + ')';
    const pending = wmod._gcPendingIdx.get(type);
    if (pending !== undefined) {
      idx = pending;
      wmod._gcPendingIdx.delete(type);
      wmod.gcTypeIdxByType.set(type, idx);
      wmod.setGCArrayElem(idx, elem);
      if (!wmod.gcArrayTypeIndices.has(key)) wmod.gcArrayTypeIndices.set(key, idx);
    } else if (wmod.gcArrayTypeIndices.has(key)) {
      idx = wmod.gcArrayTypeIndices.get(key);
      wmod.gcTypeIdxByType.set(type, idx);
    } else {
      idx = wmod.reserveGCArrayTypeId();
      wmod.gcTypeIdxByType.set(type, idx);
      wmod.setGCArrayElem(idx, elem);
      wmod.gcArrayTypeIndices.set(key, idx);
    }
  } else {
    wmod._gcInProgress.delete(type);
    throw new Error(`getOrCreateGCWasmTypeIdx: not a GC type: ${type.toString()}`);
  }

  wmod._gcInProgress.delete(type);
  return idx;
}

function vaSlotSize(type) {
  const sz = type.size;
  return (sz + 7) & ~7;
}

// ── Shared constant-expression evaluator ────────────────────────────────────
// Used by both the default backend and the GUC backend. Walks an Expr tree
// and either returns a value descriptor:
//   { kind: "int",   intVal: BigInt }
//   { kind: "float", floatVal: Number }
//   { kind: "addr",  addrVal: Number }
// or null when the expression is not a constant.
//
// The `policy` argument resolves the four kinds of address LEAVES the C
// language allows in a constant expression — string literals, global
// variables, function pointers, and file-scope compound literals — to a
// numeric address. The default backend supplies concrete addresses
// (translation-time-known); the GUC backend supplies a null-policy because
// its addresses are not numbers — they're deferred IR tokens (MutableBytesAddr,
// FuncIndex) substituted at codegen-time. Returning null from a leaf simply
// causes that branch to evaluate to null, so the integer / float / sizeof /
// arithmetic / ternary / cast subset still works for both backends.
//
// Policy interface (each method returns a number or null):
//   getStringAddr(uint8Array)    — address of a string literal
//   getGlobalAddr(varDecl)       — address of a global variable's storage
//   getFuncAddr(funcDef)         — funcref-table index of a function
//   getCompoundLitAddr(expr)     — address of a file-scope compound literal
const NULL_ADDR_POLICY = {
  getStringAddr: () => null,
  getGlobalAddr: () => null,
  getFuncAddr: () => null,
  getCompoundLitAddr: () => null,
};

function constEvalAddr(expr, policy) {
  if (!expr) return null;
  // Decay wraps an array/function lvalue with the decayed pointer type;
  // its address-of value is the operand's base address.
  if (expr instanceof AST.EDecay) return constEvalAddr(expr.operand, policy);
  // Cast from integer to pointer: (type*)intval
  if (expr instanceof AST.ECast || expr instanceof AST.EImplicitCast) {
    const inner = constEvalExpr(expr.expr, policy);
    if (inner && inner.kind === "int") return Number(inner.intVal);
    if (inner && inner.kind === "addr") return inner.addrVal;
    return null;
  }
  // Arrow: base->member → addr(base) + offset, where base is pointer
  if (expr instanceof AST.EArrow) {
    const baseVal = constEvalExpr(expr.base, policy);
    if (baseVal && (baseVal.kind === "addr" || baseVal.kind === "int")) {
      const baseAddr = baseVal.kind === "addr" ? baseVal.addrVal : Number(baseVal.intVal);
      return baseAddr + expr.memberDecl.byteOffset;
    }
    return null;
  }
  // General: try constEvalExpr and extract address
  const v = constEvalExpr(expr, policy);
  if (v && v.kind === "addr") return v.addrVal;
  if (v && v.kind === "int") return Number(v.intVal);
  return null;
}

function constEvalExpr(expr, policy) {
  if (!expr) return null;
  switch (expr.constructor) {
    case AST.EInt: return { kind: "int", intVal: expr.value };
    case AST.EFloat: return { kind: "float", floatVal: expr.value };
    case AST.EString: {
      const addr = policy.getStringAddr(expr.value);
      if (addr === null || addr === undefined) return null;
      return { kind: "addr", addrVal: addr };
    }
    case AST.EIdent: {
      if (expr.decl && expr.decl instanceof AST.DEnumConst) {
        return { kind: "int", intVal: BigInt(expr.decl.value) };
      }
      if (expr.decl && expr.decl instanceof AST.DFunc) {
        const func = expr.decl.definition || expr.decl;
        const tIdx = policy.getFuncAddr(func);
        if (tIdx !== null && tIdx !== undefined) return { kind: "addr", addrVal: tIdx };
      }
      if (expr.decl && expr.decl instanceof AST.DVar) {
        const varDecl = expr.decl.definition || expr.decl;
        const addr = policy.getGlobalAddr(varDecl);
        if (addr !== null && addr !== undefined) return { kind: "addr", addrVal: addr };
      }
      return null;
    }
    case AST.EUnary: {
      if (expr.op === "OP_ADDR") {
        const inner = expr.operand;
        // &var → address
        if (inner instanceof AST.EIdent && inner.decl) {
          if (inner.decl instanceof AST.DVar) {
            const varDecl = inner.decl.definition || inner.decl;
            const addr = policy.getGlobalAddr(varDecl);
            if (addr !== null && addr !== undefined) return { kind: "addr", addrVal: addr };
          }
          if (inner.decl instanceof AST.DFunc) {
            const func = inner.decl.definition || inner.decl;
            const tIdx = policy.getFuncAddr(func);
            if (tIdx !== null && tIdx !== undefined) return { kind: "addr", addrVal: tIdx };
          }
        }
        // &(base->member) or &(base.member) → base_addr + member offset
        if (inner instanceof AST.EArrow || inner instanceof AST.EMember) {
          const baseAddr = constEvalAddr(inner.base, policy);
          if (baseAddr !== null) {
            return { kind: "addr", addrVal: baseAddr + inner.memberDecl.byteOffset };
          }
        }
        // &(base[index]) → base_addr + index * elemSize
        if (inner instanceof AST.ESubscript) {
          const baseAddr = constEvalAddr(inner.array, policy);
          const idx = constEvalExpr(inner.index, policy);
          if (baseAddr !== null && idx && idx.kind === "int") {
            const elemSize = inner.type.size;
            return { kind: "addr", addrVal: baseAddr + Number(idx.intVal) * elemSize };
          }
        }
        // &(compound_literal) → address of file-scope compound literal
        if (inner instanceof AST.ECompoundLiteral) {
          const addr = policy.getCompoundLitAddr(inner);
          if (addr !== null && addr !== undefined) return { kind: "addr", addrVal: addr };
        }
        return null;
      }
      const v = constEvalExpr(expr.operand, policy);
      if (!v) return null;
      if (expr.op === "OP_POS") return v;
      if (expr.op === "OP_NEG") {
        if (v.kind === "int") return { kind: "int", intVal: -v.intVal };
        if (v.kind === "float") return { kind: "float", floatVal: -v.floatVal };
      }
      if (expr.op === "OP_BNOT") {
        if (v.kind === "int") return { kind: "int", intVal: ~v.intVal };
      }
      if (expr.op === "OP_LNOT") {
        if (v.kind === "int") return { kind: "int", intVal: v.intVal === 0n ? 1n : 0n };
        if (v.kind === "float") return { kind: "int", intVal: v.floatVal === 0.0 ? 1n : 0n };
      }
      return null;
    }
    case AST.EBinary: {
      // Short-circuit LAND/LOR
      if (expr.op === "LAND") {
        const l = constEvalExpr(expr.left, policy);
        if (!l) return null;
        const lv = l.kind === "int" ? l.intVal : l.kind === "float" ? (l.floatVal !== 0.0 ? 1n : 0n) : null;
        if (lv === null) return null;
        if (lv === 0n) return { kind: "int", intVal: 0n };
        const r = constEvalExpr(expr.right, policy);
        if (!r) return null;
        const rv = r.kind === "int" ? r.intVal : r.kind === "float" ? (r.floatVal !== 0.0 ? 1n : 0n) : null;
        if (rv === null) return null;
        return { kind: "int", intVal: rv !== 0n ? 1n : 0n };
      }
      if (expr.op === "LOR") {
        const l = constEvalExpr(expr.left, policy);
        if (!l) return null;
        const lv = l.kind === "int" ? l.intVal : l.kind === "float" ? (l.floatVal !== 0.0 ? 1n : 0n) : null;
        if (lv === null) return null;
        if (lv !== 0n) return { kind: "int", intVal: 1n };
        const r = constEvalExpr(expr.right, policy);
        if (!r) return null;
        const rv = r.kind === "int" ? r.intVal : r.kind === "float" ? (r.floatVal !== 0.0 ? 1n : 0n) : null;
        if (rv === null) return null;
        return { kind: "int", intVal: rv !== 0n ? 1n : 0n };
      }
      const l = constEvalExpr(expr.left, policy);
      const r = constEvalExpr(expr.right, policy);
      if (!l || !r) return null;
      // Check for address arithmetic first
      const hasAddr = (l.kind === "addr" || r.kind === "addr");
      const hasFloat = (l.kind === "float" || r.kind === "float");
      if (!hasAddr && !hasFloat && l.kind === "int" && r.kind === "int") {
        const lv = l.intVal, rv = r.intVal;
        let result;
        switch (expr.op) {
          case "ADD": result = lv + rv; break;
          case "SUB": result = lv - rv; break;
          case "MUL": result = lv * rv; break;
          case "DIV": result = rv === 0n ? null : lv / rv; break;
          case "MOD": result = rv === 0n ? null : lv % rv; break;
          case "BAND": result = lv & rv; break;
          case "BOR": result = lv | rv; break;
          case "BXOR": result = lv ^ rv; break;
          case "SHL": result = lv << rv; break;
          case "SHR": result = lv >> rv; break;
          case "EQ": result = lv === rv ? 1n : 0n; break;
          case "NE": result = lv !== rv ? 1n : 0n; break;
          case "LT": result = lv < rv ? 1n : 0n; break;
          case "GT": result = lv > rv ? 1n : 0n; break;
          case "LE": result = lv <= rv ? 1n : 0n; break;
          case "GE": result = lv >= rv ? 1n : 0n; break;
          default: return null;
        }
        if (result === null) return null;
        return { kind: "int", intVal: result };
      }
      if (!hasAddr && hasFloat) {
        const lv = l.kind === "float" ? l.floatVal : Number(l.intVal);
        const rv = r.kind === "float" ? r.floatVal : Number(r.intVal);
        switch (expr.op) {
          case "ADD": return { kind: "float", floatVal: lv + rv };
          case "SUB": return { kind: "float", floatVal: lv - rv };
          case "MUL": return { kind: "float", floatVal: lv * rv };
          case "DIV": return { kind: "float", floatVal: lv / rv }; // IEEE 754: div by zero = infinity
          case "EQ": return { kind: "int", intVal: lv === rv ? 1n : 0n };
          case "NE": return { kind: "int", intVal: lv !== rv ? 1n : 0n };
          case "LT": return { kind: "int", intVal: lv < rv ? 1n : 0n };
          case "GT": return { kind: "int", intVal: lv > rv ? 1n : 0n };
          case "LE": return { kind: "int", intVal: lv <= rv ? 1n : 0n };
          case "GE": return { kind: "int", intVal: lv >= rv ? 1n : 0n };
          default: return null;
        }
      }
      if (hasAddr) {
        // addr + int, addr - int (pointer arithmetic: scale by pointee size)
        if (l.kind === "addr" && r.kind === "int" && (expr.op === "ADD" || expr.op === "SUB")) {
          const elemType = AST.pointerArithElemType(expr.left.type, expr.right.type);
          const elemSize = elemType ? elemType.size : 1;
          const offset = Number(r.intVal) * elemSize;
          return { kind: "addr", addrVal: expr.op === "ADD" ? l.addrVal + offset : l.addrVal - offset };
        }
        // int + addr
        if (r.kind === "addr" && l.kind === "int" && expr.op === "ADD") {
          const elemType = AST.pointerArithElemType(expr.left.type, expr.right.type);
          const elemSize = elemType ? elemType.size : 1;
          return { kind: "addr", addrVal: r.addrVal + Number(l.intVal) * elemSize };
        }
        // addr - addr (pointer difference)
        if (l.kind === "addr" && r.kind === "addr" && expr.op === "SUB") {
          const elemType = AST.pointerArithElemType(expr.left.type, expr.right.type);
          const elemSize = elemType ? elemType.size : 1;
          if (elemSize === 0) return null;
          return { kind: "int", intVal: BigInt(Math.trunc((l.addrVal - r.addrVal) / elemSize)) };
        }
        // addr comparisons
        if (l.kind === "addr" && r.kind === "addr") {
          switch (expr.op) {
            case "EQ": return { kind: "int", intVal: l.addrVal === r.addrVal ? 1n : 0n };
            case "NE": return { kind: "int", intVal: l.addrVal !== r.addrVal ? 1n : 0n };
            case "LT": return { kind: "int", intVal: l.addrVal < r.addrVal ? 1n : 0n };
            case "GT": return { kind: "int", intVal: l.addrVal > r.addrVal ? 1n : 0n };
            case "LE": return { kind: "int", intVal: l.addrVal <= r.addrVal ? 1n : 0n };
            case "GE": return { kind: "int", intVal: l.addrVal >= r.addrVal ? 1n : 0n };
          }
        }
      }
      return null;
    }
    case AST.ETernary: {
      const cond = constEvalExpr(expr.condition, policy);
      if (!cond) return null;
      let cv;
      if (cond.kind === "int") cv = cond.intVal !== 0n;
      else if (cond.kind === "float") cv = cond.floatVal !== 0.0;
      else return null;
      return constEvalExpr(cv ? expr.thenExpr : expr.elseExpr, policy);
    }
    case AST.ECast:
    case AST.EImplicitCast: {
      const v = constEvalExpr(expr.expr, policy);
      if (!v) return null;
      const t = expr.type.removeQualifiers();
      if ((t === Types.TFLOAT || t === Types.TDOUBLE) && v.kind === "int") {
        return { kind: "float", floatVal: Number(v.intVal) };
      }
      if (t.isInteger() && v.kind === "float") {
        return { kind: "int", intVal: Types.truncateConstInt(BigInt(Math.trunc(v.floatVal)), t) };
      }
      if ((t.isInteger() || t.isPointer()) && v.kind === "int") {
        return { kind: "int", intVal: Types.truncateConstInt(v.intVal, t) };
      }
      return v;
    }
    case AST.ESizeofExpr: return { kind: "int", intVal: BigInt(expr.expr.type.size) };
    case AST.ESizeofType: return { kind: "int", intVal: BigInt(expr.operandType.size) };
    case AST.EAlignofExpr: return { kind: "int", intVal: BigInt(expr.expr.type.align) };
    case AST.EAlignofType: return { kind: "int", intVal: BigInt(expr.operandType.align) };
    case AST.ECompoundLiteral: {
      // For scalar compound literals like (int){42}, extract the value
      if (!expr.type.isAggregate() && !expr.type.isArray() && expr.initList &&
          expr.initList.elements.length > 0) {
        return constEvalExpr(expr.initList.elements[0], policy);
      }
      // For aggregate/array compound literals, return the address
      const addr = policy.getCompoundLitAddr(expr);
      if (addr !== null && addr !== undefined) return { kind: "addr", addrVal: addr };
      return null;
    }
    case AST.EDecay: return constEvalExpr(expr.operand, policy);
    default: return null;
  }
}

function getWasmFunctionTypeIdForCFunctionType(wmod, funcType) {
  // Variadic functions use a single i32 param (arg block pointer) and no WASM return.
  if (funcType.isVarArg) {
    return wmod.addFunctionTypeId([WT_I32], []);
  }
  const params = [];
  const retType = funcType.getReturnType();
  if (isStructOrUnion(retType)) params.push(WT_I32); // hidden return ptr
  for (const pt of funcType.getParamTypes()) params.push(cToWasmType(pt, wmod));
  const results = [cToWasmType(retType, wmod)];
  return wmod.addFunctionTypeId(params, results);
}

class CodeGenerator {
  constructor(wmod, options) {
    this.wmod = wmod;
    this.compilerOptions = options?.compilerOptions || {};
    this.warningFlags = options?.warningFlags || {};
    this.writeErr = options?.writeErr
      || (typeof process !== 'undefined' && process.stderr ? (s) => process.stderr.write(s) : (s) => console.error(s));
    this.funcDefToWasmFuncIdx = new Map();
    this.funcDefToTableIdx = new Map();
    this.globalVarToWasmGlobalIdx = new Map();
    this.globalArrayAddrs = new Map();
    this.fileScopeCompoundLiteralAddrs = new Map();
    this.stackPages = 1;
    this.staticDataOffset = 0;
    this.staticData = [];
    this.stringLiteralAddrs = new Map();
    this.stackPointerGlobalIdx = 0;
    this.heapBaseGlobalIdx = 0;
    // Per-function state
    this.body = null;
    this.localVarToWasmLocalIdx = new Map();
    this.localArrayOffsets = new Map();
    this.paramMemoryOffsets = new Map();
    this.compoundLiteralOffsets = new Map();
    this.frameSize = 0;
    this.savedSpLocalIdx = 0;
    this.currentFuncLocals = null;
    this.nextLocalIdx = 0;
    this.freeLocalsByType = new Map();
    this.localScopeStack = [];
    this.structRetDeferred = 0;
    this.callNesting = 0;
    this.blockDepth = 0;
    this.breakTarget = 0;
    this.continueTarget = 0;
    // SLabel → blockDepth at which its block was opened. Maintained by
    // emitStmt's COMPOUND / SWITCH cases as they emit `block()`/`loop()`
    // for forward and loop labels; the GOTO case looks up the target's
    // depth and emits `br(blockDepth - targetDepth)`. Targets out of
    // scope produce a goto error appended to `gotoErrors`.
    this.gotoLabelDepths = new Map();
    this.gotoErrors = []; // {message, filename, line}
    this.exceptionToWasmTagIdx = new Map();
    this.currentFuncDef = null;
    this.vaArgsLocalIdx = 0;
    this.hasVaArgs = false;
    this.argBlockLocalIdx = 0;
    this.vaRetSlotSize = 0;
    this.vaParamInfos = [];
    this.vaStartOffset = 0;
    this.structRetPtrLocalIdx = 0;
    this.hasStructReturn = false;
    this.localIdxNames = new Map();
    // Source map tracking: per-function arrays of {offset, fileIdx, line}
    this.sourceMapEntries = [];
    this.sourceMapFiles = [];
    this.sourceMapFileIndex = new Map();
    this.currentFuncSourceMap = null;
  }

  // --- Local allocator ---
  _recordSourceLoc(loc) {
    if (!loc || !this.currentFuncSourceMap || !this.body) return;
    var fileIdx = this.sourceMapFileIndex.get(loc.filename);
    if (fileIdx === undefined) {
      fileIdx = this.sourceMapFiles.length;
      this.sourceMapFiles.push(loc.filename);
      this.sourceMapFileIndex.set(loc.filename, fileIdx);
    }
    var last = this.currentFuncSourceMap[this.currentFuncSourceMap.length - 1];
    if (last && last.fileIdx === fileIdx && last.line === loc.line) return;
    this.currentFuncSourceMap.push({ offset: this.body.bytes.length, fileIdx: fileIdx, line: loc.line });
  }

  _trackLocalName(idx, name) {
    if (!name) return;
    let s = this.localIdxNames.get(idx);
    if (!s) { s = new Set(); this.localIdxNames.set(idx, s); }
    s.add(name);
  }
  _wtKey(wt) {
    if (wt.tag === "ref") return `ref:${wt.nullable?1:0}:${wt.heapIsIdx?'i':'h'}:${wt.heap}`;
    return `${wt.tag}:${wt.num||''}`;
  }

  allocLocal(wt) {
    const key = this._wtKey(wt);
    const free = this.freeLocalsByType.get(key);
    if (free && free.length > 0) {
      const idx = free.pop();
      if (this.localScopeStack.length > 0) {
        this.localScopeStack[this.localScopeStack.length - 1].push([key, idx]);
      }
      return idx;
    }
    const idx = this.nextLocalIdx++;
    const locals = this.currentFuncLocals;
    if (locals.length > 0 && this._wtKey(locals[locals.length - 1].type) === key) {
      locals[locals.length - 1].count++;
    } else {
      locals.push({ type: wt, count: 1 });
    }
    if (this.localScopeStack.length > 0) {
      this.localScopeStack[this.localScopeStack.length - 1].push([key, idx]);
    }
    return idx;
  }

  pushLocalScope() { this.localScopeStack.push([]); }
  popLocalScope() {
    const scope = this.localScopeStack.pop();
    if (this.compilerOptions.noReuseLocals) return;
    for (const [key, idx] of scope) {
      if (!this.freeLocalsByType.has(key)) this.freeLocalsByType.set(key, []);
      this.freeLocalsByType.get(key).push(idx);
    }
  }

  // --- Size/Align helpers ---
  sizeOf(type) { return type.size; }
  alignOf(type) { return type.align; }

  // --- String literal deduplication ---
  getStringAddress(valueArray) {
    // valueArray is a Uint8Array or regular array of bytes
    const key = Array.from(valueArray).join(",");
    if (this.stringLiteralAddrs.has(key)) return this.stringLiteralAddrs.get(key);
    const baseAddr = this.stackPages * 65536;
    const addr = baseAddr + this.staticDataOffset;
    this.stringLiteralAddrs.set(key, addr);
    for (const b of valueArray) this.staticData.push(b);
    this.staticDataOffset += valueArray.length;
    return addr;
  }

  // --- Static memory allocation ---
  allocateStatic(size, align) {
    if (!align) align = 4;
    const alignedOffset = (this.staticDataOffset + align - 1) & ~(align - 1);
    const padding = alignedOffset - this.staticDataOffset;
    for (let i = 0; i < padding; i++) this.staticData.push(0);
    this.staticDataOffset = alignedOffset;
    const baseAddr = this.stackPages * 65536;
    const addr = baseAddr + this.staticDataOffset;
    for (let i = 0; i < size; i++) this.staticData.push(0);
    this.staticDataOffset += size;
    return addr;
  }

  computeFAMExtraSize(type, initExpr) {
    if (!type.isTag() || !initExpr || !(initExpr instanceof AST.EInitList)) return 0;
    const tag = type.tagDecl;
    if (!tag || tag.tagKind !== Types.TagKind.STRUCT) return 0;
    const members = tag.members.filter(m => m instanceof AST.DVar);
    let famMember = null, famIdx = -1;
    for (let i = 0; i < members.length; i++) {
      if (members[i].type.isArray() && members[i].type.arraySize === 0) {
        famMember = members[i];
        famIdx = i;
      }
    }
    if (!famMember || famIdx < 0 || famIdx >= initExpr.elements.length) return 0;
    const famElem = initExpr.elements[famIdx];
    const elemType = famMember.type.baseType;
    const elemSize = this.sizeOf(elemType);
    if (famElem instanceof AST.EString) return famElem.value.length * elemSize;
    if (famElem instanceof AST.EInitList) return famElem.elements.length * elemSize;
    return elemSize;
  }

  computeInitAllocSize(type, initExpr) {
    return this.sizeOf(type) + this.computeFAMExtraSize(type, initExpr);
  }

  // --- Frame address ---
  emitFrameAddr(offset) {
    this.body.localGet(this.savedSpLocalIdx);
    const adj = offset - this.frameSize;
    if (adj !== 0) {
      this.body.i32Const(adj);
      this.body.aop(WT_I32, ALU.OP_ADD);
    }
  }

  // --- Field offset ---
  getFieldOffset(tag, field) { return field.byteOffset; }

  // --- Write scalar to static data ---
  writeConstValueToStatic(offset, type, val) {
    const ut = type.removeQualifiers();
    if ((ut === Types.TFLOAT || ut === Types.TDOUBLE) && val.kind === "int") {
      val = { kind: "float", floatVal: Number(val.intVal) };
    } else if ((ut === Types.TINT || ut === Types.TUINT || ut === Types.TLONG || ut === Types.TULONG ||
                ut === Types.TSHORT || ut === Types.TUSHORT || ut === Types.TCHAR || ut === Types.TUCHAR ||
                ut === Types.TLLONG || ut === Types.TULLONG) && val.kind === "float") {
      val = { kind: "int", intVal: BigInt(Math.trunc(val.floatVal)) };
    }
    const size = this.sizeOf(type);
    if (val.kind === "int") {
      let v = val.intVal;
      for (let b = 0; b < size; b++) {
        this.staticData[offset + b] = Number(v & 0xFFn);
        v >>= 8n;
      }
    } else if (val.kind === "float") {
      if (size === 4) {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setFloat32(0, val.floatVal, true);
        const bytes = new Uint8Array(buf);
        for (let b = 0; b < 4; b++) this.staticData[offset + b] = bytes[b];
      } else if (size === 8) {
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, val.floatVal, true);
        const bytes = new Uint8Array(buf);
        for (let b = 0; b < 8; b++) this.staticData[offset + b] = bytes[b];
      }
    } else if (val.kind === "addr") {
      let v = val.addrVal;
      for (let b = 0; b < size && b < 4; b++) {
        this.staticData[offset + b] = v & 0xFF;
        v >>>= 8;
      }
    }
  }

  writeStringLiteralToStatic(strValue, arrayType, offset) {
    const copySize = this.sizeOf(arrayType);
    // For incomplete arrays (FAM), copySize is 0; use full string length
    const len = copySize === 0 ? strValue.length : Math.min(copySize, strValue.length);
    for (let i = 0; i < len; i++) this.staticData[offset + i] = strValue[i];
  }

  // Build the address-resolution policy used by the shared module-scope
  // `constEvalExpr` / `constEvalAddr` evaluators. Caches per-instance so we
  // don't reallocate the policy object on every constant evaluation.
  _getConstEvalPolicy() {
    if (!this.__constEvalPolicy) {
      this.__constEvalPolicy = {
        getStringAddr: (v) => this.getStringAddress(v),
        getGlobalAddr: (vd) => {
          const a = this.globalArrayAddrs.get(vd);
          return a !== undefined ? a : null;
        },
        getFuncAddr: (fn) => {
          const a = this.funcDefToTableIdx.get(fn);
          return a !== undefined ? a : null;
        },
        getCompoundLitAddr: (e) => {
          const a = this.fileScopeCompoundLiteralAddrs.get(e);
          return a !== undefined ? a : null;
        },
      };
    }
    return this.__constEvalPolicy;
  }

  // Evaluate an expression as an address (returns a number or null)
  _constEvalAddr(expr) {
    return constEvalAddr(expr, this._getConstEvalPolicy());
  }

  // --- ConstEval for codegen ---
  makeConstEval() {
    return {
      evaluate: (expr) => this._constEvalExpr(expr),
    };
  }

  _constEvalExpr(expr) {
    return constEvalExpr(expr, this._getConstEvalPolicy());
  }

  // --- Populate init list into static data ---
  populateInitListStatic(initList, type, baseOffset) {
    if (type.isArray()) {
      const elemType = type.baseType;
      const elemSize = this.sizeOf(elemType);
      for (let i = 0; i < initList.elements.length; i++) {
        const elemOffset = baseOffset + i * elemSize;
        const elem = initList.elements[i];
        if (elem instanceof AST.EInitList) {
          this.populateInitListStatic(elem, elemType, elemOffset);
        } else if (elem instanceof AST.EString && elemType.isArray()) {
          this.writeStringLiteralToStatic(elem.value, elemType, elemOffset);
        } else {
          const val = this._constEvalExpr(elem);
          if (val) this.writeConstValueToStatic(elemOffset, elemType, val);
        }
      }
    } else if (type.isTag()) {
      const tag = type.tagDecl;
      if (!tag) return;
      if (tag.tagKind === Types.TagKind.STRUCT) {
        let elemIdx = 0;
        for (const member of tag.members) {
          if (!(member instanceof AST.DVar)) continue;
          if (member.bitWidth >= 0 && !member.name) continue;
          const fieldOffset = baseOffset + member.byteOffset;
          if (elemIdx < initList.elements.length) {
            const elem = initList.elements[elemIdx];

            if (member.bitWidth >= 0) {
              const val = this._constEvalExpr(elem);
              if (val) {
                const bw = member.bitWidth;
                const bo = member.bitOffset;
                const unitSize = this.sizeOf(member.type);
                const mask = (1 << bw) - 1;
                const bits = (Number(val.intVal) & mask);
                let unit = 0;
                for (let b = 0; b < unitSize; b++) unit |= this.staticData[fieldOffset + b] << (b * 8);
                unit = (unit & ~(mask << bo)) | (bits << bo);
                for (let b = 0; b < unitSize; b++) this.staticData[fieldOffset + b] = (unit >>> (b * 8)) & 0xFF;
              }
            } else if (elem instanceof AST.EInitList) {
              this.populateInitListStatic(elem, member.type, fieldOffset);
            } else if (elem instanceof AST.EString && member.type.isArray()) {
              this.writeStringLiteralToStatic(elem.value, member.type, fieldOffset);
            } else {
              const val = this._constEvalExpr(elem);
              if (val) this.writeConstValueToStatic(fieldOffset, member.type, val);
            }
          }
          elemIdx++;
        }
      } else if (tag.tagKind === Types.TagKind.UNION) {

        if (initList.elements.length > 0 && initList.elements[0] !== null) {
          const targetIdx = initList.unionMemberIndex >= 0 ? initList.unionMemberIndex : 0;
          let varIdx = 0;
          for (const member of tag.members) {
            if (!(member instanceof AST.DVar)) continue;
            if (varIdx++ !== targetIdx) continue;
            const elem = initList.elements[0];
            if (elem instanceof AST.EInitList) {
              this.populateInitListStatic(elem, member.type, baseOffset);
            } else if (elem instanceof AST.EString && member.type.isArray()) {
              this.writeStringLiteralToStatic(elem.value, member.type, baseOffset);
            } else {
              const val = this._constEvalExpr(elem);
              if (val) this.writeConstValueToStatic(baseOffset, member.type, val);
            }
            break;
          }
        }
      }
    }
  }

  allocateInitListStatic(initList, aggType) {
    const totalSize = this.sizeOf(aggType);
    const addr = this.allocateStatic(totalSize, this.alignOf(aggType));
    const baseOffset = addr - (this.stackPages * 65536);
    this.populateInitListStatic(initList, aggType, baseOffset);
    return addr;
  }

  // --- Runtime init list stores ---
  emitInitListRuntimeStores(initList, type, baseLocalIdx, baseOffset) {
    if (type.isArray()) {
      const elemType = type.baseType;
      const elemSize = this.sizeOf(elemType);
      for (let i = 0; i < initList.elements.length; i++) {
        const elemOffset = baseOffset + i * elemSize;
        const elem = initList.elements[i];
        if (elem === null) continue;  // sparse slot — zero-initialized by EInitList's bzero
        if (elem instanceof AST.EInitList) {
          this.emitInitListRuntimeStores(elem, elemType, baseLocalIdx, elemOffset);
        } else {
          const val = this._constEvalExpr(elem);
          if (!val) {
            if (elemType.isAggregate()) {
              this.body.localGet(baseLocalIdx);
              if (elemOffset) { this.body.i32Const(elemOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
              this.emitExpr(elem);
              this.body.i32Const(this.sizeOf(elemType));
              this.body.memoryCopy();
            } else {
              this.body.localGet(baseLocalIdx);
              if (elemOffset) { this.body.i32Const(elemOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
              this.emitExpr(elem);
              this.emitConversion(elem.type, elemType);
              this.emitStore(elemType);
            }
          }
        }
      }
    } else if (type.isTag()) {
      const tag = type.tagDecl;
      if (!tag) return;
      if (tag.tagKind === Types.TagKind.STRUCT) {
        let elemIdx = 0;
        for (const member of tag.members) {
          if (!(member instanceof AST.DVar)) continue;
          if (member.bitWidth >= 0 && !member.name) continue;
          const fieldOffset = baseOffset + member.byteOffset;
          if (elemIdx < initList.elements.length) {
            const elem = initList.elements[elemIdx];
            if (elem === null) { elemIdx++; continue; }  // sparse slot — zero-init
            if (member.bitWidth >= 0) {
              const val = this._constEvalExpr(elem);
              if (!val) {
                this.body.localGet(baseLocalIdx);
                if (fieldOffset) { this.body.i32Const(fieldOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
                this.emitExpr(elem);
                this.emitConversion(elem.type, member.type);
                this.emitBitFieldStore(member);
              }
            } else if (elem instanceof AST.EInitList) {
              this.emitInitListRuntimeStores(elem, member.type, baseLocalIdx, fieldOffset);
            } else {
              const val = this._constEvalExpr(elem);
              if (!val) {
                if (member.type.isAggregate()) {
                  this.body.localGet(baseLocalIdx);
                  if (fieldOffset) { this.body.i32Const(fieldOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
                  this.emitExpr(elem);
                  this.body.i32Const(this.sizeOf(member.type));
                  this.body.memoryCopy();
                } else {
                  this.body.localGet(baseLocalIdx);
                  if (fieldOffset) { this.body.i32Const(fieldOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
                  this.emitExpr(elem);
                  this.emitConversion(elem.type, member.type);
                  this.emitStore(member.type);
                }
              }
            }
          }
          elemIdx++;
        }
      } else if (tag.tagKind === Types.TagKind.UNION) {
        if (initList.elements.length > 0 && initList.elements[0] !== null) {
          const targetIdx = initList.unionMemberIndex >= 0 ? initList.unionMemberIndex : 0;
          let varIdx = 0;
          for (const member of tag.members) {
            if (!(member instanceof AST.DVar)) continue;
            if (varIdx++ !== targetIdx) continue;
            const elem = initList.elements[0];
            if (elem instanceof AST.EInitList) {
              this.emitInitListRuntimeStores(elem, member.type, baseLocalIdx, baseOffset);
            } else {
              const val = this._constEvalExpr(elem);
              if (!val) {
                if (member.type.isAggregate()) {
                  this.body.localGet(baseLocalIdx);
                  if (baseOffset) { this.body.i32Const(baseOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
                  this.emitExpr(elem);
                  this.body.i32Const(this.sizeOf(member.type));
                  this.body.memoryCopy();
                } else {
                  this.body.localGet(baseLocalIdx);
                  if (baseOffset) { this.body.i32Const(baseOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
                  this.emitExpr(elem);
                  this.emitConversion(elem.type, member.type);
                  this.emitStore(member.type);
                }
              }
            }
            break;
          }
        }
      }
    }
  }

  // --- Init to frame slot ---
  emitStringToFrameSlot(strValue, arrayType, frameOffset) {
    const arraySize = this.sizeOf(arrayType);
    const strLen = strValue.length;
    const copyLen = Math.min(arraySize, strLen);
    const srcAddr = this.getStringAddress(strValue);
    this.emitFrameAddr(frameOffset);
    this.body.i32Const(srcAddr);
    this.body.i32Const(copyLen);
    this.body.memoryCopy();
    if (copyLen < arraySize) {
      this.emitFrameAddr(frameOffset + copyLen);
      this.body.i32Const(0);
      this.body.i32Const(arraySize - copyLen);
      this.body.memoryFill();
    }
  }
  emitInitToFrameSlot(type, initExpr, frameOffset) {
    if (type.isArray() && initExpr instanceof AST.EString) {
      this.emitStringToFrameSlot(initExpr.value, type, frameOffset);
      return;
    }
    if (type.isAggregate() && initExpr instanceof AST.EInitList) {
      const il = initExpr;
      if (type.isArray() && il.elements.length === 1 && il.elements[0] instanceof AST.EString) {
        this.emitStringToFrameSlot(il.elements[0].value, type, frameOffset);
        return;
      }
      const srcAddr = this.allocateInitListStatic(il, type);
      this.emitFrameAddr(frameOffset);
      this.body.i32Const(srcAddr);
      this.body.i32Const(this.sizeOf(type));
      this.body.memoryCopy();
      this.pushLocalScope();
      const baseAddrLocal = this.allocLocal(WT_I32);
      this.emitFrameAddr(frameOffset);
      this.body.localSet(baseAddrLocal);
      this.emitInitListRuntimeStores(il, type, baseAddrLocal, 0);
      this.popLocalScope();
      return;
    }
    if (isStructOrUnion(type)) {
      this.emitFrameAddr(frameOffset);
      this.emitExpr(initExpr);
      this.body.i32Const(this.sizeOf(type));
      this.body.memoryCopy();
      return;
    }
    // Scalar
    this.emitFrameAddr(frameOffset);
    this.emitExpr(initExpr);
    this.emitStore(type);
  }

  emitCompoundLiteralInit(cl) {
    const offset = this.compoundLiteralOffsets.get(cl);
    if (cl.type.isAggregate()) {
      this.emitInitToFrameSlot(cl.type, cl.initList, offset);
    } else {
      const initExpr = (!cl.initList.elements || cl.initList.elements.length === 0)
        ? new AST.EInt(cl.loc, Types.TINT, 0n) : cl.initList.elements[0];
      this.emitInitToFrameSlot(cl.type, initExpr, offset);
    }
  }

  // --- Assign locals for a function ---
  assignLocals(funcDef) {
    const funcIdx = this.funcDefToWasmFuncIdx.get(funcDef);
    const defIdx = funcIdx - this.wmod.funcImports.length;
    this.currentFuncLocals = this.wmod.funcDefs[defIdx].locals;
    this.currentFuncLocals.length = 0;
    this.freeLocalsByType.clear();
    this.localScopeStack = [];
    this.localVarToWasmLocalIdx.clear();
    this.localIdxNames = new Map();

    let localIdx = 0;
    this.hasVaArgs = !!funcDef.type.isVarArg;
    this.vaParamInfos = [];
    this.vaStartOffset = 0;
    this.vaRetSlotSize = 0;

    if (this.hasVaArgs) {
      // New variadic convention: single WASM parameter = arg block pointer.
      this.argBlockLocalIdx = localIdx++;
      this.nextLocalIdx = localIdx;

      const retType = funcDef.type.getReturnType();
      this.vaRetSlotSize = (retType === Types.TVOID) ? 0 : vaSlotSize(retType);

      let paramOffset = this.vaRetSlotSize;
      for (const param of funcDef.parameters) {
        const wt = isStructOrUnion(param.type) ? WT_I32 : cToWasmType(param.type, this.wmod);
        const paramLocalIdx = this.allocLocal(wt);
        this.localVarToWasmLocalIdx.set(param, paramLocalIdx);
        this._trackLocalName(paramLocalIdx, param.name);
        const slotSz = vaSlotSize(param.type);
        this.vaParamInfos.push({ var: param, localIdx: paramLocalIdx, offset: paramOffset });
        paramOffset += slotSz;
      }
      this.vaStartOffset = paramOffset;
      this.vaArgsLocalIdx = this.allocLocal(WT_I32);
      this.hasStructReturn = false;
    } else {
      this.hasStructReturn = isStructOrUnion(funcDef.type.getReturnType());
      if (this.hasStructReturn) this.structRetPtrLocalIdx = localIdx++;
      for (const param of funcDef.parameters) {
        this.localVarToWasmLocalIdx.set(param, localIdx);
        this._trackLocalName(localIdx, param.name);
        localIdx++;
      }
      this.nextLocalIdx = localIdx;
    }

    // Collect MEMORY vars
    const memoryVars = [];
    const addMemoryDecls = (decls) => {
      for (const decl of decls) {
        if (decl instanceof AST.DVar && decl.storageClass !== Types.StorageClass.STATIC) {
          const def = decl.definition || decl;
          if (def === decl && def.allocClass === Types.AllocClass.MEMORY) memoryVars.push(decl);
        }
      }
    };
    const stack = [funcDef.body];
    while (stack.length > 0) {
      const stmt = stack.pop();
      if (!stmt) continue;
      switch (stmt.constructor) {
        case AST.SDecl: addMemoryDecls(stmt.declarations); break;
        case AST.SCompound:
          for (let i = stmt.statements.length - 1; i >= 0; i--) stack.push(stmt.statements[i]);
          break;
        case AST.SIf:
          stack.push(stmt.thenBranch);
          if (stmt.elseBranch) stack.push(stmt.elseBranch);
          break;
        case AST.SWhile: stack.push(stmt.body); break;
        case AST.SDoWhile: stack.push(stmt.body); break;
        case AST.SFor:
          if (stmt.init && stmt.init instanceof AST.SDecl) addMemoryDecls(stmt.init.declarations);
          stack.push(stmt.body);
          break;
        case AST.SSwitch:
          for (let i = stmt.body.statements.length - 1; i >= 0; i--) stack.push(stmt.body.statements[i]);
          break;
        case AST.STryCatch:
          stack.push(stmt.tryBody);
          for (const cc of stmt.catches) stack.push(cc.body);
          break;
      }
    }

    // Memory parameters
    const memoryParams = [];
    for (const param of funcDef.parameters) {
      const def = param.definition || param;
      if (def.allocClass === Types.AllocClass.MEMORY) memoryParams.push(param);
    }

    // Compute frame layout
    this.localArrayOffsets.clear();
    this.paramMemoryOffsets.clear();
    this.compoundLiteralOffsets.clear();
    this.frameSize = 0;
    // Eager peek: do we have any frame-scope compound literals?
    let hasFrameCompoundLiterals = false;
    if (funcDef.body) {
      for (const cl of funcDef.body.referencedCompoundLiterals) {
        if (!this.fileScopeCompoundLiteralAddrs.has(cl)) {
          hasFrameCompoundLiterals = true;
          break;
        }
      }
    }
    if (memoryVars.length > 0 || memoryParams.length > 0 || hasFrameCompoundLiterals) {
      this.savedSpLocalIdx = this.allocLocal(WT_I32);
      let offset = 0;
      for (const v of memoryVars) {
        let a = this.alignOf(v.type);
        if (v.requestedAlignment > 0 && v.requestedAlignment > a) a = v.requestedAlignment;
        offset = (offset + a - 1) & ~(a - 1);
        this.localArrayOffsets.set(v, offset);
        offset += this.sizeOf(v.type);
      }
      for (const p of memoryParams) {
        const a = this.alignOf(p.type);
        offset = (offset + a - 1) & ~(a - 1);
        this.paramMemoryOffsets.set(p, offset);
        offset += this.sizeOf(p.type);
      }
      // Frame-scope compound literals: walk the body's bag. Anything
      // already allocated as a file-scope (static-storage) literal is
      // skipped — its address is global, not frame-relative.
      if (funcDef.body) {
        for (const cl of funcDef.body.referencedCompoundLiterals) {
          if (this.fileScopeCompoundLiteralAddrs.has(cl)) continue;
          if (this.compoundLiteralOffsets.has(cl)) continue;
          const a = this.alignOf(cl.type);
          offset = (offset + a - 1) & ~(a - 1);
          this.compoundLiteralOffsets.set(cl, offset);
          offset += this.sizeOf(cl.type);
        }
      }
      this.frameSize = (offset + 15) & ~15;
    }

    // Warn when a single function's stack frame is at or above the
    // effective WASM stack size — calling it once is guaranteed to
    // underflow the stack pointer into linear-memory zero, which
    // silently corrupts memory and surfaces as a confusing trap in
    // whatever libc call happens next (we burned an hour finding this
    // in the Quake port). Off only via -Wno-large-stack-frame.
    if (this.warningFlags.largeStackFrame && this.frameSize > 0) {
      const stackBytes = this.stackPages * 65536;
      if (this.frameSize >= stackBytes) {
        const loc = funcDef.loc || {};
        const fname = loc.filename || "<unknown>";
        const line = loc.line || 0;
        this.writeErr(
          `${fname}:${line}: warning: function '${funcDef.name}' has a ` +
          `${this.frameSize}-byte stack frame, ` +
          `which meets or exceeds the ${stackBytes}-byte WASM stack — ` +
          `calling it will trap. Consider __minstack(N); at file scope, ` +
          `or move large locals to the heap [-Wlarge-stack-frame]\n`
        );
      }
    }
  }

  // --- Emit function body ---
  emitFunctionBody(funcDef) {
    const funcIdx = this.funcDefToWasmFuncIdx.get(funcDef);
    this.assignLocals(funcDef);
    const defIdx = funcIdx - this.wmod.funcImports.length;
    const wasmCode = new WasmCode(this.wmod.funcDefs[defIdx].body);
    this.body = wasmCode;
    this.currentFuncDef = funcDef;
    this.currentFuncSourceMap = this.compilerOptions.emitNames ? [] : null;
    this.structRetDeferred = 0;
    this.callNesting = 0;
    this.blockDepth = 0;
    this.gotoLabelDepths.clear();

    this._recordSourceLoc(funcDef.loc);

    // Variadic function prologue: load fixed params from arg block
    if (this.hasVaArgs) {
      for (const pi of this.vaParamInfos) {
        if (isStructOrUnion(pi.var.type)) {
          this.body.localGet(this.argBlockLocalIdx);
          if (pi.offset > 0) { this.body.i32Const(pi.offset); this.body.aop(WT_I32, ALU.OP_ADD); }
          this.body.localSet(pi.localIdx);
        } else {
          this.body.localGet(this.argBlockLocalIdx);
          if (pi.offset > 0) { this.body.i32Const(pi.offset); this.body.aop(WT_I32, ALU.OP_ADD); }
          this.emitVaArgLoad(pi.var.type);
          this.body.localSet(pi.localIdx);
        }
      }
      this.body.localGet(this.argBlockLocalIdx);
      if (this.vaStartOffset > 0) { this.body.i32Const(this.vaStartOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
      this.body.localSet(this.vaArgsLocalIdx);
    }

    // Stack frame prologue
    if (this.frameSize > 0) {
      this.body.globalGet(this.stackPointerGlobalIdx);
      this.body.localSet(this.savedSpLocalIdx);
      this.body.localGet(this.savedSpLocalIdx);
      this.body.i32Const(this.frameSize);
      this.body.aop(WT_I32, ALU.OP_SUB);
      this.body.globalSet(this.stackPointerGlobalIdx);
      // Copy MEMORY parameters
      for (const [paramVar, offset] of this.paramMemoryOffsets) {
        this.emitFrameAddr(offset);
        const paramIt = this.localVarToWasmLocalIdx.get(paramVar);
        if (paramIt !== undefined) {
          if (isStructOrUnion(paramVar.type)) {
            this.body.localGet(paramIt);
            this.body.i32Const(this.sizeOf(paramVar.type));
            this.body.memoryCopy();
          } else {
            this.body.localGet(paramIt);
            this.emitStore(paramVar.type);
          }
        }
      }
    }

    this.emitStmt(funcDef.body);

    // Epilogue
    this._recordSourceLoc(funcDef.loc);
    if (alwaysReturns(funcDef.body)) {
      this.body.unreachable();
    } else {
      if (this.frameSize > 0) {
        this.body.localGet(this.savedSpLocalIdx);
        this.body.globalSet(this.stackPointerGlobalIdx);
      }
      if (this.hasVaArgs) {
        // Variadic: WASM function returns void
      } else {
        const retType = funcDef.type.getReturnType();
        const wasmRetType = cToWasmType(retType, this.wmod);
        if (wtIsRef(wasmRetType) && !wasmRetType.nullable) this.body.unreachable();
        else if (wtIsRef(wasmRetType) && wasmRetType.heapIsIdx) this.body.refNullIdx(wasmRetType.heap);
        else if (wtIsRef(wasmRetType)) this.body.refNull(wasmRetType.heap);
        else if (wtEquals(wasmRetType, WT_I32)) this.body.i32Const(0);
        else if (wtEquals(wasmRetType, WT_I64)) this.body.i64Const(0n);
        else if (wtEquals(wasmRetType, WT_F32)) this.body.f32Const(0.0);
        else if (wtEquals(wasmRetType, WT_F64)) this.body.f64Const(0.0);
        else this.body.i32Const(0);
      }
      this.body.ret();
    }
    if (this.currentFuncSourceMap && this.currentFuncSourceMap.length > 0) {
      this.sourceMapEntries.push({ funcIdx: defIdx, entries: this.currentFuncSourceMap });
    }
    this.currentFuncSourceMap = null;
    this.body = null;

    if (this.compilerOptions.emitNames && this.localIdxNames.size > 0) {
      const locals = [];
      for (const [idx, names] of this.localIdxNames) {
        locals.push({ idx, name: [...names].join(",") });
      }
      locals.sort((a, b) => a.idx - b.idx);
      this.wmod.localNames.push({ funcIdx, locals });
    }
  }

  // --- Statement emission ---
  emitStmt(stmt) {
    if (!stmt) return;
    if (stmt.loc) this._recordSourceLoc(stmt.loc);
    switch (stmt.constructor) {
      case AST.SCompound: {
        this.pushLocalScope();
        const stmts = stmt.statements;
        // Open forward-label blocks. Forward labels' scope = from the start
        // of the compound up to the label statement itself.
        const forwardLabels = [];
        for (const s of stmts) {
          if (s instanceof AST.SLabel && s.hasGotos && !s.isSwitchLevel) {
            if (s.labelKind === Types.LabelKind.FORWARD || s.labelKind === Types.LabelKind.BOTH)
              forwardLabels.push(s);
          }
        }
        for (let i = forwardLabels.length - 1; i >= 0; i--) {
          this.body.block();
          this.blockDepth++;
          this.gotoLabelDepths.set(forwardLabels[i], this.blockDepth);
        }
        const openLoopLabels = [];
        for (const s of stmts) {
          if (s instanceof AST.SLabel) {
            if (!s.hasGotos) continue;
            if (s.labelKind === Types.LabelKind.FORWARD || s.labelKind === Types.LabelKind.BOTH) {
              for (let j = openLoopLabels.length - 1; j >= 0; j--) {
                this.gotoLabelDepths.delete(openLoopLabels[j]);
                this.blockDepth--;
                this.body.end();
              }
              openLoopLabels.length = 0;
              this.gotoLabelDepths.delete(s);
              this.blockDepth--;
              this.body.end();
            }
            if (s.labelKind === Types.LabelKind.LOOP || s.labelKind === Types.LabelKind.BOTH) {
              this.body.loop();
              this.blockDepth++;
              this.gotoLabelDepths.set(s, this.blockDepth);
              openLoopLabels.push(s);
            }
          } else {
            this.emitStmt(s);
          }
        }
        for (let j = openLoopLabels.length - 1; j >= 0; j--) {
          this.gotoLabelDepths.delete(openLoopLabels[j]);
          this.blockDepth--;
          this.body.end();
        }
        this.popLocalScope();
        break;
      }
      case AST.SExpr:
        this.emitExpr(stmt.expr, EXPR_DROP);
        break;
      case AST.SDecl: {
        for (const decl of stmt.declarations) {
          if (decl instanceof AST.DVar) {
            if (decl.storageClass !== Types.StorageClass.STATIC && decl.definition === decl &&
                decl.allocClass === Types.AllocClass.REGISTER) {
              const _li = this.allocLocal(cToWasmType(decl.type, this.wmod));
              this.localVarToWasmLocalIdx.set(decl, _li);
              this._trackLocalName(_li, decl.name);
            }
            if (decl.initExpr) {
              const lait = this.localArrayOffsets.get(decl);
              if (lait !== undefined) {
                this.emitInitToFrameSlot(decl.type, decl.initExpr, lait);
              } else {
                const lit = this.localVarToWasmLocalIdx.get(decl);
                if (lit !== undefined) {
                  this.emitExpr(decl.initExpr);
                  this.body.localSet(lit);
                }
              }
            }
          }
        }
        break;
      }
      case AST.SReturn: {
        if (this.hasVaArgs) {
          const retType = this.currentFuncDef.type.getReturnType();
          if (stmt.expr && isStructOrUnion(retType)) {
            this.body.localGet(this.argBlockLocalIdx);
            this.emitExpr(stmt.expr);
            this.body.i32Const(this.sizeOf(retType));
            this.body.memoryCopy();
          } else if (stmt.expr) {
            this.body.localGet(this.argBlockLocalIdx);
            this.emitExpr(stmt.expr);
            this.emitVaArgStore(retType);
          }
        } else if (stmt.expr && this.hasStructReturn) {
          this.body.localGet(this.structRetPtrLocalIdx);
          this.emitExpr(stmt.expr);
          this.body.i32Const(this.sizeOf(this.currentFuncDef.type.getReturnType()));
          this.body.memoryCopy();
          this.body.localGet(this.structRetPtrLocalIdx);
        } else if (stmt.expr) {
          this.emitExpr(stmt.expr);
          const retType = this.currentFuncDef.type.getReturnType();
        } else {
          if (!this.hasVaArgs) {
            const retType = this.currentFuncDef.type.getReturnType();
            if (retType.removeQualifiers() === Types.TREFEXTERN) this.body.unreachable();
            else if (retType.removeQualifiers() === Types.TEXTERNREF) this.body.refNull(0x6F);
            else this.body.i32Const(0);
          }
        }
        if (this.frameSize > 0) {
          this.body.localGet(this.savedSpLocalIdx);
          this.body.globalSet(this.stackPointerGlobalIdx);
        }
        this.body.ret();
        break;
      }
      case AST.SIf: {
        this.emitExpr(stmt.condition);
        this.emitConditionToI32(stmt.condition.type);
        if (stmt.elseBranch) {
          this.body.if_(WT_EMPTY); this.blockDepth++;
          this.emitStmt(stmt.thenBranch);
          this.body.else_();
          this.emitStmt(stmt.elseBranch);
          this.blockDepth--; this.body.end();
        } else {
          this.body.if_(WT_EMPTY); this.blockDepth++;
          this.emitStmt(stmt.thenBranch);
          this.blockDepth--; this.body.end();
        }
        break;
      }
      case AST.SWhile: {
        const savedBreak = this.breakTarget, savedContinue = this.continueTarget;
        this.body.block(); this.blockDepth++; this.breakTarget = this.blockDepth;
        this.body.loop(); this.blockDepth++; this.continueTarget = this.blockDepth;
        this.emitExpr(stmt.condition);
        this.emitConditionToI32(stmt.condition.type);
        this.body.aop(WT_I32, ALU.OP_EQZ);
        this.body.brIf(this.blockDepth - this.breakTarget);
        this.emitStmt(stmt.body);
        this.body.br(this.blockDepth - this.continueTarget);
        this.blockDepth--; this.body.end();
        this.blockDepth--; this.body.end();
        this.breakTarget = savedBreak; this.continueTarget = savedContinue;
        break;
      }
      case AST.SDoWhile: {
        const savedBreak = this.breakTarget, savedContinue = this.continueTarget;
        this.body.block(); this.blockDepth++; this.breakTarget = this.blockDepth;
        this.body.loop(); this.blockDepth++;
        const loopDepth = this.blockDepth;
        this.body.block(); this.blockDepth++; this.continueTarget = this.blockDepth;
        this.emitStmt(stmt.body);
        this.blockDepth--; this.body.end();
        this.emitExpr(stmt.condition);
        this.emitConditionToI32(stmt.condition.type);
        this.body.brIf(this.blockDepth - loopDepth);
        this.blockDepth--; this.body.end();
        this.blockDepth--; this.body.end();
        this.breakTarget = savedBreak; this.continueTarget = savedContinue;
        break;
      }
      case AST.SFor: {
        const savedBreak = this.breakTarget, savedContinue = this.continueTarget;
        this.pushLocalScope();
        if (stmt.init) this.emitStmt(stmt.init);
        this.body.block(); this.blockDepth++; this.breakTarget = this.blockDepth;
        this.body.loop(); this.blockDepth++;
        const loopTarget = this.blockDepth;
        if (stmt.condition) {
          this.emitExpr(stmt.condition);
          this.emitConditionToI32(stmt.condition.type);
          this.body.aop(WT_I32, ALU.OP_EQZ);
          this.body.brIf(this.blockDepth - this.breakTarget);
        }
        this.body.block(); this.blockDepth++; this.continueTarget = this.blockDepth;
        this.emitStmt(stmt.body);
        this.blockDepth--; this.body.end();
        if (stmt.increment) this.emitExpr(stmt.increment, EXPR_DROP);
        this.body.br(this.blockDepth - loopTarget);
        this.blockDepth--; this.body.end();
        this.blockDepth--; this.body.end();
        this.popLocalScope();
        this.breakTarget = savedBreak; this.continueTarget = savedContinue;
        break;
      }
      case AST.SBreak:
        this.body.br(this.blockDepth - this.breakTarget);
        break;
      case AST.SContinue:
        this.body.br(this.blockDepth - this.continueTarget);
        break;
      case AST.SSwitch: {
        const sw = stmt;
        const savedBreak = this.breakTarget;

        // Top-level SCase nodes (direct statements of sw.body) in
        // source order. Structured codegen can only dispatch to these
        // positions; any SCase buried inside a nested compound is a
        // Duff's-device pattern (SQLite VDBE) and requires the
        // loop-switch lowering fallback.
        const topLevelCases = [];
        for (let si = 0; si < sw.body.statements.length; si++) {
          const s = sw.body.statements[si];
          if (s instanceof AST.SCase) topLevelCases.push({ caseNode: s, stmtPos: si });
        }
        if (sw.body.caseBag.size > topLevelCases.length) {
          const loc = sw.loc || {};
          this.gotoErrors.push({
            message: `switch contains nested case label(s); requires loop-switch lowering ` +
                     `(in function '${this.currentFuncDef?.name || '?'}')`,
            filename: loc.filename || '?',
            line: loc.line || 0,
          });
          this.body.unreachable();
          break;
        }

        let defaultIdx = -1;
        for (let i = 0; i < topLevelCases.length; i++) {
          if (topLevelCases[i].caseNode.isDefault) { defaultIdx = i; break; }
        }

        // Collect forward labels and their statement positions in switch body
        const switchFwdLabels = [];
        for (let si = 0; si < sw.body.statements.length; si++) {
          const s = sw.body.statements[si];
          if (s instanceof AST.SLabel && s.hasGotos) {
            if (s.labelKind === Types.LabelKind.FORWARD || s.labelKind === Types.LabelKind.BOTH)
              switchFwdLabels.push({ label: s, stmtPos: si });
          }
          if (s instanceof AST.SCompound) {
            for (const cs of s.statements) {
              if (cs instanceof AST.SLabel && cs.hasGotos) {
                if (cs.labelKind === Types.LabelKind.FORWARD || cs.labelKind === Types.LabelKind.BOTH) {
                  switchFwdLabels.push({ label: cs, stmtPos: si });
                  // Mark so the inner COMPOUND emit doesn't open its own
                  // forward-label block — the switch-level block we're
                  // about to open subsumes it.
                  cs.isSwitchLevel = true;
                }
              }
            }
          }
        }
        const numCases = topLevelCases.length;
        const numFwdBlocks = switchFwdLabels.length;

        // Compute adjusted br index for each case.
        // A forward label at stmtPos P is interleaved between cases with
        // stmtPos <= P (inner) and cases with stmtPos > P (outer).
        const caseBrIdx = new Array(numCases);
        for (let i = 0; i < numCases; i++) {
          let adj = 0;
          for (const fl of switchFwdLabels) {
            if (fl.stmtPos < topLevelCases[i].stmtPos) adj++;
          }
          caseBrIdx[i] = i + adj;
        }

        // Open break block
        this.body.block(); this.blockDepth++; this.breakTarget = this.blockDepth;

        // Open case blocks and forward label blocks interleaved.
        // Sort by stmtPos descending (higher pos = outermost).
        const blockEntries = [];
        for (let i = 0; i < numCases; i++) {
          blockEntries.push({ pos: topLevelCases[i].stmtPos, isForward: false, idx: i });
        }
        for (let i = 0; i < switchFwdLabels.length; i++) {
          blockEntries.push({ pos: switchFwdLabels[i].stmtPos, isForward: true, idx: i });
        }
        blockEntries.sort((a, b) => {
          if (a.pos !== b.pos) return b.pos - a.pos;
          if (a.isForward !== b.isForward) return a.isForward ? -1 : 1;
          return b.idx - a.idx;
        });
        for (const e of blockEntries) {
          this.body.block(); this.blockDepth++;
          if (e.isForward) {
            this.gotoLabelDepths.set(switchFwdLabels[e.idx].label, this.blockDepth);
          }
        }

        // Dispatch
        {
          this.pushLocalScope();
          const switchWt = this.getBinaryWasmType(sw.expr.type);
          const switchLocal = this.allocLocal(switchWt);
          this.emitExpr(sw.expr);
          this.body.localSet(switchLocal);

          // Enumerate (value → caseIdx) pairs, expanding any GNU case
          // ranges (`case lo ... hi:`). Each value gets one entry; the
          // density check + br_table treat them as individual values.
          const valueEntries = []; // [{ value: BigInt, caseIdx: number }]
          for (let i = 0; i < numCases; i++) {
            const cn = topLevelCases[i].caseNode;
            if (cn.isDefault) continue;
            for (let v = cn.lo; v <= cn.hi; v++) {
              valueEntries.push({ value: v, caseIdx: i });
            }
          }

          let dense = false;
          let minVal = 0, maxVal = 0, range = 0;
          if (wtEquals(switchWt, WT_I32)) {
            let min = 0x7FFFFFFF, max = -0x80000000;
            for (const ve of valueEntries) {
              const v = Number(ve.value) | 0;
              if (v < min) min = v;
              if (v > max) max = v;
            }
            minVal = min; maxVal = max;
            const nonDefaultCount = valueEntries.length;
            range = nonDefaultCount > 0 ? (maxVal - minVal + 1) >>> 0 : 0;
            dense = nonDefaultCount >= 4 && range <= 512 &&
                (nonDefaultCount * 10 / range) >= 4; // density >= 40%
          }

          if (this.compilerOptions.debugSwitch && sw.loc && this.writeErr) {
            this.writeErr(`${sw.loc.filename}:${sw.loc.line}: switch: ${dense ? "br_table" : "br_if"}\n`);
          }

          if (dense) {
            // br_table path: build a jump table
            const fallbackIdx = defaultIdx >= 0 ? caseBrIdx[defaultIdx] : numCases + numFwdBlocks;
            const table = new Array(range).fill(fallbackIdx);
            for (const ve of valueEntries) {
              table[((Number(ve.value) | 0) - minVal) >>> 0] = caseBrIdx[ve.caseIdx];
            }
            this.body.localGet(switchLocal);
            this.body.i32Const(minVal);
            this.body.aop(WT_I32, ALU.OP_SUB);
            this.body.brTable(table, fallbackIdx);
          } else {
            // Linear br_if chain for sparse switches
            for (const ve of valueEntries) {
              this.body.localGet(switchLocal);
              if (wtEquals(switchWt, WT_I32)) {
                this.body.i32Const(BigInt(Number(ve.value) | 0));
                this.body.aop(WT_I32, ALU.OP_EQ);
              } else {
                this.body.i64Const(ve.value);
                this.body.aop(WT_I64, ALU.OP_EQ);
              }
              this.body.brIf(caseBrIdx[ve.caseIdx]);
            }
            if (defaultIdx >= 0) this.body.br(caseBrIdx[defaultIdx]);
            else this.body.br(numCases + numFwdBlocks);
          }
          this.popLocalScope();
        }
        // Case bodies. `openLoopLabels` is the set of BOTH/LOOP labels
        // currently bound to wasm `loop` blocks. Critically, these are
        // *per-case*: a BOTH label that lives in case N's body is in
        // scope only during case N. Before transitioning to case N+1
        // we must close the loop blocks and delete the labels from
        // `gotoLabelDepths`, otherwise the next case would inherit
        // stale depth entries (the next case's leading `end()` would
        // drop blockDepth below the registered depth, and a `goto L`
        // would either land on the wrong target or trigger the
        // depth>blockDepth defensive check).
        let openLoopLabels = [];
        for (let i = 0; i < numCases; i++) {
          // Cleanup any per-case loop labels left from the previous
          // iteration's body before closing this iteration's case
          // dispatch block.
          for (let k = openLoopLabels.length - 1; k >= 0; k--) {
            this.gotoLabelDepths.delete(openLoopLabels[k]);
            this.blockDepth--; this.body.end();
          }
          openLoopLabels.length = 0;
          this.blockDepth--; this.body.end();
          const startIdx = topLevelCases[i].stmtPos;
          const endIdx = (i + 1 < numCases) ? topLevelCases[i + 1].stmtPos : sw.body.statements.length;
          for (let j = startIdx; j < endIdx; j++) {
            const s = sw.body.statements[j];
            if (s instanceof AST.SCase) continue;  // dispatch marker, no code
            if (s instanceof AST.SLabel) {
              if (!s.hasGotos) continue;
              if (s.labelKind === Types.LabelKind.FORWARD || s.labelKind === Types.LabelKind.BOTH) {
                for (let k = openLoopLabels.length - 1; k >= 0; k--) {
                  this.gotoLabelDepths.delete(openLoopLabels[k]);
                  this.blockDepth--; this.body.end();
                }
                openLoopLabels.length = 0;
                this.gotoLabelDepths.delete(s);
                this.blockDepth--; this.body.end();
              }
              if (s.labelKind === Types.LabelKind.LOOP || s.labelKind === Types.LabelKind.BOTH) {
                this.body.loop(); this.blockDepth++;
                this.gotoLabelDepths.set(s, this.blockDepth);
                openLoopLabels.push(s);
              }
            } else {
              this.emitStmt(s);
            }
          }
        }
        for (let k = openLoopLabels.length - 1; k >= 0; k--) {
          this.gotoLabelDepths.delete(openLoopLabels[k]);
          this.blockDepth--; this.body.end();
        }
        // Any switch-level forward labels still in the map (their case
        // body fell through without crossing a forward-label statement)
        // go out of scope when we close the break block.
        for (const fl of switchFwdLabels) this.gotoLabelDepths.delete(fl.label);
        this.blockDepth--; this.body.end();
        this.breakTarget = savedBreak;
        break;
      }
      case AST.SGoto: {
        const target = stmt.target;
        const depth = target ? this.gotoLabelDepths.get(target) : undefined;
        // Treat both "label not in map" and "label registered at a
        // deeper scope than we're currently at" as out-of-scope. The
        // second case can occur when a label's block-opening was issued
        // by a parent compound but we've descended into a sibling that
        // doesn't structurally enclose it — the depth value is stale
        // relative to our current emission position.
        if (depth === undefined || depth > this.blockDepth) {
          const loc = stmt.loc || {};
          this.gotoErrors.push({
            message: `goto '${stmt.label}': target label not in scope (in function '${this.currentFuncDef?.name || '?'}') ` +
                     `(label may be in a nested block, or a loop label's scope was closed by a forward label)`,
            filename: loc.filename || '?',
            line: loc.line || 0,
          });
          this.body.unreachable();
        } else {
          this.body.br(this.blockDepth - depth);
        }
        break;
      }
      case AST.SLabel: break; // handled in COMPOUND
      case AST.SCase: break;  // dispatch marker, handled in SSwitch
      case AST.SEmpty: break;
      case AST.SThrow: {
        const tagIdx = this.exceptionToWasmTagIdx.get(stmt.tag);
        for (let i = 0; i < stmt.args.length; i++) this.emitExpr(stmt.args[i]);
        this.body.throw_(tagIdx);
        this.body.unreachable();
        break;
      }
      case AST.STryCatch: {
        const tc = stmt;
        const numCatches = tc.catches.length;
        const savedSpLocal = this.allocLocal(WT_I32);
        this.body.globalGet(this.stackPointerGlobalIdx);
        this.body.localSet(savedSpLocal);
        this.body.block(); this.blockDepth++;
        const endDepth = this.blockDepth;
        const catchBlockDepths = [];
        for (let i = numCatches - 1; i >= 0; i--) {
          const cc = tc.catches[i];
          if (!cc.tag || cc.tag.paramTypes.length === 0) this.body.block();
          else if (cc.tag.paramTypes.length === 1) this.body.block(cToWasmType(cc.tag.paramTypes[0], this.wmod));
          else {
            const results = cc.tag.paramTypes.map(pt => cToWasmType(pt, this.wmod));
            const typeIdx = this.wmod.addFunctionTypeId([], results);
            this.body.push(0x02); lebI(this.body.bytes, typeIdx);
          }
          this.blockDepth++;
          catchBlockDepths[i] = this.blockDepth;
        }
        const catches = [];
        for (let i = 0; i < numCatches; i++) {
          const cc = tc.catches[i];
          const labelIdx = this.blockDepth - catchBlockDepths[i];
          if (!cc.tag) catches.push([0x02, 0, labelIdx]);
          else catches.push([0x00, this.exceptionToWasmTagIdx.get(cc.tag), labelIdx]);
        }
        this.body.tryTable(WT_EMPTY, catches);
        this.blockDepth++;
        this.emitStmt(tc.tryBody);
        this.blockDepth--; this.body.end();
        this.body.br(this.blockDepth - endDepth);
        for (let i = 0; i < numCatches; i++) {
          this.blockDepth--; this.body.end();
          const cc = tc.catches[i];
          this.pushLocalScope();
          this.body.localGet(savedSpLocal);
          this.body.globalSet(this.stackPointerGlobalIdx);
          if (cc.tag && cc.tag.paramTypes.length > 0) {
            const bindLocals = [];
            for (let j = 0; j < cc.bindingVars.length; j++) {
              const localIdx = this.allocLocal(cToWasmType(cc.tag.paramTypes[j], this.wmod));
              this.localVarToWasmLocalIdx.set(cc.bindingVars[j], localIdx);
              this._trackLocalName(localIdx, cc.bindingVars[j].name);
              bindLocals.push(localIdx);
            }
            for (let j = bindLocals.length - 1; j >= 0; j--) this.body.localSet(bindLocals[j]);
          }
          this.emitStmt(cc.body);
          this.popLocalScope();
          if (i + 1 < numCatches) this.body.br(this.blockDepth - endDepth);
        }
        this.blockDepth--; this.body.end();
        break;
      }
      default:
        throw new Error(`emitStmt: unhandled statement ${stmt.constructor.name}`);
    }
  }

  // --- Type helpers ---
  getBinaryWasmType(type) {
    type = type.removeQualifiers();
    if (type === Types.TEXTERNREF) return WT_EXTERNREF;
    if (type === Types.TREFEXTERN) return WT_REFEXTERN;
    if (type === Types.TEQREF) return WT_EQREF;
    if (type.isWasmGCType()) {
      return WT_GCREF(getOrCreateGCWasmTypeIdx(this.wmod, type), true);
    }
    if (type === Types.TFLOAT) return WT_F32;
    if (type === Types.TDOUBLE || type === Types.TLDOUBLE) return WT_F64;
    if (type === Types.TLLONG || type === Types.TULLONG) return WT_I64;
    return WT_I32;
  }

  isUnsignedType(type) { return type.removeQualifiers().isUnsigned(); }

  // --- Pointer scaling helpers ---
  // Multiply the i32 value already on top of the stack by sizeof(elemType).
  emitScaleByElemSize(elemType) {
    const elemSize = this.sizeOf(elemType);
    if (elemSize !== 1) {
      this.body.i32Const(elemSize);
      this.body.aop(WT_I32, ALU.OP_MUL);
    }
  }
  // Divide the i32 value already on top of the stack by sizeof(elemType) (signed).
  emitDivByElemSize(elemType) {
    const elemSize = this.sizeOf(elemType);
    if (elemSize !== 1) {
      this.body.i32Const(elemSize);
      this.body.aop(WT_I32, ALU.OP_DIV, true);
    }
  }
  // Emit an integer expression as a byte offset for pointer arithmetic:
  // emit, narrow i64→i32 if needed, then scale by sizeof(elemType).
  emitPointerOffset(intExpr, elemType) {
    this.emitExpr(intExpr);
    if (wtEquals(this.getBinaryWasmType(intExpr.type), WT_I64)) {
      this.body.aop(WT_I32, ALU.OP_WRAP_I64);
    }
    this.emitScaleByElemSize(elemType);
  }

  // --- Load/Store ---
  // After an address has been pushed for an lvalue, emit a load iff
  // the value should be materialized (i.e. it's a scalar). Aggregates
  // (struct/union/array) propagate as addresses — loading them here
  // would be wrong; callers consume the address. Functions are also
  // address-only at the wasm level (the call sequence reads the table
  // index directly). Centralizes the rule that was repeated across
  // EIdent / ESubscript / EMember / EArrow / OP_DEREF emit cases.
  emitLoadIfScalar(type) {
    if (!type.isAggregate() && !type.isFunction()) this.emitLoad(type);
  }
  emitLoad(type) {
    type = type.removeQualifiers();
    if (type === Types.TCHAR || type === Types.TSCHAR) this.body.mop(MOP.I32_LOAD8_S, 0, 0);
    else if (type === Types.TUCHAR || type === Types.TBOOL) this.body.mop(MOP.I32_LOAD8_U, 0, 0);
    else if (type === Types.TSHORT) this.body.mop(MOP.I32_LOAD16_S, 0, 1);
    else if (type === Types.TUSHORT) this.body.mop(MOP.I32_LOAD16_U, 0, 1);
    else if (type === Types.TINT || type === Types.TUINT || type === Types.TLONG ||
             type === Types.TULONG || type.isPointer()) this.body.mop(MOP.I32_LOAD, 0, 2);
    else if (type === Types.TLLONG || type === Types.TULLONG) this.body.mop(MOP.I64_LOAD, 0, 3);
    else if (type === Types.TFLOAT) this.body.mop(MOP.F32_LOAD, 0, 2);
    else if (type === Types.TDOUBLE || type === Types.TLDOUBLE) this.body.mop(MOP.F64_LOAD, 0, 3);
    else throw new Error(`emitLoad: unsupported type: ${type.kind}`);
  }

  emitStore(type) {
    type = type.removeQualifiers();
    if (type === Types.TCHAR || type === Types.TSCHAR || type === Types.TUCHAR || type === Types.TBOOL)
      this.body.mop(MOP.I32_STORE8, 0, 0);
    else if (type === Types.TSHORT || type === Types.TUSHORT) this.body.mop(MOP.I32_STORE16, 0, 1);
    else if (type === Types.TINT || type === Types.TUINT || type === Types.TLONG ||
             type === Types.TULONG || type.isPointer()) this.body.mop(MOP.I32_STORE, 0, 2);
    else if (type === Types.TLLONG || type === Types.TULLONG) this.body.mop(MOP.I64_STORE, 0, 3);
    else if (type === Types.TFLOAT) this.body.mop(MOP.F32_STORE, 0, 2);
    else if (type === Types.TDOUBLE || type === Types.TLDOUBLE) this.body.mop(MOP.F64_STORE, 0, 3);
    else throw new Error(`emitStore: unsupported type: ${type.kind}`);
  }

  // --- Bitfield load/store ---
  emitBitFieldLoad(field) {
    const bw = field.bitWidth, bo = field.bitOffset;
    const isUnsigned = this.isUnsignedType(field.type);
    // i32 path covers 1/2/4-byte storage; i64 path covers 8-byte storage.
    const use64 = field.type.size === 8;
    this.emitLoad(field.type);
    if (!use64) {
      if (bo !== 0) { this.body.i32Const(bo); this.body.aop(WT_I32, ALU.OP_SHR_U); }
      if (bw < 32) { this.body.i32Const((1 << bw) - 1); this.body.aop(WT_I32, ALU.OP_AND); }
      if (!isUnsigned && bw < 32) {
        const shift = 32 - bw;
        this.body.i32Const(shift); this.body.aop(WT_I32, ALU.OP_SHL);
        this.body.i32Const(shift); this.body.aop(WT_I32, ALU.OP_SHR_S);
      }
    } else {
      // 64-bit storage unit.
      if (bo !== 0) { this.body.i64Const(BigInt(bo)); this.body.aop(WT_I64, ALU.OP_SHR_U); }
      if (bw < 64) {
        const mask = (1n << BigInt(bw)) - 1n;
        this.body.i64Const(mask); this.body.aop(WT_I64, ALU.OP_AND);
      }
      if (!isUnsigned && bw < 64) {
        const shift = BigInt(64 - bw);
        this.body.i64Const(shift); this.body.aop(WT_I64, ALU.OP_SHL);
        this.body.i64Const(shift); this.body.aop(WT_I64, ALU.OP_SHR_S);
      }
    }
  }

  emitBitFieldStore(field) {
    const bw = field.bitWidth, bo = field.bitOffset;
    const unitBits = field.type.size * 8;  // 8, 16, 32, or 64
    const use64 = field.type.size === 8;
    // Full-width store: no read-modify-write needed.
    if (bw >= unitBits) { this.emitStore(field.type); return; }

    if (!use64) {
      const mask = ((1 << bw) - 1) << bo;
      this.pushLocalScope();
      const valLocal = this.allocLocal(WT_I32);
      const addrLocal = this.allocLocal(WT_I32);
      this.body.localSet(valLocal);
      this.body.localSet(addrLocal);
      this.body.localGet(addrLocal);
      this.emitLoad(field.type);
      this.body.i32Const(~mask);
      this.body.aop(WT_I32, ALU.OP_AND);
      this.body.localGet(valLocal);
      this.body.i32Const((1 << bw) - 1);
      this.body.aop(WT_I32, ALU.OP_AND);
      if (bo !== 0) { this.body.i32Const(bo); this.body.aop(WT_I32, ALU.OP_SHL); }
      this.body.aop(WT_I32, ALU.OP_OR);
      this.body.localSet(valLocal);
      this.body.localGet(addrLocal);
      this.body.localGet(valLocal);
      this.emitStore(field.type);
      this.popLocalScope();
    } else {
      // 64-bit storage unit. Same shape as the i32 path but with i64 ops
      // and BigInt-encoded mask constants. The mask must use BigInt
      // throughout: JS bitwise ops on `Number` truncate to 32 bits.
      const widthMask = (1n << BigInt(bw)) - 1n;
      const mask = widthMask << BigInt(bo);
      const notMask = (~mask) & 0xFFFFFFFFFFFFFFFFn;  // clamp to 64 bits
      this.pushLocalScope();
      const valLocal = this.allocLocal(WT_I64);
      const addrLocal = this.allocLocal(WT_I32);
      this.body.localSet(valLocal);
      this.body.localSet(addrLocal);
      this.body.localGet(addrLocal);
      this.emitLoad(field.type);
      this.body.i64Const(notMask);
      this.body.aop(WT_I64, ALU.OP_AND);
      this.body.localGet(valLocal);
      this.body.i64Const(widthMask);
      this.body.aop(WT_I64, ALU.OP_AND);
      if (bo !== 0) { this.body.i64Const(BigInt(bo)); this.body.aop(WT_I64, ALU.OP_SHL); }
      this.body.aop(WT_I64, ALU.OP_OR);
      this.body.localSet(valLocal);
      this.body.localGet(addrLocal);
      this.body.localGet(valLocal);
      this.emitStore(field.type);
      this.popLocalScope();
    }
  }

  // --- VaArg load/store ---
  emitVaArgStore(type) {
    const wt = cToWasmType(type);
    if (wtEquals(wt, WT_I32)) this.body.mop(MOP.I32_STORE, 0, 2);
    else if (wtEquals(wt, WT_I64)) this.body.mop(MOP.I64_STORE, 0, 3);
    else if (wtEquals(wt, WT_F32)) this.body.mop(MOP.F32_STORE, 0, 2);
    else if (wtEquals(wt, WT_F64)) this.body.mop(MOP.F64_STORE, 0, 3);
  }

  emitVaArgLoad(type) {
    type = type.removeQualifiers();
    if (isStructOrUnion(type)) return; // struct: address IS the value
    if (type === Types.TCHAR || type === Types.TSCHAR) this.body.mop(MOP.I32_LOAD8_S, 0, 0);
    else if (type === Types.TUCHAR || type === Types.TBOOL) this.body.mop(MOP.I32_LOAD8_U, 0, 0);
    else if (type === Types.TSHORT) this.body.mop(MOP.I32_LOAD16_S, 0, 1);
    else if (type === Types.TUSHORT) this.body.mop(MOP.I32_LOAD16_U, 0, 1);
    else {
      const wt = cToWasmType(type);
      if (wtEquals(wt, WT_I32)) this.body.mop(MOP.I32_LOAD, 0, 2);
      else if (wtEquals(wt, WT_I64)) this.body.mop(MOP.I64_LOAD, 0, 3);
      else if (wtEquals(wt, WT_F32)) this.body.mop(MOP.F32_LOAD, 0, 2);
      else if (wtEquals(wt, WT_F64)) this.body.mop(MOP.F64_LOAD, 0, 3);
    }
  }

  // --- Condition/bool helpers ---
  emitConditionToI32(condType) {
    const wt = this.getBinaryWasmType(condType);
    // Ref → bool: not-null is true. Use ref.is_null then invert.
    if (wtIsRef(wt)) { this.body.refIsNull(); this.body.i32Const(0); this.body.aop(WT_I32, ALU.OP_EQ); }
    else if (wtEquals(wt, WT_F32)) { this.body.f32Const(0.0); this.body.aop(WT_F32, ALU.OP_NE); }
    else if (wtEquals(wt, WT_F64)) { this.body.f64Const(0.0); this.body.aop(WT_F64, ALU.OP_NE); }
    else if (wtEquals(wt, WT_I64)) { this.body.i64Const(0n); this.body.aop(WT_I64, ALU.OP_NE); }
  }

  emitBoolNormalize(type) {
    const wt = this.getBinaryWasmType(type);
    if (wtIsRef(wt)) { this.body.refIsNull(); this.body.i32Const(0); this.body.aop(WT_I32, ALU.OP_EQ); }
    else if (wtEquals(wt, WT_F32)) { this.body.f32Const(0.0); this.body.aop(WT_F32, ALU.OP_NE); }
    else if (wtEquals(wt, WT_F64)) { this.body.f64Const(0.0); this.body.aop(WT_F64, ALU.OP_NE); }
    else if (wtEquals(wt, WT_I64)) { this.body.i64Const(0n); this.body.aop(WT_I64, ALU.OP_NE); }
    else { this.body.i32Const(0); this.body.aop(WT_I32, ALU.OP_NE); }
  }

  // Emit float→int conversion. Defaults to saturating semantics
  // (WASM 2.0 trunc_sat: NaN→0, overflow→clamped INT_MIN/MAX), which
  // matches what most C runtimes do in practice and avoids surprise
  // traps from `(int)1e16` etc. With --trapping-float-conversions
  // (compilerOptions.trappingFloatConversions), revert to the WASM 1.0
  // trapping trunc that crashes on out-of-range — useful when you want
  // C99 §6.3.1.4 UB-as-crash for fuzzing/diagnostics.
  _emitFloatToInt(dstWt, srcWt, sign) {
    if (this.compilerOptions.trappingFloatConversions) {
      const aluOp = wtEquals(srcWt, WT_F32) ? ALU.OP_TRUNC_F32 : ALU.OP_TRUNC_F64;
      this.body.aop(dstWt, aluOp, sign);
    } else {
      this.body.truncSat(dstWt, srcWt, sign);
    }
  }

  // Emit narrowing for sub-i32 types (char, short).
  // WASM locals are always i32, so we must explicitly truncate after
  // any operation that may leave high bits set.
  emitSubIntNarrowing(toType) {
    toType = toType.removeQualifiers();
    if (toType === Types.TCHAR || toType === Types.TSCHAR) {
      this.body.i32Const(24); this.body.aop(WT_I32, ALU.OP_SHL);
      this.body.i32Const(24); this.body.aop(WT_I32, ALU.OP_SHR_S);
    } else if (toType === Types.TUCHAR) {
      this.body.i32Const(0xFF); this.body.aop(WT_I32, ALU.OP_AND);
    } else if (toType === Types.TSHORT) {
      this.body.i32Const(16); this.body.aop(WT_I32, ALU.OP_SHL);
      this.body.i32Const(16); this.body.aop(WT_I32, ALU.OP_SHR_S);
    } else if (toType === Types.TUSHORT) {
      this.body.i32Const(0xFFFF); this.body.aop(WT_I32, ALU.OP_AND);
    }
  }

  // --- Type conversion ---
  _isNullPointerConstantCG(expr) {
    if (!expr) return false;
    if (expr instanceof AST.EInt && expr.value === 0n) return true;
    if (expr instanceof AST.EImplicitCast || expr instanceof AST.ECast) {
      return this._isNullPointerConstantCG(expr.expr);
    }
    return false;
  }

  emitConversion(fromType, toType, fromExpr) {
    const fromWasm = this.getBinaryWasmType(fromType);
    const toWasm = this.getBinaryWasmType(toType);
    toType = toType.removeQualifiers();
    if (toType.isRef() && !wtIsRef(fromWasm)) {
      // Source is non-ref. Parse-time validation has already gated this:
      //   - Null pointer constant (literal 0 / NULL) → emit ref.null of target
      //   - Primitive into __eqref → auto-box (allocate internal box struct)
      //   - Other combinations would have errored at parse time.
      // We need the source expression to tell which branch this is.
      const fq = fromType.removeQualifiers();
      const isNullConst = fromExpr && this._isNullPointerConstantCG(fromExpr);
      if (toType === Types.TEQREF && fq.isArithmetic() && !isNullConst) {
        // Box: widen value to box storage type, then struct.new.
        const primWt = boxStorageWtFor(fq);
        const boxIdx = getOrCreateBoxStructIdx(this.wmod, primWt);
        const srcWt = this.getBinaryWasmType(fromType);
        if (!wtEquals(srcWt, primWt)) {
          if (wtEquals(primWt, WT_I64)) this.body.aop(WT_I64, ALU.OP_EXTEND_I32, !this.isUnsignedType(fromType));
          else if (wtEquals(primWt, WT_F64)) this.body.aop(WT_F64, ALU.OP_PROMOTE_F32);
        }
        this.body.structNew(boxIdx);
        return;
      }
      // Otherwise: ref.null of the target ref type.
      this.body.drop();
      if (toWasm.heapIsIdx) this.body.refNullIdx(toWasm.heap);
      else this.body.refNull(toWasm.heap);
      return;
    }
    if (toType === Types.TBOOL) {
      // Refs as bool are rejected at parse time (use __ref_is_null instead).
      if (wtEquals(fromWasm, WT_I32)) { this.body.i32Const(0); this.body.aop(WT_I32, ALU.OP_NE); }
      else if (wtEquals(fromWasm, WT_I64)) { this.body.i64Const(0n); this.body.aop(WT_I64, ALU.OP_NE); }
      else if (wtEquals(fromWasm, WT_F32)) { this.body.f32Const(0.0); this.body.aop(WT_F32, ALU.OP_NE); }
      else if (wtEquals(fromWasm, WT_F64)) { this.body.f64Const(0.0); this.body.aop(WT_F64, ALU.OP_NE); }
      return;
    }
    if (wtEquals(fromWasm, toWasm)) {
      if (wtEquals(fromWasm, WT_I32)) this.emitSubIntNarrowing(toType);
      return;
    }
    const fromSigned = !this.isUnsignedType(fromType);
    const toSigned = !this.isUnsignedType(toType);
    if (wtEquals(fromWasm, WT_I32) && wtEquals(toWasm, WT_I64)) this.body.aop(WT_I64, ALU.OP_EXTEND_I32, fromSigned);
    else if (wtEquals(fromWasm, WT_I64) && wtEquals(toWasm, WT_I32)) { this.body.aop(WT_I32, ALU.OP_WRAP_I64); this.emitSubIntNarrowing(toType); }
    else if (wtEquals(fromWasm, WT_I32) && wtEquals(toWasm, WT_F32)) this.body.aop(WT_F32, ALU.OP_CONVERT_I32, fromSigned);
    else if (wtEquals(fromWasm, WT_I32) && wtEquals(toWasm, WT_F64)) this.body.aop(WT_F64, ALU.OP_CONVERT_I32, fromSigned);
    else if (wtEquals(fromWasm, WT_I64) && wtEquals(toWasm, WT_F32)) this.body.aop(WT_F32, ALU.OP_CONVERT_I64, fromSigned);
    else if (wtEquals(fromWasm, WT_I64) && wtEquals(toWasm, WT_F64)) this.body.aop(WT_F64, ALU.OP_CONVERT_I64, fromSigned);
    else if (wtEquals(fromWasm, WT_F32) && wtEquals(toWasm, WT_I32)) { this._emitFloatToInt(WT_I32, WT_F32, toSigned); this.emitSubIntNarrowing(toType); }
    else if (wtEquals(fromWasm, WT_F32) && wtEquals(toWasm, WT_I64)) this._emitFloatToInt(WT_I64, WT_F32, toSigned);
    else if (wtEquals(fromWasm, WT_F64) && wtEquals(toWasm, WT_I32)) { this._emitFloatToInt(WT_I32, WT_F64, toSigned); this.emitSubIntNarrowing(toType); }
    else if (wtEquals(fromWasm, WT_F64) && wtEquals(toWasm, WT_I64)) this._emitFloatToInt(WT_I64, WT_F64, toSigned);
    else if (wtEquals(fromWasm, WT_F32) && wtEquals(toWasm, WT_F64)) this.body.aop(WT_F64, ALU.OP_PROMOTE_F32);
    else if (wtEquals(fromWasm, WT_F64) && wtEquals(toWasm, WT_F32)) this.body.aop(WT_F32, ALU.OP_DEMOTE_F64);
  }

  // --- LValue ---
  emitLValue(expr) {
    if (expr instanceof AST.EIdent && expr.decl && expr.decl instanceof AST.DVar) {
      const varDecl = expr.decl.definition || expr.decl;
      const lit = this.localVarToWasmLocalIdx.get(varDecl);
      const git = this.globalVarToWasmGlobalIdx.get(varDecl);
      if ((lit !== undefined || git !== undefined) && varDecl.allocClass !== Types.AllocClass.MEMORY) {
        return { kind: LV_REGISTER, type: varDecl.type, regIndex: lit !== undefined ? lit : git, regIsGlobal: git !== undefined };
      }
      const gait = this.globalArrayAddrs.get(varDecl);
      if (gait !== undefined) return { kind: LV_MEMORY, type: varDecl.type, addrSource: LV_ADDR_STATIC, addrImmediate: gait };
      const lait = this.localArrayOffsets.get(varDecl);
      if (lait !== undefined) return { kind: LV_MEMORY, type: varDecl.type, addrSource: LV_ADDR_FRAME, addrImmediate: lait };
      const pait = this.paramMemoryOffsets.get(varDecl);
      if (pait !== undefined) return { kind: LV_MEMORY, type: varDecl.type, addrSource: LV_ADDR_FRAME, addrImmediate: pait };
      throw new Error(`emitLValue: variable '${varDecl.name}' not found`);
    }
    if (expr instanceof AST.EMember) {
      const baseT = expr.base.type.removeQualifiers();
      if (baseT.isGCStruct()) {
        const refWt = this.getBinaryWasmType(baseT);
        this.emitExpr(expr.base);
        const refLocal = this.allocLocal(refWt);
        this.body.localSet(refLocal);
        return {
          kind: LV_GC_STRUCT_FIELD, type: expr.type,
          gcTypeIdx: getOrCreateGCWasmTypeIdx(this.wmod, baseT),
          gcFieldIdx: expr.memberDecl.byteOffset,
          savedRefLocal: refLocal,
        };
      }
      this.emitAddressOf(expr);
      const lv = { kind: LV_MEMORY, type: expr.type, bitField: expr.memberDecl.bitWidth >= 0 ? expr.memberDecl : null, addrSource: LV_ADDR_LOCAL };
      lv.savedLocal = this.allocLocal(WT_I32);
      this.body.localSet(lv.savedLocal);
      return lv;
    }
    if (expr instanceof AST.EArrow) {
      this.emitAddressOf(expr);
      const lv = { kind: LV_MEMORY, type: expr.type, bitField: expr.memberDecl.bitWidth >= 0 ? expr.memberDecl : null, addrSource: LV_ADDR_LOCAL };
      lv.savedLocal = this.allocLocal(WT_I32);
      this.body.localSet(lv.savedLocal);
      return lv;
    }
    if (expr instanceof AST.ESubscript) {
      const arrT = expr.array.type.removeQualifiers();
      if (arrT.isGCArray()) {
        const refWt = this.getBinaryWasmType(arrT);
        this.emitExpr(expr.array);
        const refLocal = this.allocLocal(refWt);
        this.body.localSet(refLocal);
        this.emitExpr(expr.index);
        if (wtEquals(this.getBinaryWasmType(expr.index.type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
        const idxLocal = this.allocLocal(WT_I32);
        this.body.localSet(idxLocal);
        return {
          kind: LV_GC_ARRAY_ELEM, type: expr.type,
          gcTypeIdx: getOrCreateGCWasmTypeIdx(this.wmod, arrT),
          savedRefLocal: refLocal, savedIdxLocal: idxLocal,
        };
      }
      this.emitExpr(expr.array);
      this.emitPointerOffset(expr.index, expr.type);
      this.body.aop(WT_I32, ALU.OP_ADD);
      const lv = { kind: LV_MEMORY, type: expr.type, addrSource: LV_ADDR_LOCAL };
      lv.savedLocal = this.allocLocal(WT_I32);
      this.body.localSet(lv.savedLocal);
      return lv;
    }
    if (expr instanceof AST.EUnary && expr.op === "OP_DEREF") {
      this.emitExpr(expr.operand);
      const lv = { kind: LV_MEMORY, type: expr.type, addrSource: LV_ADDR_LOCAL };
      lv.savedLocal = this.allocLocal(WT_I32);
      this.body.localSet(lv.savedLocal);
      return lv;
    }
    throw new Error(`emitLValue: unsupported expression ${expr.constructor.name}`);
  }

  lvaluePush(lv) {
    if (lv.kind === LV_REGISTER) return;
    if (lv.kind === LV_MEMORY) {
      if (lv.addrSource === LV_ADDR_LOCAL) this.body.localGet(lv.savedLocal);
      else if (lv.addrSource === LV_ADDR_STATIC) this.body.i32Const(lv.addrImmediate);
      else if (lv.addrSource === LV_ADDR_FRAME) this.emitFrameAddr(lv.addrImmediate);
    } else if (lv.kind === LV_GC_STRUCT_FIELD) {
      this.body.localGet(lv.savedRefLocal);
    } else if (lv.kind === LV_GC_ARRAY_ELEM) {
      this.body.localGet(lv.savedRefLocal);
      this.body.localGet(lv.savedIdxLocal);
    }
  }

  lvalueLoad(lv) {
    if (lv.kind === LV_REGISTER) {
      if (lv.regIsGlobal) this.body.globalGet(lv.regIndex);
      else this.body.localGet(lv.regIndex);
    } else if (lv.kind === LV_MEMORY) {
      if (lv.bitField) this.emitBitFieldLoad(lv.bitField);
      else this.emitLoad(lv.type);
    } else if (lv.kind === LV_GC_STRUCT_FIELD) {
      if (isPackedSubI32(lv.type)) {
        if (isSignedSubI32(lv.type)) this.body.structGetS(lv.gcTypeIdx, lv.gcFieldIdx);
        else this.body.structGetU(lv.gcTypeIdx, lv.gcFieldIdx);
      } else this.body.structGet(lv.gcTypeIdx, lv.gcFieldIdx);
    } else if (lv.kind === LV_GC_ARRAY_ELEM) {
      if (isPackedSubI32(lv.type)) {
        if (isSignedSubI32(lv.type)) this.body.arrayGetS(lv.gcTypeIdx);
        else this.body.arrayGetU(lv.gcTypeIdx);
      } else this.body.arrayGet(lv.gcTypeIdx);
    }
  }

  lvalueStore(lv) {
    if (lv.kind === LV_REGISTER) {
      if (lv.regIsGlobal) this.body.globalSet(lv.regIndex);
      else this.body.localSet(lv.regIndex);
    } else if (lv.kind === LV_MEMORY) {
      if (lv.bitField) this.emitBitFieldStore(lv.bitField);
      else this.emitStore(lv.type);
    } else if (lv.kind === LV_GC_STRUCT_FIELD) {
      this.body.structSet(lv.gcTypeIdx, lv.gcFieldIdx);
    } else if (lv.kind === LV_GC_ARRAY_ELEM) {
      this.body.arraySet(lv.gcTypeIdx);
    }
  }

  lvaluePushAndLoad(lv) { this.lvaluePush(lv); this.lvalueLoad(lv); }

  // --- Address-of ---
  emitAddressOf(expr) {
    if (expr instanceof AST.EIdent) {
      if (expr.decl instanceof AST.DFunc) {
        const func = expr.decl.definition || expr.decl;
        const tIdx = this.funcDefToTableIdx.get(func);
        this.body.i32Const(tIdx);
        return;
      }
      if (expr.decl instanceof AST.DVar) {
        const varDecl = expr.decl.definition || expr.decl;
        const gait = this.globalArrayAddrs.get(varDecl);
        if (gait !== undefined) { this.body.i32Const(gait); return; }
        const lait = this.localArrayOffsets.get(varDecl);
        if (lait !== undefined) { this.emitFrameAddr(lait); return; }
        const pait = this.paramMemoryOffsets.get(varDecl);
        if (pait !== undefined) { this.emitFrameAddr(pait); return; }
        throw new Error(`Cannot take address of REGISTER variable '${varDecl.name}'`);
      }
    }
    if (expr instanceof AST.EMember) {
      this.emitAddressOf(expr.base);
      const tag = expr.base.type.tagDecl;
      const offset = this.getFieldOffset(tag, expr.memberDecl);
      if (offset) { this.body.i32Const(offset); this.body.aop(WT_I32, ALU.OP_ADD); }
      return;
    }
    if (expr instanceof AST.EArrow) {
      this.emitExpr(expr.base);
      const baseType = expr.base.type.baseType;
      const tag = baseType.tagDecl;
      const offset = this.getFieldOffset(tag, expr.memberDecl);
      if (offset) { this.body.i32Const(offset); this.body.aop(WT_I32, ALU.OP_ADD); }
      return;
    }
    if (expr instanceof AST.ESubscript) {
      this.emitExpr(expr.array);
      this.emitPointerOffset(expr.index, expr.type);
      this.body.aop(WT_I32, ALU.OP_ADD);
      return;
    }
    if (expr instanceof AST.EUnary && expr.op === "OP_DEREF") {
      this.emitExpr(expr.operand);
      return;
    }
    if (expr instanceof AST.ECompoundLiteral) {
      const fsAddr = this.fileScopeCompoundLiteralAddrs.get(expr);
      if (fsAddr !== undefined) { this.body.i32Const(fsAddr); }
      else {
        this.emitCompoundLiteralInit(expr);
        this.emitFrameAddr(this.compoundLiteralOffsets.get(expr));
      }
      return;
    }
    throw new Error(`emitAddressOf: unsupported expression ${expr.constructor.name}`);
  }

  // --- Compound op ---
  emitCompoundOp(wt, op, isUnsigned) {
    switch (op) {
      case "ADD_ASSIGN": this.body.aop(wt, ALU.OP_ADD); break;
      case "SUB_ASSIGN": this.body.aop(wt, ALU.OP_SUB); break;
      case "MUL_ASSIGN": this.body.aop(wt, ALU.OP_MUL); break;
      case "DIV_ASSIGN": this.body.aop(wt, ALU.OP_DIV, !isUnsigned); break;
      case "MOD_ASSIGN": this.body.aop(wt, ALU.OP_REM, !isUnsigned); break;
      case "BAND_ASSIGN": this.body.aop(wt, ALU.OP_AND); break;
      case "BOR_ASSIGN": this.body.aop(wt, ALU.OP_OR); break;
      case "BXOR_ASSIGN": this.body.aop(wt, ALU.OP_XOR); break;
      case "SHL_ASSIGN": this.body.aop(wt, ALU.OP_SHL); break;
      case "SHR_ASSIGN": this.body.aop(wt, isUnsigned ? ALU.OP_SHR_U : ALU.OP_SHR_S); break;
    }
  }

  // --- Assignment ---
  emitAssignment(expr, ctx) {
    const lhs = expr.left, rhs = expr.right, op = expr.op;
    const lhsType = lhs.type;
    const wantValue = ctx === EXPR_VALUE;
    this.pushLocalScope();
    const lv = this.emitLValue(lhs);
    if (op === "ASSIGN") {
      if (lv.kind !== LV_REGISTER && isStructOrUnion(lhsType)) {
        this.lvaluePush(lv); this.emitExpr(rhs);
        this.body.i32Const(this.sizeOf(lhsType)); this.body.memoryCopy();
        if (wantValue) this.lvaluePush(lv);
      } else {
        this.lvaluePush(lv); this.emitExpr(rhs);
        this.emitConversion(rhs.type, lhsType, rhs);
        if (wantValue && !lv.bitField) {
          const vt = this.allocLocal(cToWasmType(lhsType, this.wmod));
          this.body.localTee(vt); this.lvalueStore(lv); this.body.localGet(vt);
        } else {
          this.lvalueStore(lv);
          if (wantValue) this.lvaluePushAndLoad(lv);
        }
      }
    } else {
      const rhsType = rhs.type;
      let opType = lhsType;
      if (!lhsType.isPointer()) {
        opType = Types.usualArithmeticConversions(lhsType, rhsType);
      }
      const opWt = this.getBinaryWasmType(opType);
      const isUnsigned = this.isUnsignedType(opType);
      this.lvaluePush(lv); this.lvaluePushAndLoad(lv);
      this.emitConversion(lhsType, opType);
      this.emitExpr(rhs);
      this.emitConversion(rhsType, opType);
      if (lhsType.isPointer() && (op === "ADD_ASSIGN" || op === "SUB_ASSIGN")) {
        this.emitScaleByElemSize(lhsType.baseType);
      }
      this.emitCompoundOp(opWt, op, isUnsigned);
      if (opType !== lhsType) this.emitConversion(opType, lhsType);
      if (lv.kind === LV_REGISTER && lhsType.isInteger() && lhsType.size < Types.TINT.size) {
        this.emitConversion(Types.TINT, lhsType);
      }
      if (wantValue && !lv.bitField) {
        const vt = this.allocLocal(this.getBinaryWasmType(lhsType));
        this.body.localTee(vt); this.lvalueStore(lv); this.body.localGet(vt);
      } else {
        this.lvalueStore(lv);
        if (wantValue) this.lvaluePushAndLoad(lv);
      }
    }
    this.popLocalScope();
  }

  // --- Inc/Dec ---
  emitIncDec(expr, ctx) {
    const operand = expr.operand;
    const isIncrement = expr.op === "OP_PRE_INC" || expr.op === "OP_POST_INC";
    const isPre = expr.op === "OP_PRE_INC" || expr.op === "OP_PRE_DEC";
    const wantValue = ctx === EXPR_VALUE;
    const type = operand.type;
    this.pushLocalScope();
    const lv = this.emitLValue(operand);
    const wt = this.getBinaryWasmType(type);
    const emitDelta = () => {
      if (type.isPointer()) {
        const d = this.sizeOf(type.baseType);
        if (wtEquals(wt, WT_I32)) this.body.i32Const(d); else this.body.i64Const(BigInt(d));
      } else if (wtEquals(wt, WT_F32)) this.body.f32Const(1.0);
      else if (wtEquals(wt, WT_F64)) this.body.f64Const(1.0);
      else if (wtEquals(wt, WT_I64)) this.body.i64Const(1n);
      else this.body.i32Const(1);
    };
    const needsNarrowing = lv.kind === LV_REGISTER && wtEquals(wt, WT_I32) &&
      type.isInteger() && type.size < Types.TINT.size && !type.isPointer();
    if (isPre) {
      this.lvaluePush(lv); this.lvaluePushAndLoad(lv);
      emitDelta();
      this.body.aop(wt, isIncrement ? ALU.OP_ADD : ALU.OP_SUB);
      if (needsNarrowing) this.emitConversion(Types.TINT, type);
      if (wantValue && !lv.bitField) {
        const vt = this.allocLocal(wt);
        this.body.localTee(vt); this.lvalueStore(lv); this.body.localGet(vt);
      } else {
        this.lvalueStore(lv);
        if (wantValue) this.lvaluePushAndLoad(lv);
      }
    } else {
      this.lvaluePush(lv); this.lvaluePushAndLoad(lv);
      let oldTemp = 0;
      if (wantValue) { oldTemp = this.allocLocal(wt); this.body.localTee(oldTemp); }
      emitDelta();
      this.body.aop(wt, isIncrement ? ALU.OP_ADD : ALU.OP_SUB);
      if (needsNarrowing) this.emitConversion(Types.TINT, type);
      this.lvalueStore(lv);
      if (wantValue) this.body.localGet(oldTemp);
    }
    this.popLocalScope();
  }

  // --- Expression emission ---
  emitExpr(expr, ctx) {
    if (!ctx) ctx = EXPR_VALUE;
    switch (expr.constructor) {
      case AST.EInt: {
        const type = expr.type;
        if (type === Types.TLLONG || type === Types.TULLONG) {
          this.body.i64Const(expr.value);
        } else {
          this.body.i32Const(Number(BigInt.asIntN(32, expr.value)));
        }
        break;
      }
      case AST.EFloat: {
        if (expr.type.removeQualifiers() === Types.TFLOAT) this.body.f32Const(expr.value);
        else this.body.f64Const(expr.value);
        break;
      }
      case AST.EString: {
        const addr = this.getStringAddress(expr.value);
        this.body.i32Const(addr);
        break;
      }
      case AST.EIdent: {
        if (expr.decl instanceof AST.DVar) {
          const varDecl = expr.decl.definition || expr.decl;
          const gait = this.globalArrayAddrs.get(varDecl);
          if (gait !== undefined) {
            this.body.i32Const(gait);
            this.emitLoadIfScalar(varDecl.type);
            break;
          }
          const lait = this.localArrayOffsets.get(varDecl);
          if (lait !== undefined) {
            this.emitFrameAddr(lait);
            this.emitLoadIfScalar(varDecl.type);
            break;
          }
          const pait = this.paramMemoryOffsets.get(varDecl);
          if (pait !== undefined) {
            this.emitFrameAddr(pait);
            this.emitLoadIfScalar(varDecl.type);
            break;
          }
          const lit = this.localVarToWasmLocalIdx.get(varDecl);
          if (lit !== undefined) { this.body.localGet(lit); }
          else {
            const git = this.globalVarToWasmGlobalIdx.get(varDecl);
            if (git !== undefined) this.body.globalGet(git);
            else throw new Error(`emitExpr: variable '${varDecl.name}' not found`);
          }
        } else if (expr.decl instanceof AST.DEnumConst) {
          this.body.i32Const(expr.decl.value);
        } else if (expr.decl instanceof AST.DFunc) {
          const func = expr.decl.definition || expr.decl;
          const tIdx = this.funcDefToTableIdx.get(func);
          this.body.i32Const(tIdx);
        }
        break;
      }
      case AST.EBinary: {
        const meta = AST.BinOp[expr.op];
        if (meta.isAssign) {
          this.emitAssignment(expr, ctx);
          return;
        }
        const leftType = expr.left.type, rightType = expr.right.type;
        const isComparison = meta.isCompare;
        const wt = this.getBinaryWasmType(isComparison ? leftType : expr.type);
        const isUnsigned = this.isUnsignedType(leftType);
        // Pointer arithmetic — element type is whichever side is a
        // pointer/array (only one side for ADD; left side for SUB).
        const elemType = AST.pointerArithElemType(leftType, rightType);
        if (expr.op === "ADD" && elemType) {
          const leftIsPtr = leftType.isPointer() || leftType.isArray();
          const ptrExpr = leftIsPtr ? expr.left : expr.right;
          const intExpr = leftIsPtr ? expr.right : expr.left;
          this.emitExpr(ptrExpr);
          this.emitPointerOffset(intExpr, elemType);
          this.body.aop(WT_I32, ALU.OP_ADD);
          break;
        }
        if (expr.op === "SUB" && elemType) {
          if (rightType.isPointer() || rightType.isArray()) {
            this.emitExpr(expr.left); this.emitExpr(expr.right);
            this.body.aop(WT_I32, ALU.OP_SUB);
            this.emitDivByElemSize(elemType);
          } else {
            this.emitExpr(expr.left);
            this.emitPointerOffset(expr.right, elemType);
            this.body.aop(WT_I32, ALU.OP_SUB);
          }
          break;
        }
        // Short-circuit
        if (expr.op === "LAND") {
          this.emitExpr(expr.left); this.emitBoolNormalize(leftType);
          this.body.if_(WT_I32);
          this.emitExpr(expr.right); this.emitBoolNormalize(rightType);
          this.body.else_(); this.body.i32Const(0); this.body.end();
          break;
        }
        if (expr.op === "LOR") {
          this.emitExpr(expr.left); this.emitBoolNormalize(leftType);
          this.body.if_(WT_I32); this.body.i32Const(1);
          this.body.else_(); this.emitExpr(expr.right); this.emitBoolNormalize(rightType); this.body.end();
          break;
        }
        // Refs in == / != : null compare against literal 0, or identity
        // between two refs (= ref.eq).
        const lRef = leftType.removeQualifiers().isRef();
        const rRef = rightType.removeQualifiers().isRef();
        if (isComparison && (lRef || rRef)) {
          if (lRef && rRef) {
            // Identity compare via ref.eq
            this.emitExpr(expr.left); this.emitExpr(expr.right);
            this.body.refEq();
            if (expr.op === "NE") { this.body.i32Const(0); this.body.aop(WT_I32, ALU.OP_EQ); }
          } else {
            // Null compare: emit ref.is_null on the ref operand.
            const refExpr = lRef ? expr.left : expr.right;
            this.emitExpr(refExpr);
            this.body.refIsNull();
            if (expr.op === "NE") { this.body.i32Const(0); this.body.aop(WT_I32, ALU.OP_EQ); }
          }
          break;
        }
        this.emitExpr(expr.left); this.emitExpr(expr.right);
        switch (expr.op) {
          case "ADD": this.body.aop(wt, ALU.OP_ADD); break;
          case "SUB": this.body.aop(wt, ALU.OP_SUB); break;
          case "MUL": this.body.aop(wt, ALU.OP_MUL); break;
          case "DIV": this.body.aop(wt, ALU.OP_DIV, !isUnsigned); break;
          case "MOD": this.body.aop(wt, ALU.OP_REM, !isUnsigned); break;
          case "EQ": this.body.aop(wt, ALU.OP_EQ); break;
          case "NE": this.body.aop(wt, ALU.OP_NE); break;
          case "LT": this.body.aop(wt, ALU.OP_LT, !isUnsigned); break;
          case "GT": this.body.aop(wt, ALU.OP_GT, !isUnsigned); break;
          case "LE": this.body.aop(wt, ALU.OP_LE, !isUnsigned); break;
          case "GE": this.body.aop(wt, ALU.OP_GE, !isUnsigned); break;
          case "BAND": this.body.aop(wt, ALU.OP_AND); break;
          case "BOR": this.body.aop(wt, ALU.OP_OR); break;
          case "BXOR": this.body.aop(wt, ALU.OP_XOR); break;
          case "SHL": this.body.aop(wt, ALU.OP_SHL); break;
          case "SHR": this.body.aop(wt, isUnsigned ? ALU.OP_SHR_U : ALU.OP_SHR_S); break;
        }
        break;
      }
      case AST.EUnary: {
        const operandType = expr.operand.type;
        switch (expr.op) {
          case "OP_NEG": {
            const wt = this.getBinaryWasmType(operandType);
            if (wtEquals(wt, WT_F32) || wtEquals(wt, WT_F64)) {
              this.emitExpr(expr.operand); this.body.aop(wt, ALU.OP_NEG);
            } else {
              if (wtEquals(wt, WT_I32)) this.body.i32Const(0); else this.body.i64Const(0n);
              this.emitExpr(expr.operand); this.body.aop(wt, ALU.OP_SUB);
            }
            break;
          }
          case "OP_POS": this.emitExpr(expr.operand); break;
          case "OP_LNOT": {
            this.emitExpr(expr.operand);
            const wt = this.getBinaryWasmType(operandType);
            if (wtIsRef(wt)) { this.body.refIsNull(); }
            else if (wtEquals(wt, WT_F32)) { this.body.f32Const(0.0); this.body.aop(WT_F32, ALU.OP_EQ); }
            else if (wtEquals(wt, WT_F64)) { this.body.f64Const(0.0); this.body.aop(WT_F64, ALU.OP_EQ); }
            else this.body.aop(wt, ALU.OP_EQZ);
            break;
          }
          case "OP_BNOT": {
            const wt = this.getBinaryWasmType(operandType);
            this.emitExpr(expr.operand);
            if (wtEquals(wt, WT_I32)) this.body.i32Const(-1); else this.body.i64Const(-1n);
            this.body.aop(wt, ALU.OP_XOR);
            break;
          }
          case "OP_PRE_INC": case "OP_PRE_DEC": case "OP_POST_INC": case "OP_POST_DEC":
            this.emitIncDec(expr, ctx); return;
          case "OP_DEREF":
            this.emitExpr(expr.operand);
            this.emitLoadIfScalar(expr.type);
            break;
          case "OP_ADDR":
            this.emitAddressOf(expr.operand);
            break;
        }
        break;
      }
      case AST.ECall: {
        const funcDecl = expr.funcDecl;
        if (funcDecl) {
          const funcDef = funcDecl.definition || funcDecl;
          const funcType = funcDef.type;
          const funcIdx = this.funcDefToWasmFuncIdx.get(funcDef);
          if (funcIdx === undefined) throw new Error(`emitExpr: function '${funcDef.name}' not found`);
          if (funcType.isVarArg) {
            // Variadic call — new convention: all args + return in arg block
            const varRetType = funcType.getReturnType();
            const paramTypes = funcType.getParamTypes();
            const numFixed = paramTypes.length;

            const varStructRet = isStructOrUnion(varRetType);
            const retSlotSize = (varRetType === Types.TVOID) ? 0 : vaSlotSize(varRetType);

            // Compute arg block layout
            let blockSize = retSlotSize;
            const argOffsets = [];
            for (let i = 0; i < expr.arguments.length; i++) {
              argOffsets.push(blockSize);
              let argType;
              if (i < numFixed) {
                argType = paramTypes[i];
              } else {
                argType = expr.arguments[i].type;
                if (argType.removeQualifiers() === Types.TFLOAT) argType = Types.TDOUBLE;
              }
              blockSize += vaSlotSize(argType);
            }
            blockSize = (blockSize + 7) & ~7;

            this.callNesting++;

            // Allocate arg block
            this.body.globalGet(this.stackPointerGlobalIdx);
            this.body.i32Const(blockSize);
            this.body.aop(WT_I32, ALU.OP_SUB);
            this.body.globalSet(this.stackPointerGlobalIdx);

            this.pushLocalScope();
            const argBlockBase = this.allocLocal(WT_I32);
            this.body.globalGet(this.stackPointerGlobalIdx);
            this.body.localSet(argBlockBase);

            const deferredAtVaAlloc = this.structRetDeferred;

            // Store each argument
            for (let i = 0; i < expr.arguments.length; i++) {
              const arg = expr.arguments[i];
              const isFixed = i < numFixed;
              let storeType;
              if (isFixed) {
                storeType = paramTypes[i];
              } else {
                storeType = arg.type;
                if (storeType.removeQualifiers() === Types.TFLOAT) storeType = Types.TDOUBLE;
              }

              this.body.localGet(argBlockBase);
              if (argOffsets[i] > 0) { this.body.i32Const(argOffsets[i]); this.body.aop(WT_I32, ALU.OP_ADD); }

              if (isStructOrUnion(storeType)) {
                this.emitExpr(arg);
                this.body.i32Const(this.sizeOf(storeType));
                this.body.memoryCopy();
              } else {
                this.emitExpr(arg);
                this.emitVaArgStore(storeType);
              }

              this.body.globalGet(this.stackPointerGlobalIdx);
              const deferredDelta = this.structRetDeferred - deferredAtVaAlloc;
              if (deferredDelta > 0) { this.body.i32Const(deferredDelta); this.body.aop(WT_I32, ALU.OP_ADD); }
              this.body.localSet(argBlockBase);
            }

            // Push arg block pointer and call
            this.body.localGet(argBlockBase);
            this.body.call(funcIdx);

            // Load return value from arg block
            if (varStructRet) {
              this.body.localGet(argBlockBase);
              this.structRetDeferred += blockSize;
            } else if (varRetType !== Types.TVOID) {
              this.body.localGet(argBlockBase);
              this.emitVaArgLoad(varRetType);
              this.body.localGet(argBlockBase);
              this.body.i32Const(blockSize);
              this.body.aop(WT_I32, ALU.OP_ADD);
              this.body.globalSet(this.stackPointerGlobalIdx);
            } else {
              this.body.localGet(argBlockBase);
              this.body.i32Const(blockSize);
              this.body.aop(WT_I32, ALU.OP_ADD);
              this.body.globalSet(this.stackPointerGlobalIdx);
              this.body.i32Const(0);
            }

            this.popLocalScope();

            this.callNesting--;
            if (this.callNesting === 0 && this.structRetDeferred > 0) {
              this.body.globalGet(this.stackPointerGlobalIdx);
              this.body.i32Const(this.structRetDeferred);
              this.body.aop(WT_I32, ALU.OP_ADD);
              this.body.globalSet(this.stackPointerGlobalIdx);
              this.structRetDeferred = 0;
            }
          } else {
            // Non-variadic direct call
            const callRetType = funcType.getReturnType();
            const structRet = isStructOrUnion(callRetType);
            let structRetAllocSize = 0;
            this.callNesting++;
            if (structRet) {
              const retSize = this.sizeOf(callRetType);
              structRetAllocSize = (retSize + 15) & ~15;
              this.body.globalGet(this.stackPointerGlobalIdx);
              this.body.i32Const(structRetAllocSize);
              this.body.aop(WT_I32, ALU.OP_SUB);
              this.body.globalSet(this.stackPointerGlobalIdx);
              this.body.globalGet(this.stackPointerGlobalIdx);
            }
            const callParamTypes = funcType.getParamTypes();
            for (let i = 0; i < expr.arguments.length; i++) {
              this.emitExpr(expr.arguments[i]);
            }
            this.body.call(funcIdx);
            if (structRet) this.structRetDeferred += structRetAllocSize;
            this.callNesting--;
            if (this.callNesting === 0 && this.structRetDeferred > 0) {
              this.body.globalGet(this.stackPointerGlobalIdx);
              this.body.i32Const(this.structRetDeferred);
              this.body.aop(WT_I32, ALU.OP_ADD);
              this.body.globalSet(this.stackPointerGlobalIdx);
              this.structRetDeferred = 0;
            }
          }
        } else {
          // Indirect call. expr.callee is already decayed by the parser
          // (see parsePostfixTail: ECall callee path), so callee.type is
          // a plain pointer-to-function (or function type itself).
          const calleeType = expr.callee.type;
          const funcType = calleeType.isPointer() ? calleeType.baseType : calleeType;
          const callRetType = funcType.getReturnType();
          const typeId = getWasmFunctionTypeIdForCFunctionType(this.wmod, funcType);
          if (funcType.isVarArg) {
            // Variadic indirect call: same frame-based ABI as direct vararg calls,
            // but ending with call_indirect instead of call.
            const paramTypes = funcType.getParamTypes();
            const numFixed = paramTypes.length;
            const varRetType = callRetType;
            const varStructRet = isStructOrUnion(varRetType);
            const retSlotSize = (varRetType === Types.TVOID) ? 0 : vaSlotSize(varRetType);
            let blockSize = retSlotSize;
            const argOffsets = [];
            for (let i = 0; i < expr.arguments.length; i++) {
              argOffsets.push(blockSize);
              let argType = i < numFixed ? paramTypes[i] : expr.arguments[i].type;
              if (argType.removeQualifiers() === Types.TFLOAT) argType = Types.TDOUBLE;
              blockSize += vaSlotSize(argType);
            }
            blockSize = (blockSize + 7) & ~7;
            this.callNesting++;
            this.body.globalGet(this.stackPointerGlobalIdx);
            this.body.i32Const(blockSize);
            this.body.aop(WT_I32, ALU.OP_SUB);
            this.body.globalSet(this.stackPointerGlobalIdx);
            this.pushLocalScope();
            const argBlockBase = this.allocLocal(WT_I32);
            this.body.globalGet(this.stackPointerGlobalIdx);
            this.body.localSet(argBlockBase);
            const deferredAtVaAlloc = this.structRetDeferred;
            for (let i = 0; i < expr.arguments.length; i++) {
              let storeType = i < numFixed ? paramTypes[i] : expr.arguments[i].type;
              if (storeType.removeQualifiers() === Types.TFLOAT) storeType = Types.TDOUBLE;
              this.body.localGet(argBlockBase);
              if (argOffsets[i] > 0) { this.body.i32Const(argOffsets[i]); this.body.aop(WT_I32, ALU.OP_ADD); }
              if (isStructOrUnion(storeType)) {
                this.emitExpr(expr.arguments[i]);
                this.body.i32Const(this.sizeOf(storeType));
                this.body.memoryCopy();
              } else {
                this.emitExpr(expr.arguments[i]);
                this.emitVaArgStore(storeType);
              }
              this.body.globalGet(this.stackPointerGlobalIdx);
              const deferredDelta = this.structRetDeferred - deferredAtVaAlloc;
              if (deferredDelta > 0) { this.body.i32Const(deferredDelta); this.body.aop(WT_I32, ALU.OP_ADD); }
              this.body.localSet(argBlockBase);
            }
            this.body.localGet(argBlockBase);
            this.emitExpr(expr.callee);
            this.body.callIndirect(typeId);
            if (varStructRet) {
              this.body.localGet(argBlockBase);
              this.structRetDeferred += blockSize;
            } else if (varRetType !== Types.TVOID) {
              this.body.localGet(argBlockBase);
              this.emitVaArgLoad(varRetType);
              this.body.localGet(argBlockBase);
              this.body.i32Const(blockSize);
              this.body.aop(WT_I32, ALU.OP_ADD);
              this.body.globalSet(this.stackPointerGlobalIdx);
            } else {
              this.body.localGet(argBlockBase);
              this.body.i32Const(blockSize);
              this.body.aop(WT_I32, ALU.OP_ADD);
              this.body.globalSet(this.stackPointerGlobalIdx);
              this.body.i32Const(0);
            }
            this.popLocalScope();
            this.callNesting--;
            if (this.callNesting === 0 && this.structRetDeferred > 0) {
              this.body.globalGet(this.stackPointerGlobalIdx);
              this.body.i32Const(this.structRetDeferred);
              this.body.aop(WT_I32, ALU.OP_ADD);
              this.body.globalSet(this.stackPointerGlobalIdx);
              this.structRetDeferred = 0;
            }
          } else {
            // Non-vararg indirect call
            const structRet = isStructOrUnion(callRetType);
            let structRetAllocSize = 0;
            this.callNesting++;
            if (structRet) {
              const retSize = this.sizeOf(callRetType);
              structRetAllocSize = (retSize + 15) & ~15;
              this.body.globalGet(this.stackPointerGlobalIdx);
              this.body.i32Const(structRetAllocSize);
              this.body.aop(WT_I32, ALU.OP_SUB);
              this.body.globalSet(this.stackPointerGlobalIdx);
              this.body.globalGet(this.stackPointerGlobalIdx);
            }
            for (let i = 0; i < expr.arguments.length; i++) this.emitExpr(expr.arguments[i]);
            this.emitExpr(expr.callee);
            this.body.callIndirect(typeId);
            if (structRet) this.structRetDeferred += structRetAllocSize;
            this.callNesting--;
            if (this.callNesting === 0 && this.structRetDeferred > 0) {
              this.body.globalGet(this.stackPointerGlobalIdx);
              this.body.i32Const(this.structRetDeferred);
              this.body.aop(WT_I32, ALU.OP_ADD);
              this.body.globalSet(this.stackPointerGlobalIdx);
              this.structRetDeferred = 0;
            }
          }
        }
        break;
      }
      case AST.ESubscript: {
        const arrType = expr.array.type.removeQualifiers();
        if (arrType.isGCArray()) {
          const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, arrType);
          this.emitExpr(expr.array);
          this.emitExpr(expr.index);
          if (wtEquals(this.getBinaryWasmType(expr.index.type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
          if (isPackedSubI32(arrType.baseType)) {
            if (isSignedSubI32(arrType.baseType)) this.body.arrayGetS(typeIdx);
            else this.body.arrayGetU(typeIdx);
          } else this.body.arrayGet(typeIdx);
          break;
        }
        const elemType = expr.type;
        this.emitExpr(expr.array);
        this.emitPointerOffset(expr.index, elemType);
        this.body.aop(WT_I32, ALU.OP_ADD);
        this.emitLoadIfScalar(elemType);
        break;
      }
      case AST.EMember: {
        const baseType = expr.base.type.removeQualifiers();
        if (baseType.isGCStruct()) {
          const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, baseType);
          this.emitExpr(expr.base);
          if (isPackedSubI32(expr.memberDecl.type)) {
            if (isSignedSubI32(expr.memberDecl.type)) this.body.structGetS(typeIdx, expr.memberDecl.byteOffset);
            else this.body.structGetU(typeIdx, expr.memberDecl.byteOffset);
          } else this.body.structGet(typeIdx, expr.memberDecl.byteOffset);
          break;
        }
        this.emitExpr(expr.base);
        const field = expr.memberDecl;
        const tag = baseType.tagDecl;
        const offset = this.getFieldOffset(tag, field);
        if (offset) { this.body.i32Const(offset); this.body.aop(WT_I32, ALU.OP_ADD); }
        if (field.bitWidth >= 0) this.emitBitFieldLoad(field);
        else this.emitLoadIfScalar(expr.type);
        break;
      }
      case AST.EArrow: {
        this.emitExpr(expr.base);
        const field = expr.memberDecl;
        const baseType = expr.base.type.baseType;
        const tag = baseType.tagDecl;
        const offset = this.getFieldOffset(tag, field);
        if (offset) { this.body.i32Const(offset); this.body.aop(WT_I32, ALU.OP_ADD); }
        if (field.bitWidth >= 0) this.emitBitFieldLoad(field);
        else this.emitLoadIfScalar(expr.type);
        break;
      }
      case AST.ESizeofExpr:
        this.body.i32Const(this.sizeOf(expr.expr.type)); break;
      case AST.ESizeofType:
        this.body.i32Const(this.sizeOf(expr.operandType)); break;
      case AST.EAlignofExpr:
        this.body.i32Const(this.alignOf(expr.expr.type)); break;
      case AST.EAlignofType:
        this.body.i32Const(this.alignOf(expr.operandType)); break;
      case AST.EImplicitCast: {
        if (ctx === EXPR_DROP) { this.emitExpr(expr.expr, EXPR_DROP); return; }
        this.emitExpr(expr.expr);
        this.emitConversion(expr.expr.type, expr.type, expr.expr);
        break;
      }
      case AST.EDecay: {
        // Operand has array or function type; emitting it produces the
        // base address (for arrays) or table index (for functions), which
        // is exactly the decayed pointer value.
        this.emitExpr(expr.operand, ctx);
        break;
      }
      case AST.ECast: {
        this.emitExpr(expr.expr);
        this.emitConversion(expr.expr.type, expr.targetType);
        break;
      }
      case AST.ETernary: {
        const resultType = cToWasmType(expr.type, this.wmod);
        this.emitExpr(expr.condition);
        this.emitConditionToI32(expr.condition.type);
        this.body.if_(resultType);
        this.emitExpr(expr.thenExpr);
        if (expr.thenExpr.type !== expr.type) this.emitConversion(expr.thenExpr.type, expr.type);
        this.body.else_();
        this.emitExpr(expr.elseExpr);
        if (expr.elseExpr.type !== expr.type) this.emitConversion(expr.elseExpr.type, expr.type);
        this.body.end();
        break;
      }
      case AST.EIntrinsic: {
        switch (expr.intrinsicKind) {
          case Types.IntrinsicKind.VA_START:
            this.emitAddressOf(expr.args[0]);
            this.body.localGet(this.vaArgsLocalIdx);
            this.body.mop(MOP.I32_STORE, 0, 2);
            this.body.i32Const(0);
            break;
          case Types.IntrinsicKind.VA_ARG: {
            const slotSize = vaSlotSize(expr.argType);
            this.emitAddressOf(expr.args[0]);
            this.body.mop(MOP.I32_LOAD, 0, 2);
            this.pushLocalScope();
            const vaArgTemp = this.allocLocal(WT_I32);
            this.body.localTee(vaArgTemp);
            this.emitAddressOf(expr.args[0]);
            this.body.localGet(vaArgTemp);
            this.body.i32Const(slotSize);
            this.body.aop(WT_I32, ALU.OP_ADD);
            this.body.mop(MOP.I32_STORE, 0, 2);
            this.emitVaArgLoad(expr.argType);
            this.popLocalScope();
            break;
          }
          case Types.IntrinsicKind.VA_END:
            this.emitExpr(expr.args[0]); this.body.drop();
            this.body.i32Const(0); break;
          case Types.IntrinsicKind.VA_COPY:
            this.emitAddressOf(expr.args[0]);
            this.emitExpr(expr.args[1]);
            this.body.mop(MOP.I32_STORE, 0, 2);
            this.body.i32Const(0);
            break;
          case Types.IntrinsicKind.MEMORY_SIZE:
            this.body.memorySize(); break;
          case Types.IntrinsicKind.MEMORY_GROW:
            this.emitExpr(expr.args[0]); this.body.memoryGrow(); break;
          case Types.IntrinsicKind.MEMORY_COPY:
            this.emitExpr(expr.args[0]); this.emitExpr(expr.args[1]); this.emitExpr(expr.args[2]);
            this.body.memoryCopy(); this.body.i32Const(0); break;
          case Types.IntrinsicKind.MEMORY_FILL:
            this.emitExpr(expr.args[0]); this.emitExpr(expr.args[1]); this.emitExpr(expr.args[2]);
            this.body.memoryFill(); this.body.i32Const(0); break;
          case Types.IntrinsicKind.HEAP_BASE:
            this.body.globalGet(this.heapBaseGlobalIdx); break;
          case Types.IntrinsicKind.ALLOCA:
            this.body.globalGet(this.stackPointerGlobalIdx);
            this.emitExpr(expr.args[0]);
            this.body.i32Const(15); this.body.aop(WT_I32, ALU.OP_ADD);
            this.body.i32Const(-16); this.body.aop(WT_I32, ALU.OP_AND);
            this.body.aop(WT_I32, ALU.OP_SUB);
            this.body.globalSet(this.stackPointerGlobalIdx);
            this.body.globalGet(this.stackPointerGlobalIdx);
            break;
          case Types.IntrinsicKind.UNREACHABLE:
            this.body.unreachable(); break;
          case Types.IntrinsicKind.REF_IS_NULL:
            this.emitExpr(expr.args[0]); this.body.refIsNull(); break;
          case Types.IntrinsicKind.REF_EQ:
            this.emitExpr(expr.args[0]); this.emitExpr(expr.args[1]); this.body.refEq(); break;
          case Types.IntrinsicKind.REF_NULL: {
            const wt = this.getBinaryWasmType(expr.argType);
            if (wt.heapIsIdx) this.body.refNullIdx(wt.heap);
            else this.body.refNull(wt.heap);
            break;
          }
          case Types.IntrinsicKind.REF_TEST: {
            this.emitExpr(expr.args[0]);
            const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, expr.argType);
            this.body.refTest(typeIdx);
            break;
          }
          case Types.IntrinsicKind.REF_TEST_NULL: {
            this.emitExpr(expr.args[0]);
            const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, expr.argType);
            this.body.refTestNull(typeIdx);
            break;
          }
          case Types.IntrinsicKind.REF_CAST: {
            this.emitExpr(expr.args[0]);
            const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, expr.argType);
            this.body.refCast(typeIdx);
            break;
          }
          case Types.IntrinsicKind.REF_CAST_NULL: {
            this.emitExpr(expr.args[0]);
            const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, expr.argType);
            this.body.refCastNull(typeIdx);
            break;
          }
          case Types.IntrinsicKind.ARRAY_LEN: {
            this.emitExpr(expr.args[0]);
            this.body.arrayLen();
            break;
          }
          case Types.IntrinsicKind.GC_NEW_ARRAY: {
            const arrType = expr.type;
            const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, arrType);
            for (let i = 0; i < expr.args.length; i++) {
              this.emitExpr(expr.args[i]);
              this.emitConversion(expr.args[i].type, expr.argType, expr.args[i]);
            }
            this.body.arrayNewFixed(typeIdx, expr.args.length);
            break;
          }
          case Types.IntrinsicKind.ARRAY_FILL: {
            // [arr, off, val, n] → array.fill typeIdx
            const arrType = expr.args[0].type.removeQualifiers();
            const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, arrType);
            this.emitExpr(expr.args[0]);
            this.emitExpr(expr.args[1]);
            if (wtEquals(this.getBinaryWasmType(expr.args[1].type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
            this.emitExpr(expr.args[2]);
            this.emitConversion(expr.args[2].type, arrType.baseType, expr.args[2]);
            this.emitExpr(expr.args[3]);
            if (wtEquals(this.getBinaryWasmType(expr.args[3].type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
            this.body.arrayFill(typeIdx);
            this.body.i32Const(0); // expression result (void → i32 0 by convention)
            break;
          }
          case Types.IntrinsicKind.REF_AS_EXTERN: {
            this.emitExpr(expr.args[0]);
            this.body.externConvertAny();
            break;
          }
          case Types.IntrinsicKind.REF_AS_EQ: {
            // extern → any (cheap) then ref.cast to eq (traps if value isn't
            // eq-compatible — which it should be for anything that originated
            // inside this WASM module via __ref_as_extern).
            this.emitExpr(expr.args[0]);
            this.body.anyConvertExtern();
            this.body.refCastNullEq();
            break;
          }
          case Types.IntrinsicKind.CAST: {
            const target = expr.argType;
            const srcType = expr.args[0].type;
            const sq = srcType.removeQualifiers();
            const tq = target.removeQualifiers();
            // Identity
            if (sq === tq) { this.emitExpr(expr.args[0]); break; }
            const isPrim = (t) => t.isArithmetic();
            const isEqref = (t) => t === Types.TEQREF;
            const isExternref = (t) => t === Types.TEXTERNREF || t === Types.TREFEXTERN;
            // prim → prim: numeric conversion
            if (isPrim(sq) && isPrim(tq)) {
              this.emitExpr(expr.args[0]);
              this.emitConversion(srcType, target);
              break;
            }
            // prim → __eqref: box. Widen to box storage type, struct.new.
            if (isPrim(sq) && isEqref(tq)) {
              const primWt = boxStorageWtFor(sq);
              if (!primWt) throw new Error(`__cast: unsupported primitive '${sq.toString()}' for eqref boxing`);
              const boxIdx = getOrCreateBoxStructIdx(this.wmod, primWt);
              this.emitExpr(expr.args[0]);
              const srcWt = this.getBinaryWasmType(srcType);
              if (!wtEquals(srcWt, primWt)) {
                if (wtEquals(primWt, WT_I64)) this.body.aop(WT_I64, ALU.OP_EXTEND_I32, !this.isUnsignedType(srcType));
                else if (wtEquals(primWt, WT_F64)) this.body.aop(WT_F64, ALU.OP_PROMOTE_F32);
              }
              this.body.structNew(boxIdx);
              break;
            }
            // __eqref → prim: unbox. ref.cast to box, struct.get, narrow.
            if (isEqref(sq) && isPrim(tq)) {
              const primWt = boxStorageWtFor(tq);
              if (!primWt) throw new Error(`__cast: unsupported primitive '${tq.toString()}' for eqref unboxing`);
              const boxIdx = getOrCreateBoxStructIdx(this.wmod, primWt);
              this.emitExpr(expr.args[0]);
              this.body.refCastNull(boxIdx);
              this.body.structGet(boxIdx, 0);
              // Narrow from box storage type to the precise C target type.
              if (tq === Types.TDOUBLE || tq === Types.TLDOUBLE) { /* f64 → f64: OK */ }
              else if (tq === Types.TFLOAT) { this.body.aop(WT_F32, ALU.OP_DEMOTE_F64); }
              else if (tq === Types.TLLONG || tq === Types.TULLONG) { /* i64 → i64: OK */ }
              else if (tq.isInteger()) {
                this.body.aop(WT_I32, ALU.OP_WRAP_I64);
                this.emitSubIntNarrowing(tq);
              }
              break;
            }
            // GC ref → __eqref: implicit subtype upcast (no opcode needed).
            if (sq.isGCRef() && isEqref(tq)) { this.emitExpr(expr.args[0]); break; }
            // __eqref → GC ref: ref.cast.
            if (isEqref(sq) && tq.isGCRef()) {
              const idx = getOrCreateGCWasmTypeIdx(this.wmod, tq);
              this.emitExpr(expr.args[0]);
              this.body.refCastNull(idx);
              break;
            }
            // GC ref → GC ref: ref.cast (same as __ref_cast).
            if (sq.isGCRef() && tq.isGCRef()) {
              const idx = getOrCreateGCWasmTypeIdx(this.wmod, tq);
              this.emitExpr(expr.args[0]);
              this.body.refCastNull(idx);
              break;
            }
            // GC ref → externref: extern.convert_any.
            if (sq.isGCRef() && isExternref(tq)) {
              this.emitExpr(expr.args[0]);
              this.body.externConvertAny();
              break;
            }
            // externref → __eqref: any.convert_extern then ref.cast (ref null eq).
            // The cast traps if the externref value isn't eq-compatible.
            if (isExternref(sq) && tq === Types.TEQREF) {
              this.emitExpr(expr.args[0]);
              this.body.anyConvertExtern();
              this.body.refCastNullEq();
              break;
            }
            throw new Error(`__cast codegen: unhandled combo '${srcType.toString()}' → '${target.toString()}'`);
          }
          case Types.IntrinsicKind.ARRAY_COPY: {
            // [dst, dstOff, src, srcOff, n] → array.copy dstTypeIdx srcTypeIdx
            const dstType = expr.args[0].type.removeQualifiers();
            const srcType = expr.args[2].type.removeQualifiers();
            const dstIdx = getOrCreateGCWasmTypeIdx(this.wmod, dstType);
            const srcIdx = getOrCreateGCWasmTypeIdx(this.wmod, srcType);
            this.emitExpr(expr.args[0]);
            this.emitExpr(expr.args[1]);
            if (wtEquals(this.getBinaryWasmType(expr.args[1].type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
            this.emitExpr(expr.args[2]);
            this.emitExpr(expr.args[3]);
            if (wtEquals(this.getBinaryWasmType(expr.args[3].type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
            this.emitExpr(expr.args[4]);
            if (wtEquals(this.getBinaryWasmType(expr.args[4].type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
            this.body.arrayCopy(dstIdx, srcIdx);
            this.body.i32Const(0);
            break;
          }
        }
        break;
      }
      case AST.EWasm: {
        for (const arg of expr.args) this.emitExpr(arg);
        for (const b of expr.bytes) this.body.push(b);
        break;
      }
      case AST.EComma: {
        for (let i = 0; i < expr.expressions.length; i++) {
          const isLast = i + 1 === expr.expressions.length;
          this.emitExpr(expr.expressions[i], isLast ? ctx : EXPR_DROP);
        }
        return;
      }
      case AST.ECompoundLiteral: {
        const fsAddr = this.fileScopeCompoundLiteralAddrs.get(expr);
        if (fsAddr !== undefined) {
          this.body.i32Const(fsAddr);
        } else {
          this.emitCompoundLiteralInit(expr);
          this.emitFrameAddr(this.compoundLiteralOffsets.get(expr));
        }
        this.emitLoadIfScalar(expr.type);
        break;
      }
      case AST.EGCNew: {
        const t = expr.type;
        const typeIdx = getOrCreateGCWasmTypeIdx(this.wmod, t);
        if (t.isGCStruct()) {
          if (expr.args.length === 0) {
            this.body.structNewDefault(typeIdx);
          } else {
            const fields = t.tagDecl.members;
            for (let i = 0; i < expr.args.length; i++) {
              this.emitExpr(expr.args[i]);
              this.emitConversion(expr.args[i].type, fields[i].type, expr.args[i]);
            }
            this.body.structNew(typeIdx);
          }
        } else { // GC_ARRAY
          if (expr.args.length === 1) {
            this.emitExpr(expr.args[0]);
            // length must be i32
            if (wtEquals(this.getBinaryWasmType(expr.args[0].type), WT_I64)) {
              this.body.aop(WT_I32, ALU.OP_WRAP_I64);
            }
            this.body.arrayNewDefault(typeIdx);
          } else {
            // [init, length]
            this.emitExpr(expr.args[1]);
            this.emitConversion(expr.args[1].type, t.baseType, expr.args[1]);
            this.emitExpr(expr.args[0]);
            if (wtEquals(this.getBinaryWasmType(expr.args[0].type), WT_I64)) {
              this.body.aop(WT_I32, ALU.OP_WRAP_I64);
            }
            this.body.arrayNew(typeIdx);
          }
        }
        break;
      }
      default:
        throw new Error(`emitExpr: unhandled expression ${expr.constructor.name}`);
    }
    if (ctx === EXPR_DROP) this.body.drop();
  }
}

// ====================
// generateCode orchestration
// ====================

// Walk a unit's globals to collect every ECompoundLiteral reachable
// from a static-storage init context (regular globals + static locals).
// These get static addresses; their counterparts inside function bodies
// (frame-scope) are collected separately per-function. The bag does
// the recursion — we just enumerate the entry points.
function collectFileScopeCompoundLiterals(unit) {
  const out = new Set();
  const collect = (expr) => {
    if (!expr) return;
    for (const cl of expr.referencedCompoundLiterals) out.add(cl);
  };
  for (const v of unit.definedVariables) collect(v.initExpr);
  for (const func of [...unit.definedFunctions, ...unit.staticFunctions]) {
    for (const v of (func.staticLocals || [])) collect(v.initExpr);
  }
  return out;
}

function generateCode(units, outputFile, options) {
  const writeErr = options && options.writeErr
    ? options.writeErr
    : (typeof process !== 'undefined' && process.stderr ? (s) => process.stderr.write(s) : () => {});
  const fatalExit = options && options.fatalExit
    ? options.fatalExit
    : (typeof process !== 'undefined' && process.exit ? (code) => process.exit(code) : (code) => { throw new Error(`Fatal error (exit code ${code})`); });
  const wmod = new WasmModule();
  const cg = new CodeGenerator(wmod, options);

  // Apply __minstack directives: take max across all TUs, round up to pages
  let maxMinStack = 0;
  for (const unit of units) maxMinStack = Math.max(maxMinStack, unit.minStackBytes || 0);
  if (maxMinStack > 0) {
    const minPages = Math.ceil(maxMinStack / 65536);
    cg.stackPages = Math.max(cg.stackPages, minPages);
  }

  // Stack pointer global
  const initialSp = cg.stackPages * 65536;
  cg.stackPointerGlobalIdx = wmod.addGlobalI32(initialSp, true);
  cg.heapBaseGlobalIdx = wmod.addGlobalI32(0, false);
  if (options.compilerOptions.emitNames) {
    wmod.globalNames.push({ idx: cg.stackPointerGlobalIdx, name: "__stack_pointer" });
    wmod.globalNames.push({ idx: cg.heapBaseGlobalIdx, name: "__heap_base" });
  }

  // Register imports
  for (const unit of units) {
    for (const func of unit.importedFunctions) {
      const fdef = func.definition || func;
      const typeId = getWasmFunctionTypeIdForCFunctionType(wmod, fdef.type);
      const mod = fdef.importModule || func.importModule || "c";
      const nm = fdef.importName || func.importName || fdef.name;
      const funcIdx = wmod.addFunctionImport(mod, nm, typeId);
      cg.funcDefToWasmFuncIdx.set(fdef, funcIdx);
      cg.funcDefToTableIdx.set(fdef, funcIdx + 1);
      if (options.compilerOptions.emitNames) wmod.funcNames.push({ idx: funcIdx, name: fdef.name });
    }
  }

  // Register function definitions
  let foundMain = false;
  for (const unit of units) {
    for (const func of [...unit.definedFunctions, ...unit.staticFunctions]) {
      const fdef = func.definition || func;
      if (fdef !== func) continue;
      const typeId = getWasmFunctionTypeIdForCFunctionType(wmod, fdef.type);
      const funcIdx = wmod.addFunctionDefinition(typeId);
      cg.funcDefToWasmFuncIdx.set(fdef, funcIdx);
      cg.funcDefToTableIdx.set(fdef, funcIdx + 1);
      if (options.compilerOptions.emitNames) wmod.funcNames.push({ idx: funcIdx, name: fdef.name });
      if (fdef.name === "main") { foundMain = true; wmod.addExport("main", 0x00, funcIdx); }
      if (fdef.name === "alloca") wmod.addExport("alloca", 0x00, funcIdx);
    }
  }
  if (!foundMain) {
    writeErr("Error: no 'main' function defined\n");
    fatalExit(1);
  }

  // Register exception tags
  for (const unit of units) {
    for (const tag of (unit.exceptionTags || [])) {
      if (cg.exceptionToWasmTagIdx.has(tag)) continue;
      const params = tag.paramTypes.map(pt => cToWasmType(pt, wmod));
      const typeId = wmod.addFunctionTypeId(params, []);
      const tagIdx = wmod.addTag(typeId);
      cg.exceptionToWasmTagIdx.set(tag, tagIdx);
    }
  }

  // Process __export directives
  for (const unit of units) {
    for (const [exportName, func] of unit.exportDirectives) {
      const fdef = func.definition || func;
      const funcIdx = cg.funcDefToWasmFuncIdx.get(fdef);
      if (funcIdx !== undefined) wmod.addExport(exportName, 0x00, funcIdx);
    }
  }

  // Allocate MEMORY addresses
  for (const unit of units) {
    for (const v of [...unit.definedVariables, ...unit.externVariables, ...unit.localExternVariables]) {
      if (v.storageClass === Types.StorageClass.EXTERN && v.definition !== v) continue;
      const varDef = v.definition || v;
      if (varDef.allocClass === Types.AllocClass.MEMORY && !cg.globalArrayAddrs.has(varDef)) {
        let align = cg.alignOf(varDef.type);
        if (varDef.requestedAlignment > 0 && varDef.requestedAlignment > align) align = varDef.requestedAlignment;
        const size = varDef.initExpr ? cg.computeInitAllocSize(varDef.type, varDef.initExpr)
                                    : cg.sizeOf(varDef.type);
        const addr = cg.allocateStatic(size, align);
        cg.globalArrayAddrs.set(varDef, addr);
      }
    }
    for (const func of [...unit.definedFunctions, ...unit.staticFunctions]) {
      const fdef = func.definition;
      if (!fdef) continue;
      for (const varDef of (fdef.staticLocals || [])) {
        if (varDef.allocClass === Types.AllocClass.MEMORY && !cg.globalArrayAddrs.has(varDef)) {
          let align = cg.alignOf(varDef.type);
          if (varDef.requestedAlignment > 0 && varDef.requestedAlignment > align) align = varDef.requestedAlignment;
          const addr = cg.allocateStatic(cg.sizeOf(varDef.type), align);
          cg.globalArrayAddrs.set(varDef, addr);
        }
      }
    }
    // File-scope compound literals: discover via the bag from every
    // global init expression (regular globals + static locals, whose
    // initExprs are evaluated as constant expressions at file scope).
    const fileScopeCLs = collectFileScopeCompoundLiterals(unit);
    for (const cl of fileScopeCLs) {
      if (cg.fileScopeCompoundLiteralAddrs.has(cl)) continue;
      const addr = cg.allocateStatic(cg.sizeOf(cl.type), cg.alignOf(cl.type));
      cg.fileScopeCompoundLiteralAddrs.set(cl, addr);
    }
  }

  // Initialize file-scope compound literals
  for (const unit of units) {
    for (const cl of collectFileScopeCompoundLiterals(unit)) {
      const addr = cg.fileScopeCompoundLiteralAddrs.get(cl);
      if (addr === undefined) continue; // already initialized in another TU pass
      const baseOffset = addr - (cg.stackPages * 65536);
      if (cl.type.isArray() && cl.initList.elements.length === 1 && cl.initList.elements[0] instanceof AST.EString) {
        cg.writeStringLiteralToStatic(cl.initList.elements[0].value, cl.type, baseOffset);
      } else if (cl.type.isAggregate() || cl.type.isArray()) {
        cg.populateInitListStatic(cl.initList, cl.type, baseOffset);
      } else {
        const initExpr = cl.initList.elements.length === 0 ? new AST.EInt(cl.loc, cl.type, 0n) : cl.initList.elements[0];
        const val = cg._constEvalExpr(initExpr);
        if (val) cg.writeConstValueToStatic(baseOffset, cl.type, val);
      }
    }
  }

  // Helper: register a global variable (REGISTER or initialize MEMORY)
  const registerGlobalVar = (varDef) => {
    if (varDef.allocClass === Types.AllocClass.MEMORY) {
      const addr = cg.globalArrayAddrs.get(varDef);
      const baseOffset = addr - (cg.stackPages * 65536);
      if (varDef.initExpr && varDef.initExpr instanceof AST.EInitList) {
        cg.populateInitListStatic(varDef.initExpr, varDef.type, baseOffset);
      } else if (varDef.initExpr && varDef.initExpr instanceof AST.ECompoundLiteral && varDef.type.isAggregate()) {
        cg.populateInitListStatic(varDef.initExpr.initList, varDef.type, baseOffset);
      } else if (varDef.initExpr && varDef.type.isArray() && varDef.initExpr instanceof AST.EString) {
        const str = varDef.initExpr.value;
        const copySize = cg.sizeOf(varDef.type);
        const len = Math.min(copySize, str.length);
        for (let i = 0; i < len; i++) cg.staticData[baseOffset + i] = str[i];
      } else if (varDef.initExpr && !varDef.type.isAggregate()) {
        const val = cg._constEvalExpr(varDef.initExpr);
        if (val) cg.writeConstValueToStatic(baseOffset, varDef.type, val);
      }
    } else if (varDef.type.removeQualifiers().isRef()) {
      const rt = varDef.type.removeQualifiers();
      if (rt === Types.TREFEXTERN) {
        throw new Error(`Cannot declare global '__refextern' variable '${varDef.name}' — non-nullable refs have no valid initializer. Use '__externref' instead.`);
      }
      // WASM globals can only have constant initializers (ref.null is the
      // only ref-typed constant we support). Reject non-null initializers
      // for global ref types — user must initialize in main / a startup fn.
      if (varDef.initExpr) {
        const isNullConst = (e) =>
          (e instanceof AST.EInt && e.value === 0n) ||
          (e instanceof AST.EImplicitCast && isNullConst(e.expr)) ||
          (e instanceof AST.ECast && isNullConst(e.expr));
        if (!isNullConst(varDef.initExpr)) {
          throw new Error(
            `global '${varDef.name}': reference-typed globals can only be initialized to null/0 ` +
            `(WASM constant init expressions can't allocate); set the value in main() or a startup function`);
        }
      }
      if (rt.isGCRef()) {
        const refWt = cToWasmType(rt, wmod);
        const initExpr = [];
        const code = new WasmCode(initExpr);
        // For concrete GC types (struct/array), heap is a type idx — use
        // the LEB-encoded form. For abstract heap types like __eqref (heap
        // byte 0x6D), use the single-byte form via refNull.
        if (refWt.heapIsIdx) code.refNullIdx(refWt.heap);
        else code.refNull(refWt.heap);
        code.end();
        const globalIdx = wmod.addGlobal(refWt, initExpr, true);
        cg.globalVarToWasmGlobalIdx.set(varDef, globalIdx);
        if (options.compilerOptions.emitNames) wmod.globalNames.push({ idx: globalIdx, name: varDef.name });
      } else {
        const globalIdx = wmod.addGlobalExternref(true);
        cg.globalVarToWasmGlobalIdx.set(varDef, globalIdx);
        if (options.compilerOptions.emitNames) wmod.globalNames.push({ idx: globalIdx, name: varDef.name });
      }
    } else {
      const wt = cToWasmType(varDef.type, wmod);
      // Determine initial value
      let globalIdx;
      if (varDef.initExpr && varDef.initExpr instanceof AST.EInt) {
        const val = Types.truncateConstInt(varDef.initExpr.value, varDef.type);
        if (wtEquals(wt, WT_F32)) globalIdx = wmod.addGlobalF32(Number(val), true);
        else if (wtEquals(wt, WT_F64)) globalIdx = wmod.addGlobalF64(Number(val), true);
        else if (wtEquals(wt, WT_I64)) globalIdx = wmod.addGlobalI64(val, true);
        else globalIdx = wmod.addGlobalI32(Number(val), true);
      } else if (varDef.initExpr && varDef.initExpr instanceof AST.EFloat) {
        if (wtEquals(wt, WT_F32)) globalIdx = wmod.addGlobalF32(varDef.initExpr.value, true);
        else globalIdx = wmod.addGlobalF64(varDef.initExpr.value, true);
      } else if (varDef.initExpr && varDef.initExpr instanceof AST.EString) {
        const addr = cg.getStringAddress(varDef.initExpr.value);
        globalIdx = wmod.addGlobalI32(addr, true);
      } else if (varDef.initExpr) {
        const val = cg._constEvalExpr(varDef.initExpr);
        if (val && (val.kind === "int" || val.kind === "float" || val.kind === "addr")) {
          const numVal = val.kind === "int" ? Number(val.intVal) :
                         val.kind === "float" ? val.floatVal : val.addrVal;
          if (wtEquals(wt, WT_F32)) globalIdx = wmod.addGlobalF32(numVal, true);
          else if (wtEquals(wt, WT_F64)) globalIdx = wmod.addGlobalF64(numVal, true);
          else if (wtEquals(wt, WT_I64)) globalIdx = wmod.addGlobalI64(BigInt(Math.trunc(numVal)), true);
          else globalIdx = wmod.addGlobalI32(numVal | 0, true);
        } else {
          // Zero init
          if (wtEquals(wt, WT_I64)) globalIdx = wmod.addGlobalI64(0n, true);
          else if (wtEquals(wt, WT_F32)) globalIdx = wmod.addGlobalF32(0.0, true);
          else if (wtEquals(wt, WT_F64)) globalIdx = wmod.addGlobalF64(0.0, true);
          else globalIdx = wmod.addGlobalI32(0, true);
        }
      } else {
        if (wtEquals(wt, WT_I64)) globalIdx = wmod.addGlobalI64(0n, true);
        else if (wtEquals(wt, WT_F32)) globalIdx = wmod.addGlobalF32(0.0, true);
        else if (wtEquals(wt, WT_F64)) globalIdx = wmod.addGlobalF64(0.0, true);
        else globalIdx = wmod.addGlobalI32(0, true);
      }
      cg.globalVarToWasmGlobalIdx.set(varDef, globalIdx);
      if (options.compilerOptions.emitNames) wmod.globalNames.push({ idx: globalIdx, name: varDef.name });
    }
  };

  // Register global variables
  for (const unit of units) {
    for (const v of [...unit.definedVariables, ...unit.externVariables, ...unit.localExternVariables]) {
      if (v.storageClass === Types.StorageClass.EXTERN && v.definition !== v) continue;
      const varDef = v.definition || v;
      registerGlobalVar(varDef);
    }
  }

  // Register static local variables
  for (const unit of units) {
    for (const func of [...unit.definedFunctions, ...unit.staticFunctions]) {
      const fdef = func.definition;
      if (!fdef) continue;
      for (const varDef of (fdef.staticLocals || [])) registerGlobalVar(varDef);
    }
  }

  // Emit function bodies. Default path: structured codegen for every
  // function. If a function accumulates "goto target not in scope"
  // errors during its emit, roll back its byte/locals output, run the
  // loop-switch lowering on it, and re-emit. Functions whose structured
  // emit succeeds pay no extra cost beyond two length-snapshots.
  const noLowering = !!options?.compilerOptions?.noIrreducibleLowering;
  const verbose = !!options?.compilerOptions?.verbose;
  const dumpIrredSegments = !!options?.compilerOptions?.dumpIrredSegments;
  const loweredFnNames = [];
  for (const unit of units) {
    for (const func of [...unit.definedFunctions, ...unit.staticFunctions]) {
      const fdef = func.definition || func;
      if (fdef !== func) continue;
      const defIdx = cg.funcDefToWasmFuncIdx.get(fdef) - wmod.funcImports.length;
      const wd = wmod.funcDefs[defIdx];
      // Snapshot the small handful of arrays the emitter appends to.
      // Per-function CodeGenerator state (locals, frame layout, scope
      // maps) is cleared at the start of every emitFunctionBody, so it
      // doesn't need rollback — only these module-level arrays do.
      const bodyLen = wd.body.length;
      const localsLen = wd.locals.length;
      const errLen = cg.gotoErrors.length;
      const smLen = cg.sourceMapEntries.length;
      const lnLen = wmod.localNames.length;

      cg.emitFunctionBody(fdef);

      if (!noLowering && cg.gotoErrors.length > errLen) {
        // Structured emit hit out-of-scope gotos. Roll back everything
        // we just appended, lower the function body into a loop-switch
        // state machine, and re-emit. The lowered body has only
        // structured control flow, so the second emit won't error.
        wd.body.length = bodyLen;
        wd.locals.length = localsLen;
        cg.gotoErrors.length = errLen;
        cg.sourceMapEntries.length = smLen;
        wmod.localNames.length = lnLen;
        if (verbose) {
          writeErr(`[irreducible] lowering '${fdef.name}' (retry after structured emit failed)\n`);
        }
        IRREDUCIBLE_LOWERING.lower(fdef, dumpIrredSegments ? writeErr : null);
        cg.emitFunctionBody(fdef);
        loweredFnNames.push(fdef.name);
      }
    }
  }
  if (verbose && loweredFnNames.length > 0) {
    writeErr(
      `note: ${loweredFnNames.length} function(s) required loop-switch lowering ` +
      `(irreducible / unresolved cross-block gotos):\n`);
    for (const n of loweredFnNames) writeErr(`  - ${n}\n`);
  }

  // Surface goto errors collected during emit. Out-of-scope gotos already
  // produced wasm `unreachable` opcodes inline; we just write the
  // diagnostics and exit. (Mirrors how the parser pass surfaces them.)
  if (cg.gotoErrors.length > 0) {
    for (const err of cg.gotoErrors) {
      writeErr(`${err.filename}:${err.line}: error: ${err.message}\n`);
    }
    fatalExit(1);
  }

  // Finalize memory
  const staticDataStart = cg.stackPages * 65536;
  const heapBase = (staticDataStart + cg.staticDataOffset + 7) & ~7;
  let minPages = Math.ceil(heapBase / 65536);
  if (minPages < cg.stackPages) minPages = cg.stackPages;
  const memoryIdx = wmod.addMemory(minPages);
  wmod.addExport("memory", 0x02, memoryIdx);
  wmod.addExport("__indirect_function_table", 0x01, 0);
  if (cg.staticData.length > 0) wmod.addDataSegment(staticDataStart, cg.staticData);
  wmod.patchGlobalI32(cg.heapBaseGlobalIdx, heapBase);
  wmod.addExport("__heap_base", 0x03, cg.heapBaseGlobalIdx);

  // Transfer source map data
  wmod.sourceMapFiles = cg.sourceMapFiles;
  wmod.sourceMapEntries = cg.sourceMapEntries;

  // Embed sources for -g2 — only files referenced by the source map
  if (options.compilerOptions.embedSources && options.sourceBuffers) {
    var sources = {};
    for (const f of cg.sourceMapFiles) {
      var content = options.sourceBuffers.get(f);
      if (content) sources[f] = content;
    }
    wmod.embeddedSources = sources;
  }

  const bytes = wmod.emit();

  // Backstop: ask the WASM engine whether we produced legal bytecode.
  // This is a LAST-RESORT diagnostic, not the primary one. It exists
  // because invalid WASM produced by a codegen bug is *much* nicer to
  // hit at compile time than at instantiation time on the user's machine.
  //
  // It is NOT a substitute for frontend / codegen checks:
  //   - The error points at a byte offset in the emitted module, not at
  //     C source. ("local.set[0] expected i32, found i64 @+160") That's
  //     near-useless to a user of the compiler.
  //   - Every error this catches should be considered a missing check
  //     somewhere upstream. Fix the upstream gap; don't lean on this.
  //
  // Skip entirely if WebAssembly isn't available (older runtimes, sandboxes).
  // Disabled with `--no-wasm-validate` if it ever becomes a hot-path concern.
  if (!options.compilerOptions.noWasmValidate &&
      typeof WebAssembly !== 'undefined' &&
      typeof WebAssembly.validate === 'function' &&
      !WebAssembly.validate(bytes)) {
    let detail = '(no detail available)';
    try { new WebAssembly.Module(bytes); }
    catch (e) { detail = e.message; }
    writeErr(
      `internal compiler error: emitted invalid WebAssembly: ${detail}\n` +
      `This is a codegen bug — please report. Frontend / codegen checks ` +
      `should catch this class of issue; the WASM validator is only a backstop.\n`);
    fatalExit(1);
  }
  return bytes;
}

return {
  generateCode,
};
})();

// ====================
// Stdlib
// ====================

const Stdlib = (() => {

const _stdlibHeaders = {
  "SDL.h": `
#pragma once
__require_source("__SDL.c");

typedef unsigned int Uint32;
typedef unsigned short Uint16;
typedef unsigned char Uint8;
typedef int Sint32;

typedef struct SDL_Surface {
    int w, h;
    int pitch;
    void *pixels;
} SDL_Surface;

typedef struct SDL_Window SDL_Window;

typedef struct SDL_Rect {
    int x, y, w, h;
} SDL_Rect;

typedef struct SDL_Keysym {
    int scancode;
    int sym;
    Uint16 mod;
    Uint32 unused;
} SDL_Keysym;

typedef struct SDL_KeyboardEvent {
    Uint32 type;
    Uint32 timestamp;
    Uint32 windowID;
    Uint8 state;
    Uint8 repeat;
    Uint8 padding2;
    Uint8 padding3;
    SDL_Keysym keysym;
} SDL_KeyboardEvent;

typedef struct SDL_MouseMotionEvent {
    Uint32 type;
    Uint32 timestamp;
    Uint32 windowID;
    Sint32 x;
    Sint32 y;
    Sint32 xrel;
    Sint32 yrel;
} SDL_MouseMotionEvent;

typedef struct SDL_MouseButtonEvent {
    Uint32 type;
    Uint32 timestamp;
    Uint32 windowID;
    Uint8 button;
    Uint8 state;
    Uint8 clicks;
    Uint8 padding1;
    Sint32 x;
    Sint32 y;
} SDL_MouseButtonEvent;

typedef struct SDL_MouseWheelEvent {
    Uint32 type;
    Uint32 timestamp;
    Uint32 windowID;
    Sint32 x;
    Sint32 y;
} SDL_MouseWheelEvent;

typedef union SDL_Event {
    Uint32 type;
    SDL_KeyboardEvent key;
    SDL_MouseMotionEvent motion;
    SDL_MouseButtonEvent button;
    SDL_MouseWheelEvent wheel;
    Uint8 padding[56];
} SDL_Event;

#define SDL_INIT_VIDEO 0x00000020
#define SDL_INIT_AUDIO 0x00000010
#define SDL_WINDOWPOS_CENTERED 0x2FFF0000
#define SDL_PIXELFORMAT_RGBA32 376840196
#define SDL_WINDOW_SHOWN 0x00000004
#define SDL_WINDOWPOS_UNDEFINED 0x1FFF0000
#define SDL_PIXELFORMAT_RGB888 370546692
#define SDL_QUIT 0x100
#define SDL_KEYDOWN 0x300
#define SDL_KEYUP 0x301
#define SDL_MOUSEMOTION 0x400
#define SDL_MOUSEBUTTONDOWN 0x401
#define SDL_MOUSEBUTTONUP 0x402
#define SDL_MOUSEWHEEL 0x403
#define SDL_PRESSED 1
#define SDL_RELEASED 0
#define SDL_BUTTON_LEFT 1
#define SDL_BUTTON_MIDDLE 2
#define SDL_BUTTON_RIGHT 3

#define SDLK_BACKSPACE 8
#define SDLK_TAB 9
#define SDLK_RETURN 13
#define SDLK_ESCAPE 27
#define SDLK_SPACE 32
#define SDLK_PLUS 43
#define SDLK_MINUS 45
#define SDLK_EQUALS 61
#define SDLK_DELETE 127
#define SDLK_CAPSLOCK 1073741881
#define SDLK_F1 1073741882
#define SDLK_F2 1073741883
#define SDLK_F3 1073741884
#define SDLK_F4 1073741885
#define SDLK_F5 1073741886
#define SDLK_F6 1073741887
#define SDLK_F7 1073741888
#define SDLK_F8 1073741889
#define SDLK_F9 1073741890
#define SDLK_F10 1073741891
#define SDLK_F11 1073741892
#define SDLK_F12 1073741893
#define SDLK_PRINTSCREEN 1073741894
#define SDLK_SCROLLLOCK 1073741895
#define SDLK_PAUSE 1073741896
#define SDLK_INSERT 1073741897
#define SDLK_HOME 1073741898
#define SDLK_PAGEUP 1073741899
#define SDLK_END 1073741901
#define SDLK_PAGEDOWN 1073741902
#define SDLK_RIGHT 1073741903
#define SDLK_LEFT 1073741904
#define SDLK_DOWN 1073741905
#define SDLK_UP 1073741906
#define SDLK_NUMLOCKCLEAR 1073741907
#define SDLK_LCTRL 1073742048
#define SDLK_LSHIFT 1073742049
#define SDLK_LALT 1073742050
#define SDLK_RCTRL 1073742052
#define SDLK_RSHIFT 1073742053
#define SDLK_RALT 1073742054

/* Audio format constants */
#define AUDIO_S8 0x8008
#define AUDIO_S16 0x8010
#define AUDIO_S32 0x8020
#define AUDIO_F32 0x8120

typedef Uint32 SDL_AudioDeviceID;

typedef struct SDL_AudioSpec {
    int freq;
    int format;
    Uint8 channels;
} SDL_AudioSpec;

int SDL_Init(Uint32 flags);
SDL_Window *SDL_CreateWindow(const char *title, int x, int y, int w, int h, Uint32 flags);
Uint32 SDL_GetWindowID(SDL_Window *window);
SDL_Surface *SDL_GetWindowSurface(SDL_Window *window);
int SDL_UpdateWindowSurface(SDL_Window *window);
int SDL_PollEvent(SDL_Event *event);
void SDL_DestroyWindow(SDL_Window *window);
void SDL_Quit(void);
void SDL_Delay(Uint32 ms);
Uint32 SDL_GetTicks(void);
void SDL_SetWindowTitle(SDL_Window *window, const char *title);
void __setAnimationFrameFunc(void (*callback)(void));

SDL_AudioDeviceID SDL_OpenAudioDevice(const char *device, int iscapture,
                                      const SDL_AudioSpec *desired,
                                      SDL_AudioSpec *obtained, int allowed_changes);
int SDL_QueueAudio(SDL_AudioDeviceID dev, const void *data, Uint32 len);
Uint32 SDL_GetQueuedAudioSize(SDL_AudioDeviceID dev);
void SDL_ClearQueuedAudio(SDL_AudioDeviceID dev);
void SDL_PauseAudioDevice(SDL_AudioDeviceID dev, int pause_on);
void SDL_CloseAudioDevice(SDL_AudioDeviceID dev);
  `,
  "__atexit.h": `
#pragma once
__require_source("__atexit.c");
int atexit(void (*func)(void));
void __run_atexits(void);
  `,
  "__malloc.h": `
#pragma once
#include <stddef.h>
__require_source("__malloc.c");

void *malloc(size_t size);
void free(void *ptr);
void *calloc(size_t count, size_t size);
void *realloc(void *ptr, size_t new_size);
void *aligned_alloc(size_t alignment, size_t size);

struct __heap_info {
  long heap_start;
  long heap_end;
  long total_bytes;
  long free_blocks;
  long free_bytes;
  long largest_free;
};
void __inspect_heap(struct __heap_info *info);
  `,
  "alloca.h": `
#pragma once
void *alloca(long size);
  `,
  "assert.h": `
__require_source("__assert.c");
void __assert_fail(const char *expr, const char *file, int line);
#ifdef NDEBUG
#define assert(expr) ((void)0)
#else
#define assert(expr) ((expr) ? (void)0 : __assert_fail(#expr, __FILE__, __LINE__))
#endif
#define static_assert _Static_assert
  `,
  "ctype.h": `
#pragma once
__require_source("__ctype.c");
int isalnum(int c);
int isalpha(int c);
int isblank(int c);
int iscntrl(int c);
int isdigit(int c);
int isgraph(int c);
int islower(int c);
int isprint(int c);
int ispunct(int c);
int isspace(int c);
int isupper(int c);
int isxdigit(int c);
int tolower(int c);
int toupper(int c);
  `,
  "wctype.h": `
#pragma once
__require_source("__wchar.c");
typedef unsigned int wint_t;
typedef int wctrans_t;
typedef int wctype_t;
#define WEOF ((wint_t)-1)
int iswalnum(wint_t c);
int iswalpha(wint_t c);
int iswblank(wint_t c);
int iswcntrl(wint_t c);
int iswdigit(wint_t c);
int iswgraph(wint_t c);
int iswlower(wint_t c);
int iswprint(wint_t c);
int iswpunct(wint_t c);
int iswspace(wint_t c);
int iswupper(wint_t c);
int iswxdigit(wint_t c);
wint_t towlower(wint_t c);
wint_t towupper(wint_t c);
  `,
  "wchar.h": `
#pragma once
#include <stddef.h>
#include <wctype.h>
__require_source("__wchar.c");
typedef struct { int __state; } mbstate_t;
size_t wcslen(const wchar_t *s);
wchar_t *wcscpy(wchar_t *dest, const wchar_t *src);
wchar_t *wcsncpy(wchar_t *dest, const wchar_t *src, size_t n);
int wcscmp(const wchar_t *s1, const wchar_t *s2);
int wcsncmp(const wchar_t *s1, const wchar_t *s2, size_t n);
wchar_t *wcscat(wchar_t *dest, const wchar_t *src);
wchar_t *wcsncat(wchar_t *dest, const wchar_t *src, size_t n);
wchar_t *wcschr(const wchar_t *s, wchar_t c);
wchar_t *wcsrchr(const wchar_t *s, wchar_t c);
wchar_t *wcsstr(const wchar_t *haystack, const wchar_t *needle);
size_t wcsspn(const wchar_t *s, const wchar_t *accept);
size_t wcscspn(const wchar_t *s, const wchar_t *reject);
wchar_t *wcspbrk(const wchar_t *s, const wchar_t *accept);
wchar_t *wcstok(wchar_t *str, const wchar_t *delim, wchar_t **saveptr);
int wcscoll(const wchar_t *s1, const wchar_t *s2);
size_t wcsxfrm(wchar_t *dest, const wchar_t *src, size_t n);
wchar_t *wmemcpy(wchar_t *dest, const wchar_t *src, size_t n);
wchar_t *wmemmove(wchar_t *dest, const wchar_t *src, size_t n);
wchar_t *wmemset(wchar_t *dest, wchar_t c, size_t n);
int wmemcmp(const wchar_t *s1, const wchar_t *s2, size_t n);
wchar_t *wmemchr(const wchar_t *s, wchar_t c, size_t n);
wint_t btowc(int c);
int wctob(wint_t c);
int mbsinit(const mbstate_t *ps);
size_t wcrtomb(char *s, wchar_t wc, mbstate_t *ps);
size_t mbrtowc(wchar_t *pwc, const char *s, size_t n, mbstate_t *ps);
  `,
  "sys/time.h": `
#pragma once
#include <time.h>
struct timeval {
  long tv_sec;
  long tv_usec;
};
__import int __gettimeofday(long *sec, long *usec);
static inline int gettimeofday(struct timeval *tv, void *tz) {
  (void)tz;
  if (tv) {
    __gettimeofday(&tv->tv_sec, &tv->tv_usec);
  }
  return 0;
}
static inline int utimes(const char *path, const struct timeval times[2]) {
  (void)path; (void)times;
  return 0;  /* no-op: succeed silently (no underlying mtime API) */
}
  `,
  "sys/file.h": `
#pragma once
  `,
  "sys/select.h": `
#pragma once
#include <sys/time.h>

#define FD_SETSIZE 64

typedef struct {
  unsigned long fds_bits[FD_SETSIZE / (8 * sizeof(unsigned long))];
} fd_set;

#define FD_ZERO(set)  do { for (int _i = 0; _i < (int)(sizeof((set)->fds_bits)/sizeof((set)->fds_bits[0])); _i++) (set)->fds_bits[_i] = 0; } while(0)
#define FD_SET(fd, set)   ((set)->fds_bits[(fd) / (8 * sizeof(unsigned long))] |= (1UL << ((fd) % (8 * sizeof(unsigned long)))))
#define FD_CLR(fd, set)   ((set)->fds_bits[(fd) / (8 * sizeof(unsigned long))] &= ~(1UL << ((fd) % (8 * sizeof(unsigned long)))))
#define FD_ISSET(fd, set) ((set)->fds_bits[(fd) / (8 * sizeof(unsigned long))] & (1UL << ((fd) % (8 * sizeof(unsigned long)))))

__import int __select_impl(int nfds, int *readfds, int *writefds, int *exceptfds, long timeout_sec, long timeout_usec, int has_timeout);

static inline int select(int nfds, fd_set *readfds, fd_set *writefds, fd_set *exceptfds, struct timeval *timeout) {
  return __select_impl(nfds,
    readfds ? (int *)readfds->fds_bits : (int *)0,
    writefds ? (int *)writefds->fds_bits : (int *)0,
    exceptfds ? (int *)exceptfds->fds_bits : (int *)0,
    timeout ? timeout->tv_sec : 0,
    timeout ? timeout->tv_usec : 0,
    timeout ? 1 : 0);
}
  `,
  "byteswap.h": `
#pragma once
static inline unsigned short bswap_16(unsigned short x) {
  return (x >> 8) | (x << 8);
}
static inline unsigned int bswap_32(unsigned int x) {
  return (x >> 24) | ((x >> 8) & 0xFF00) | ((x << 8) & 0xFF0000) | (x << 24);
}
static inline unsigned long long bswap_64(unsigned long long x) {
  return ((x >> 56) & 0xFF) | ((x >> 40) & 0xFF00) |
         ((x >> 24) & 0xFF0000) | ((x >> 8) & 0xFF000000ULL) |
         ((x << 8) & 0xFF00000000ULL) | ((x << 24) & 0xFF0000000000ULL) |
         ((x << 40) & 0xFF000000000000ULL) | ((x << 56) & 0xFF00000000000000ULL);
}
  `,
  "dirent.h": `
#pragma once
#include <sys/types.h>
#include <stdlib.h>
__require_source("__dirent.c");

#define DT_UNKNOWN 0
#define DT_DIR     4
#define DT_REG     8
#define DT_LNK    10

/* NOTE: d_ino is always 0 (Node.js directory APIs don't expose inodes).
   Use stat() to get st_ino if needed. */
struct dirent {
  long           d_ino;
  int            d_type;
  char           d_name[256];
};

struct __DIR;
typedef struct __DIR DIR;

DIR *opendir(const char *name);
int closedir(DIR *dirp);
struct dirent *readdir(DIR *dirp);
  `,
  "emscripten.h": `
#pragma once
__require_source("__emscripten.c");
#define EMSCRIPTEN_KEEPALIVE
void emscripten_set_main_loop(void (*func)(void), int fps, int simulate_infinite_loop);
void emscripten_async_call(void (*func)(void *), void *arg, int millis);
float emscripten_random(void);

// Async HTTP fetch callback typedefs. Used as parameter types of
// emscripten_async_wget3_data() / emscripten_async_wget2_data() in code that
// downloads remote resources at runtime (e.g., tinyemu's network-backed
// disk-image feature). The function itself is not provided here — the
// expectation is that calls into the wget pipeline are dead-code-eliminated
// in builds that don't enable network features.
typedef void (*em_async_wget2_data_onload_func)(unsigned int handle, void *arg, void *data, unsigned int size);
typedef void (*em_async_wget2_data_onerror_func)(unsigned int handle, void *arg, int http_status, const char *status_text);
typedef void (*em_async_wget2_data_onprogress_func)(unsigned int handle, void *arg, int loaded, int total);
  `,
  "errno.h": `
#pragma once
__require_source("__errno.c");
extern int errno;
#define EPERM   1
#define ENOENT  2
#define ESRCH   3
#define EINTR   4
#define EIO     5
#define ENXIO   6
#define E2BIG   7
#define ENOEXEC 8
#define EBADF   9
#define ECHILD  10
#define EAGAIN  11
#define ENOMEM  12
#define EACCES  13
#define EFAULT  14
#define EBUSY   16
#define EEXIST  17
#define EXDEV   18
#define ENODEV  19
#define ENOTDIR 20
#define EISDIR  21
#define EINVAL  22
#define ENFILE  23
#define EMFILE  24
#define ENOTTY  25
#define EFBIG   27
#define ENOSPC  28
#define ESPIPE  29
#define EROFS   30
#define EPIPE   32
#define EDOM    33
#define ERANGE  34
#define ENAMETOOLONG 36
#define ENOSYS  38
#define ENOTEMPTY 39
#define EWOULDBLOCK EAGAIN
#define ENOLCK    37
#define ETIMEDOUT 110
#define EOPNOTSUPP   95
#define EADDRINUSE   98
#define ECONNABORTED 103
#define ECONNRESET   104
#define ENOBUFS      105
#define ENOTCONN     107
#define ECONNREFUSED 111
#define EHOSTUNREACH 113
#define EALREADY    114
#define EINPROGRESS 115
  `,
  "fcntl.h": `
#pragma once
#include <unistd.h>
#include <sys/types.h>
#define O_RDONLY  0
#define O_WRONLY  1
#define O_RDWR    2
#define O_CREAT   0x40
#define O_EXCL    0x80
#define O_TRUNC   0x200
#define O_APPEND  0x400
#define O_NONBLOCK 0x800
#define O_NOFOLLOW 0x20000
#define O_CLOEXEC  0x80000

#define F_DUPFD    0
#define F_GETFD    1
#define F_SETFD    2
#define F_GETFL    3
#define F_SETFL    4
#define F_GETLK    5
#define F_SETLK    6
#define F_SETLKW   7
#define FD_CLOEXEC 1

#define F_RDLCK  0
#define F_WRLCK  1
#define F_UNLCK  2

struct flock {
  short l_type;
  short l_whence;
  off_t l_start;
  off_t l_len;
  pid_t l_pid;
};

__import int __open_impl(const char *path, int flags, int mode);
int open(const char *path, int flags, ...);
static inline int fcntl(int fd, int cmd, ...) {
  (void)fd; (void)cmd;
  /* No-op locking: SQLite uses fcntl() for advisory file locking which
   * doesn't apply in our single-threaded wasm runtime. Return success
   * so SQLite believes it acquired/released locks. */
  return 0;
}
  `,
  "fenv.h": `
#pragma once
#define FE_DIVBYZERO  1
#define FE_INEXACT    2
#define FE_INVALID    4
#define FE_OVERFLOW   8
#define FE_UNDERFLOW  16
#define FE_ALL_EXCEPT (FE_DIVBYZERO|FE_INEXACT|FE_INVALID|FE_OVERFLOW|FE_UNDERFLOW)
#define FE_TONEAREST  0
#define FE_DOWNWARD   1
#define FE_UPWARD     2
#define FE_TOWARDZERO 3
#define FE_DFL_ENV    ((const fenv_t *)0)
typedef unsigned int fexcept_t;
typedef unsigned int fenv_t;
static inline int feclearexcept(int e) { (void)e; return 0; }
static inline int fegetexceptflag(fexcept_t *f, int e) { (void)f; (void)e; return 0; }
static inline int feraiseexcept(int e) { (void)e; return 0; }
static inline int fesetexceptflag(const fexcept_t *f, int e) { (void)f; (void)e; return 0; }
static inline int fetestexcept(int e) { (void)e; return 0; }
static inline int fegetround(void) { return FE_TONEAREST; }
static inline int fesetround(int r) { (void)r; return 0; }
static inline int fegetenv(fenv_t *e) { (void)e; return 0; }
static inline int feholdexcept(fenv_t *e) { (void)e; return 0; }
static inline int fesetenv(const fenv_t *e) { (void)e; return 0; }
static inline int feupdateenv(const fenv_t *e) { (void)e; return 0; }
  `,
  "float.h": `
#pragma once
#define FLT_RADIX 2
#define FLT_ROUNDS 1
#define FLT_EVAL_METHOD 0
#define DECIMAL_DIG 21
#define FLT_DIG 6
#define FLT_MANT_DIG 24
#define FLT_MIN_EXP (-125)
#define FLT_MAX_EXP 128
#define FLT_MIN_10_EXP (-37)
#define FLT_MAX_10_EXP 38
#define FLT_MIN 1.17549435e-38F
#define FLT_MAX 3.40282347e+38F
#define FLT_EPSILON 1.19209290e-7F
#define FLT_TRUE_MIN 1.40129846e-45F
#define DBL_DIG 15
#define DBL_MANT_DIG 53
#define DBL_MIN_EXP (-1021)
#define DBL_MAX_EXP 1024
#define DBL_MIN_10_EXP (-307)
#define DBL_MAX_10_EXP 308
#define DBL_MIN 2.2250738585072014e-308
#define DBL_MAX 1.7976931348623157e+308
#define DBL_EPSILON 2.2204460492503131e-16
#define DBL_TRUE_MIN 4.9406564584124654e-324
#define LDBL_DIG DBL_DIG
#define LDBL_MANT_DIG DBL_MANT_DIG
#define LDBL_MIN_EXP DBL_MIN_EXP
#define LDBL_MAX_EXP DBL_MAX_EXP
#define LDBL_MIN_10_EXP DBL_MIN_10_EXP
#define LDBL_MAX_10_EXP DBL_MAX_10_EXP
#define LDBL_MIN DBL_MIN
#define LDBL_MAX DBL_MAX
#define LDBL_EPSILON DBL_EPSILON
#define LDBL_TRUE_MIN DBL_TRUE_MIN
  `,
  "getopt.h": `
#pragma once
__require_source("__getopt.c");

extern char *optarg;
extern int optind;
extern int opterr;
extern int optopt;

#define no_argument        0
#define required_argument  1
#define optional_argument  2

struct option {
  const char *name;
  int has_arg;
  int *flag;
  int val;
};

int getopt(int argc, char *const argv[], const char *optstring);
int getopt_long(int argc, char *const argv[], const char *optstring,
                const struct option *longopts, int *longindex);
int getopt_long_only(int argc, char *const argv[], const char *optstring,
                     const struct option *longopts, int *longindex);
  `,
  "inttypes.h": `
#pragma once
#include <stdint.h>

// Format macros for fprintf (wasm32: int=32, long=32, long long=64)
#define PRId8  "d"
#define PRId16 "d"
#define PRId32 "d"
#define PRId64 "lld"
#define PRIi8  "i"
#define PRIi16 "i"
#define PRIi32 "i"
#define PRIi64 "lli"
#define PRIu8  "u"
#define PRIu16 "u"
#define PRIu32 "u"
#define PRIu64 "llu"
#define PRIo8  "o"
#define PRIo16 "o"
#define PRIo32 "o"
#define PRIo64 "llo"
#define PRIx8  "x"
#define PRIx16 "x"
#define PRIx32 "x"
#define PRIx64 "llx"
#define PRIX8  "X"
#define PRIX16 "X"
#define PRIX32 "X"
#define PRIX64 "llX"

#define PRIdLEAST8  PRId8
#define PRIdLEAST16 PRId16
#define PRIdLEAST32 PRId32
#define PRIdLEAST64 PRId64
#define PRIiLEAST8  PRIi8
#define PRIiLEAST16 PRIi16
#define PRIiLEAST32 PRIi32
#define PRIiLEAST64 PRIi64
#define PRIuLEAST8  PRIu8
#define PRIuLEAST16 PRIu16
#define PRIuLEAST32 PRIu32
#define PRIuLEAST64 PRIu64
#define PRIoLEAST8  PRIo8
#define PRIoLEAST16 PRIo16
#define PRIoLEAST32 PRIo32
#define PRIoLEAST64 PRIo64
#define PRIxLEAST8  PRIx8
#define PRIxLEAST16 PRIx16
#define PRIxLEAST32 PRIx32
#define PRIxLEAST64 PRIx64
#define PRIXLEAST8  PRIX8
#define PRIXLEAST16 PRIX16
#define PRIXLEAST32 PRIX32
#define PRIXLEAST64 PRIX64

#define PRIdFAST8  PRId8
#define PRIdFAST16 PRId32
#define PRIdFAST32 PRId32
#define PRIdFAST64 PRId64
#define PRIiFAST8  PRIi8
#define PRIiFAST16 PRIi32
#define PRIiFAST32 PRIi32
#define PRIiFAST64 PRIi64
#define PRIuFAST8  PRIu8
#define PRIuFAST16 PRIu32
#define PRIuFAST32 PRIu32
#define PRIuFAST64 PRIu64
#define PRIoFAST8  PRIo8
#define PRIoFAST16 PRIo32
#define PRIoFAST32 PRIo32
#define PRIoFAST64 PRIo64
#define PRIxFAST8  PRIx8
#define PRIxFAST16 PRIx32
#define PRIxFAST32 PRIx32
#define PRIxFAST64 PRIx64
#define PRIXFAST8  PRIX8
#define PRIXFAST16 PRIX32
#define PRIXFAST32 PRIX32
#define PRIXFAST64 PRIX64

#define PRIdPTR "d"
#define PRIiPTR "i"
#define PRIuPTR "u"
#define PRIoPTR "o"
#define PRIxPTR "x"
#define PRIXPTR "X"

#define PRIdMAX PRId64
#define PRIiMAX PRIi64
#define PRIuMAX PRIu64
#define PRIoMAX PRIo64
#define PRIxMAX PRIx64
#define PRIXMAX PRIX64

// Format macros for fscanf
#define SCNd8  "hhd"
#define SCNd16 "hd"
#define SCNd32 "d"
#define SCNd64 "lld"
#define SCNi8  "hhi"
#define SCNi16 "hi"
#define SCNi32 "i"
#define SCNi64 "lli"
#define SCNu8  "hhu"
#define SCNu16 "hu"
#define SCNu32 "u"
#define SCNu64 "llu"
#define SCNo8  "hho"
#define SCNo16 "ho"
#define SCNo32 "o"
#define SCNo64 "llo"
#define SCNx8  "hhx"
#define SCNx16 "hx"
#define SCNx32 "x"
#define SCNx64 "llx"

#define SCNdLEAST8  SCNd8
#define SCNdLEAST16 SCNd16
#define SCNdLEAST32 SCNd32
#define SCNdLEAST64 SCNd64
#define SCNiLEAST8  SCNi8
#define SCNiLEAST16 SCNi16
#define SCNiLEAST32 SCNi32
#define SCNiLEAST64 SCNi64
#define SCNuLEAST8  SCNu8
#define SCNuLEAST16 SCNu16
#define SCNuLEAST32 SCNu32
#define SCNuLEAST64 SCNu64
#define SCNoLEAST8  SCNo8
#define SCNoLEAST16 SCNo16
#define SCNoLEAST32 SCNo32
#define SCNoLEAST64 SCNo64
#define SCNxLEAST8  SCNx8
#define SCNxLEAST16 SCNx16
#define SCNxLEAST32 SCNx32
#define SCNxLEAST64 SCNx64

#define SCNdFAST8  SCNd8
#define SCNdFAST16 SCNd32
#define SCNdFAST32 SCNd32
#define SCNdFAST64 SCNd64
#define SCNiFAST8  SCNi8
#define SCNiFAST16 SCNi32
#define SCNiFAST32 SCNi32
#define SCNiFAST64 SCNi64
#define SCNuFAST8  SCNu8
#define SCNuFAST16 SCNu32
#define SCNuFAST32 SCNu32
#define SCNuFAST64 SCNu64
#define SCNoFAST8  SCNo8
#define SCNoFAST16 SCNo32
#define SCNoFAST32 SCNo32
#define SCNoFAST64 SCNo64
#define SCNxFAST8  SCNx8
#define SCNxFAST16 SCNx32
#define SCNxFAST32 SCNx32
#define SCNxFAST64 SCNx64

#define SCNdPTR "d"
#define SCNiPTR "i"
#define SCNuPTR "u"
#define SCNoPTR "o"
#define SCNxPTR "x"

#define SCNdMAX SCNd64
#define SCNiMAX SCNi64
#define SCNuMAX SCNu64
#define SCNoMAX SCNo64
#define SCNxMAX SCNx64

// Functions
typedef struct { intmax_t quot; intmax_t rem; } imaxdiv_t;

intmax_t imaxabs(intmax_t n);
imaxdiv_t imaxdiv(intmax_t numer, intmax_t denom);
intmax_t strtoimax(const char *nptr, char **endptr, int base);
uintmax_t strtoumax(const char *nptr, char **endptr, int base);
  `,
  "iso646.h": `
#pragma once
#define and    &&
#define and_eq &=
#define bitand &
#define bitor  |
#define compl  ~
#define not    !
#define not_eq !=
#define or     ||
#define or_eq  |=
#define xor    ^
#define xor_eq ^=
  `,
  "limits.h": `
#pragma once
#define CHAR_BIT 8
#define SCHAR_MIN (-128)
#define SCHAR_MAX 127
#define UCHAR_MAX 255
#define CHAR_MIN SCHAR_MIN
#define CHAR_MAX SCHAR_MAX
#define MB_LEN_MAX 4
#define SHRT_MIN (-32768)
#define SHRT_MAX 32767
#define USHRT_MAX 65535
#define INT_MIN (-2147483647 - 1)
#define INT_MAX 2147483647
#define UINT_MAX 4294967295U
#define LONG_MIN (-2147483647L - 1L)
#define LONG_MAX 2147483647L
#define ULONG_MAX 4294967295UL
#define LLONG_MIN (-9223372036854775807LL - 1LL)
#define LLONG_MAX 9223372036854775807LL
#define ULLONG_MAX 18446744073709551615ULL
  `,
  "locale.h": `
#pragma once
__require_source("__locale.c");
#include <stddef.h>
#define NULL ((void *)0)

#define LC_ALL      0
#define LC_COLLATE  1
#define LC_CTYPE    2
#define LC_MONETARY 3
#define LC_NUMERIC  4
#define LC_TIME     5

struct lconv {
  char *decimal_point;
  char *thousands_sep;
  char *grouping;
  char *int_curr_symbol;
  char *currency_symbol;
  char *mon_decimal_point;
  char *mon_thousands_sep;
  char *mon_grouping;
  char *positive_sign;
  char *negative_sign;
  char int_frac_digits;
  char frac_digits;
  char p_cs_precedes;
  char p_sep_by_space;
  char n_cs_precedes;
  char n_sep_by_space;
  char p_sign_posn;
  char n_sign_posn;
};

char *setlocale(int category, const char *locale);
struct lconv *localeconv(void);
  `,
  "math.h": `
#pragma once
__require_source("__math.c");

#define INFINITY (1.0f / 0.0f)
#define NAN (0.0f / 0.0f)
#define HUGE_VAL ((double)INFINITY)
#define HUGE_VALF INFINITY
#define HUGE_VALL ((long double)INFINITY)

#define M_E        2.71828182845904523536
#define M_LOG2E    1.44269504088896340736
#define M_LOG10E   0.43429448190325182765
#define M_LN2      0.69314718055994530942
#define M_LN10     2.30258509299404568402
#define M_PI       3.14159265358979323846
#define M_PI_2     1.57079632679489661923
#define M_PI_4     0.78539816339744830962
#define M_1_PI     0.31830988618379067154
#define M_2_PI     0.63661977236758134308
#define M_2_SQRTPI 1.12837916709551257390
#define M_SQRT2    1.41421356237309504880
#define M_SQRT1_2  0.70710678118654752440

double fabs(double x);
double ceil(double x);
double floor(double x);
double trunc(double x);
double nearbyint(double x);
double rint(double x);
double sqrt(double x);

float fabsf(float x);
float ceilf(float x);
float floorf(float x);
float truncf(float x);
float nearbyintf(float x);
float rintf(float x);
float sqrtf(float x);

double fmin(double x, double y);
double fmax(double x, double y);
double copysign(double x, double y);

float fminf(float x, float y);
float fmaxf(float x, float y);
float copysignf(float x, float y);

// Host-imported math functions
__import double sin(double x);
__import double cos(double x);
__import double tan(double x);
__import double asin(double x);
__import double acos(double x);
__import double atan(double x);
__import double atan2(double y, double x);
__import double sinh(double x);
__import double cosh(double x);
__import double tanh(double x);
__import double asinh(double x);
__import double acosh(double x);
__import double atanh(double x);
__import double exp(double x);
__import double expm1(double x);
__import double log(double x);
__import double log2(double x);
__import double log10(double x);
__import double log1p(double x);
__import double pow(double x, double y);
__import double cbrt(double x);
__import double hypot(double x, double y);
__import double fmod(double x, double y);

float sinf(float x);
float cosf(float x);
float tanf(float x);
float asinf(float x);
float acosf(float x);
float atanf(float x);
float atan2f(float y, float x);
float sinhf(float x);
float coshf(float x);
float tanhf(float x);
float asinhf(float x);
float acoshf(float x);
float atanhf(float x);
float expf(float x);
float expm1f(float x);
float logf(float x);
float log2f(float x);
float log10f(float x);
float log1pf(float x);
float powf(float x, float y);
float cbrtf(float x);
float hypotf(float x, float y);
float fmodf(float x, float y);

double round(double x);
float roundf(float x);
double fdim(double x, double y);
float fdimf(float x, float y);
long lround(double x);
long lrint(double x);
long lroundf(float x);
long lrintf(float x);
double nextafter(double x, double y);
float nextafterf(float x, float y);
double frexp(double x, int *exp);
double ldexp(double x, int n);
float ldexpf(float x, int n);
int ilogb(double x);
double logb(double x);
double modf(double x, double *iptr);
float modff(float x, float *iptr);

// C99 §7.12.11.2: nan/nanf return a quiet NaN. We ignore the tag arg
// and just return NAN — sufficient for "nan" string parsing.
double nan(const char *tag);
float nanf(const char *tag);

// C99 special functions (host-imported).
__import double erf(double x);
__import double erfc(double x);
__import double tgamma(double x);
__import double lgamma(double x);
float erff(float x);
float erfcf(float x);
float tgammaf(float x);
float lgammaf(float x);

// C99 classification macros. We provide function-style impls; users
// invoke as isnan(x), isinf(x), etc. (the standard prescribes macros
// but functions are accepted in any real compiler).
int __isnand(double x);
int __isinfd(double x);
int __isfinited(double x);
int __isnormald(double x);
int __signbitd(double x);
int __isnanf(float x);
int __isinff(float x);
int __isfinitef(float x);
int __isnormalf(float x);
int __signbitf(float x);
#define isnan(x)    _Generic((x), float: __isnanf,    default: __isnand)(x)
#define isinf(x)    _Generic((x), float: __isinff,    default: __isinfd)(x)
#define isfinite(x) _Generic((x), float: __isfinitef, default: __isfinited)(x)
#define isnormal(x) _Generic((x), float: __isnormalf, default: __isnormald)(x)
#define signbit(x)  _Generic((x), float: __signbitf,  default: __signbitd)(x)

// frexpf: float version of frexp.
float frexpf(float x, int *exp);
  `,
  "setjmp.h": `
#pragma once
__require_source("__setjmp.c");
typedef int jmp_buf[1];
__exception __LongJump(int, int);
extern int __setjmp_id_counter;
__import int setjmp(jmp_buf env);
__import void longjmp(jmp_buf env, int val);
`,
  "signal.h": `
#pragma once
__require_source("__signal.c");
typedef int sig_atomic_t;
typedef void (*__sighandler_t)(int);
#define SIG_DFL ((__sighandler_t)0)
#define SIG_IGN ((__sighandler_t)1)
#define SIG_ERR ((__sighandler_t)-1)
#define SIGABRT 6
#define SIGFPE  8
#define SIGILL  4
#define SIGINT  2
#define SIGSEGV 11
#define SIGTERM 15
__sighandler_t signal(int __sig, __sighandler_t __handler);
int raise(int __sig);
  `,
  "stdalign.h": `
#pragma once
#define alignof _Alignof
#define alignas _Alignas
#define __alignof_is_defined 1
#define __alignas_is_defined 1
  `,
  "stdarg.h": `
#pragma once
typedef int *__va_elem;
typedef __va_elem va_list[1];
#define va_start(ap, param) __builtin_va_start(ap[0], param)
#define va_arg(ap, type) __builtin_va_arg(ap[0], type)
#define va_end(ap) __builtin_va_end(ap[0])
#define va_copy(dest, src) __builtin_va_copy(dest[0], src[0])
  `,
  "stdbool.h": `
#pragma once
#define bool _Bool
#define true 1
#define false 0
#define __bool_true_false_are_defined 1
  `,
  "stddef.h": `
#pragma once
typedef unsigned long size_t; // Use long for all pointer-sized types
typedef long ptrdiff_t;
typedef int wchar_t;
typedef long double max_align_t;
#define NULL ((void *)0)
#define offsetof(type, member) ((size_t)&((type *)0)->member)
  `,
  "stdint.h": `
#pragma once

// Exact-width integer types
typedef signed char int8_t;
typedef unsigned char uint8_t;
typedef short int16_t;
typedef unsigned short uint16_t;
typedef int int32_t;
typedef unsigned int uint32_t;
typedef long long int64_t;
typedef unsigned long long uint64_t;

// Minimum-width integer types (use exact-width types)
typedef int8_t int_least8_t;
typedef uint8_t uint_least8_t;
typedef int16_t int_least16_t;
typedef uint16_t uint_least16_t;
typedef int32_t int_least32_t;
typedef uint32_t uint_least32_t;
typedef int64_t int_least64_t;
typedef uint64_t uint_least64_t;

// Fastest minimum-width integer types
// For wasm32, 32-bit operations are native
typedef int8_t int_fast8_t;
typedef uint8_t uint_fast8_t;
typedef int32_t int_fast16_t;
typedef uint32_t uint_fast16_t;
typedef int32_t int_fast32_t;
typedef uint32_t uint_fast32_t;
typedef int64_t int_fast64_t;
typedef uint64_t uint_fast64_t;

// Integer types capable of holding object pointers
typedef long intptr_t;
typedef unsigned long uintptr_t;

// Greatest-width integer types
typedef int64_t intmax_t;
typedef uint64_t uintmax_t;

// Limits of exact-width integer types
#define INT8_MIN (-128)
#define INT8_MAX 127
#define UINT8_MAX 255
#define INT16_MIN (-32768)
#define INT16_MAX 32767
#define UINT16_MAX 65535
#define INT32_MIN (-2147483647 - 1)
#define INT32_MAX 2147483647
#define UINT32_MAX 4294967295U
#define INT64_MIN (-9223372036854775807LL - 1LL)
#define INT64_MAX 9223372036854775807LL
#define UINT64_MAX 18446744073709551615ULL

// Limits of minimum-width integer types
#define INT_LEAST8_MIN INT8_MIN
#define INT_LEAST8_MAX INT8_MAX
#define UINT_LEAST8_MAX UINT8_MAX
#define INT_LEAST16_MIN INT16_MIN
#define INT_LEAST16_MAX INT16_MAX
#define UINT_LEAST16_MAX UINT16_MAX
#define INT_LEAST32_MIN INT32_MIN
#define INT_LEAST32_MAX INT32_MAX
#define UINT_LEAST32_MAX UINT32_MAX
#define INT_LEAST64_MIN INT64_MIN
#define INT_LEAST64_MAX INT64_MAX
#define UINT_LEAST64_MAX UINT64_MAX

// Limits of fastest minimum-width integer types
#define INT_FAST8_MIN INT8_MIN
#define INT_FAST8_MAX INT8_MAX
#define UINT_FAST8_MAX UINT8_MAX
#define INT_FAST16_MIN INT32_MIN
#define INT_FAST16_MAX INT32_MAX
#define UINT_FAST16_MAX UINT32_MAX
#define INT_FAST32_MIN INT32_MIN
#define INT_FAST32_MAX INT32_MAX
#define UINT_FAST32_MAX UINT32_MAX
#define INT_FAST64_MIN INT64_MIN
#define INT_FAST64_MAX INT64_MAX
#define UINT_FAST64_MAX UINT64_MAX

// Limits of integer types capable of holding object pointers
#define INTPTR_MIN INT32_MIN
#define INTPTR_MAX INT32_MAX
#define UINTPTR_MAX UINT32_MAX

// Limits of greatest-width integer types
#define INTMAX_MIN INT64_MIN
#define INTMAX_MAX INT64_MAX
#define UINTMAX_MAX UINT64_MAX

// Limits of other integer types
#define PTRDIFF_MIN INT32_MIN
#define PTRDIFF_MAX INT32_MAX
#define SIZE_MAX UINT32_MAX

// Macros for integer constant expressions
#define INT8_C(x) (x)
#define INT16_C(x) (x)
#define INT32_C(x) (x)
#define INT64_C(x) (x ## LL)
#define UINT8_C(x) (x)
#define UINT16_C(x) (x)
#define UINT32_C(x) (x ## U)
#define UINT64_C(x) (x ## ULL)
#define INTMAX_C(x) INT64_C(x)
#define UINTMAX_C(x) UINT64_C(x)
  `,
  "stdio.h": `
#pragma once
__require_source("__stdio.c");
#include <stddef.h>
#include <stdarg.h>
#define NULL ((void *)0)
#define EOF (-1)

#define _IOFBF 0
#define _IOLBF 1
#define _IONBF 2
#define BUFSIZ 1024
#define FOPEN_MAX 64
#define FILENAME_MAX 4096
#define L_tmpnam 20
#define TMP_MAX 10000

#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2

#define __F_READ  1
#define __F_WRITE 2
#define __F_APPEND 4
#define __F_EOF   8
#define __F_ERR   16
/* The buffer currently holds data from fread/buffered input.
 * Used to keep fflush from treating a partially-consumed read buffer
 * as pending write data in an r+ / w+ stream. */
#define __F_RBUF  32

typedef struct FILE {
  int fd;
  int flags;
  int buf_mode;
  char *buf;
  int buf_size;
  int buf_pos;
  int buf_len;
  int ungetc_char;
} FILE;

typedef long fpos_t;

extern FILE __stdin_file;
extern FILE __stdout_file;
extern FILE __stderr_file;

#define stdin  (&__stdin_file)
#define stdout (&__stdout_file)
#define stderr (&__stderr_file)

int sprintf(char *buf, const char *fmt, ...);
int snprintf(char *buf, size_t size, const char *fmt, ...);
__import int vsnprintf(char *buf, size_t size, const char *fmt, va_list ap);

int printf(const char *fmt, ...);
int vprintf(const char *fmt, va_list ap);
int fprintf(FILE *stream, const char *fmt, ...);
int vfprintf(FILE *stream, const char *fmt, va_list ap);
int vsprintf(char *buf, const char *fmt, va_list ap);
int putchar(int c);
int puts(const char *s);
FILE *fopen(const char *path, const char *mode);
int fclose(FILE *stream);
size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream);
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream);
int fflush(FILE *stream);
int fputs(const char *s, FILE *stream);
int fputc(int c, FILE *stream);
int fgetc(FILE *stream);
char *fgets(char *s, int n, FILE *stream);
int ungetc(int c, FILE *stream);

int fseek(FILE *stream, long offset, int whence);
long ftell(FILE *stream);
void rewind(FILE *stream);
int fgetpos(FILE *stream, fpos_t *pos);
int fsetpos(FILE *stream, const fpos_t *pos);

int feof(FILE *stream);
int ferror(FILE *stream);
void clearerr(FILE *stream);
int setvbuf(FILE *stream, char *buf, int mode, size_t size);
void setbuf(FILE *stream, char *buf);
void perror(const char *s);
char *gets(char *s);

__import int __vsscanf_impl(const char *str, int str_len, const char *fmt,
                            int *consumed, va_list ap);
int vsscanf(const char *s, const char *fmt, va_list ap);
int sscanf(const char *s, const char *fmt, ...);
int vfscanf(FILE *stream, const char *fmt, va_list ap);
int fscanf(FILE *stream, const char *fmt, ...);
int vscanf(const char *fmt, va_list ap);
int scanf(const char *fmt, ...);

__import int remove(const char *path);
__import int rename(const char *oldpath, const char *newpath);

FILE *freopen(const char *path, const char *mode, FILE *stream);
FILE *tmpfile(void);
char *tmpnam(char *s);
FILE *popen(const char *command, const char *type);
int pclose(FILE *stream);

#define getc(stream)     fgetc(stream)
#define getchar()        fgetc(stdin)
#define putc(c, stream)  fputc(c, stream)
  `,
  "stdlib.h": `
#pragma once
__require_source("__stdlib.c");
#include <stddef.h>
#include <__atexit.h>
#include <__malloc.h>

#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 32767

int abs(int n);
long labs(long n);

typedef struct { int quot; int rem; } div_t;
typedef struct { long quot; long rem; } ldiv_t;
typedef struct { long long quot; long long rem; } lldiv_t;
div_t div(int numer, int denom);
ldiv_t ldiv(long numer, long denom);
lldiv_t lldiv(long long numer, long long denom);

int atoi(const char *nptr);
long atol(const char *nptr);
long long atoll(const char *nptr);
long strtol(const char *nptr, char **endptr, int base);
unsigned long strtoul(const char *nptr, char **endptr, int base);
long long strtoll(const char *nptr, char **endptr, int base);
unsigned long long strtoull(const char *nptr, char **endptr, int base);
double strtod(const char *nptr, char **endptr);
float strtof(const char *nptr, char **endptr);
long double strtold(const char *nptr, char **endptr);
double atof(const char *nptr);
long long llabs(long long n);
int rand(void);
void srand(unsigned int seed);
void *bsearch(const void *key, const void *base, size_t nmemb,
              size_t size, int (*compar)(const void *, const void *));
void qsort(void *base, size_t nmemb, size_t size,
           int (*compar)(const void *, const void *));
void exit(int status);
void abort(void);

char *getenv(const char *name);
int setenv(const char *name, const char *value, int overwrite);
int unsetenv(const char *name);
int system(const char *command);

#define MB_CUR_MAX 1
int mblen(const char *s, size_t n);
int mbtowc(wchar_t *pwc, const char *s, size_t n);
int wctomb(char *s, wchar_t wc);
size_t mbstowcs(wchar_t *dest, const char *src, size_t n);
size_t wcstombs(char *dest, const wchar_t *src, size_t n);
  `,
  "stdnoreturn.h": `
#pragma once
#define noreturn _Noreturn
  `,
  "string.h": `
#pragma once
__require_source("__string.c");
#include <stddef.h>
#define NULL ((void *)0)
void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *s, int c, size_t n);
int memcmp(const void *s1, const void *s2, size_t n);
size_t strlen(const char *s);
char *strcpy(char *dest, const char *src);
char *strncpy(char *dest, const char *src, size_t n);
int strcmp(const char *s1, const char *s2);
int strncmp(const char *s1, const char *s2, size_t n);
char *strcat(char *dest, const char *src);
char *strchr(const char *s, int c);
char *strrchr(const char *s, int c);
char *strstr(const char *haystack, const char *needle);
void *memchr(const void *s, int c, size_t n);
char *strncat(char *dest, const char *src, size_t n);
size_t strspn(const char *s, const char *accept);
size_t strcspn(const char *s, const char *reject);
char *strpbrk(const char *s, const char *accept);
char *strtok(char *str, const char *delim);
int strcoll(const char *s1, const char *s2);
size_t strxfrm(char *dest, const char *src, size_t n);
char *strerror(int errnum);
char *strdup(const char *s);
  `,
  "strings.h": `
#pragma once
__require_source("__strings.c");
#include <stddef.h>
int strcasecmp(const char *s1, const char *s2);
int strncasecmp(const char *s1, const char *s2, size_t n);
int ffs(int x);
int ffsl(long x);
int ffsll(long long x);
int fls(int x);
int flsl(long x);
int flsll(long long x);
  `,
  "sys/stat.h": `
#pragma once
#include <sys/types.h>

#define S_IRWXU 0700
#define S_IRUSR 0400
#define S_IWUSR 0200
#define S_IXUSR 0100
#define S_IRWXG 0070
#define S_IRGRP 0040
#define S_IWGRP 0020
#define S_IXGRP 0010
#define S_IRWXO 0007
#define S_IROTH 0004
#define S_IWOTH 0002
#define S_IXOTH 0001

#define S_IFMT   0170000
#define S_IFDIR  0040000
#define S_IFREG  0100000
#define S_IFLNK  0120000
#define S_IFCHR  0020000
#define S_IFBLK  0060000
#define S_IFIFO  0010000
#define S_IFSOCK 0140000
#define S_ISDIR(m)  (((m) & S_IFMT) == S_IFDIR)
#define S_ISREG(m)  (((m) & S_IFMT) == S_IFREG)
#define S_ISLNK(m)  (((m) & S_IFMT) == S_IFLNK)
#define S_ISCHR(m)  (((m) & S_IFMT) == S_IFCHR)
#define S_ISBLK(m)  (((m) & S_IFMT) == S_IFBLK)
#define S_ISFIFO(m) (((m) & S_IFMT) == S_IFIFO)
#define S_ISSOCK(m) (((m) & S_IFMT) == S_IFSOCK)

struct stat {
  unsigned long st_dev;
  unsigned long st_ino;
  unsigned long st_mode;
  unsigned long st_nlink;
  unsigned long st_size;
  long          st_atime;
  long          st_mtime;
  long          st_ctime;
  unsigned int  st_uid;
  unsigned int  st_gid;
  long          st_blksize;
  long          st_blocks;
};

__import int mkdir(const char *path, int mode);
__import int stat(const char *path, struct stat *buf);
__import int lstat(const char *path, struct stat *buf);
__import int fstat(int fd, struct stat *buf);
  `,
  "sys/types.h": `
#pragma once
typedef long ssize_t;
typedef long off_t;
typedef unsigned long size_t;
typedef int mode_t;
typedef int pid_t;
typedef unsigned int uid_t;
typedef unsigned int gid_t;
typedef unsigned long dev_t;
typedef unsigned long ino_t;
typedef long time_t;
  `,
  "tgmath.h": `
#pragma once
#include <math.h>

/* Type-generic macros for <math.h> functions (C11 7.25) */
/* Each macro dispatches to the float variant for float arguments, */
/* and the double variant otherwise.                               */

/* Unary float/double */
#define fabs(x)      _Generic((x), float: fabsf,      default: fabs)(x)
#define ceil(x)      _Generic((x), float: ceilf,      default: ceil)(x)
#define floor(x)     _Generic((x), float: floorf,     default: floor)(x)
#define trunc(x)     _Generic((x), float: truncf,     default: trunc)(x)
#define nearbyint(x) _Generic((x), float: nearbyintf, default: nearbyint)(x)
#define rint(x)      _Generic((x), float: rintf,      default: rint)(x)
#define sqrt(x)      _Generic((x), float: sqrtf,      default: sqrt)(x)
#define sin(x)       _Generic((x), float: sinf,       default: sin)(x)
#define cos(x)       _Generic((x), float: cosf,       default: cos)(x)
#define tan(x)       _Generic((x), float: tanf,       default: tan)(x)
#define asin(x)      _Generic((x), float: asinf,      default: asin)(x)
#define acos(x)      _Generic((x), float: acosf,      default: acos)(x)
#define atan(x)      _Generic((x), float: atanf,      default: atan)(x)
#define sinh(x)      _Generic((x), float: sinhf,      default: sinh)(x)
#define cosh(x)      _Generic((x), float: coshf,      default: cosh)(x)
#define tanh(x)      _Generic((x), float: tanhf,      default: tanh)(x)
#define asinh(x)     _Generic((x), float: asinhf,     default: asinh)(x)
#define acosh(x)     _Generic((x), float: acoshf,     default: acosh)(x)
#define atanh(x)     _Generic((x), float: atanhf,     default: atanh)(x)
#define exp(x)       _Generic((x), float: expf,       default: exp)(x)
#define expm1(x)     _Generic((x), float: expm1f,     default: expm1)(x)
#define log(x)       _Generic((x), float: logf,       default: log)(x)
#define log2(x)      _Generic((x), float: log2f,      default: log2)(x)
#define log10(x)     _Generic((x), float: log10f,     default: log10)(x)
#define log1p(x)     _Generic((x), float: log1pf,     default: log1p)(x)
#define cbrt(x)      _Generic((x), float: cbrtf,      default: cbrt)(x)
#define round(x)     _Generic((x), float: roundf,     default: round)(x)

/* Binary float/double — dispatch on (x)+(y) so mixed float/double promotes */
#define fdim(x, y)      _Generic((x)+(y), float: fdimf,      default: fdim)(x, y)
#define fmin(x, y)      _Generic((x)+(y), float: fminf,      default: fmin)(x, y)
#define fmax(x, y)      _Generic((x)+(y), float: fmaxf,      default: fmax)(x, y)
#define copysign(x, y)  _Generic((x)+(y), float: copysignf,  default: copysign)(x, y)
#define fmod(x, y)      _Generic((x)+(y), float: fmodf,      default: fmod)(x, y)
#define pow(x, y)       _Generic((x)+(y), float: powf,       default: pow)(x, y)
#define atan2(y, x)     _Generic((y)+(x), float: atan2f,     default: atan2)(y, x)
#define hypot(x, y)     _Generic((x)+(y), float: hypotf,     default: hypot)(x, y)
#define nextafter(x, y) _Generic((x)+(y), float: nextafterf, default: nextafter)(x, y)

/* ldexp: second arg is always int, dispatch on first arg only */
#define ldexp(x, n)     _Generic((x), float: ldexpf,    default: ldexp)(x, n)
  `,
  "threads.h": `
#pragma once
#define thread_local _Thread_local
  `,
  "time.h": `
#pragma once
__require_source("__time.c");
#include <stddef.h>

typedef long time_t;
typedef long clock_t;

struct tm {
  int tm_sec;
  int tm_min;
  int tm_hour;
  int tm_mday;
  int tm_mon;
  int tm_year;
  int tm_wday;
  int tm_yday;
  int tm_isdst;
  long tm_gmtoff;
};

struct timespec {
  long tv_sec;
  long tv_nsec;
};

typedef int clockid_t;
#define CLOCKS_PER_SEC 1000
#define CLOCK_REALTIME 0
#define CLOCK_MONOTONIC 1

time_t time(time_t *t);
clock_t clock(void);
double difftime(time_t t1, time_t t0);
struct tm *gmtime(const time_t *timep);
struct tm *localtime(const time_t *timep);
struct tm *localtime_r(const time_t *timep, struct tm *result);
time_t mktime(struct tm *tm);
char *asctime(const struct tm *tm);
char *ctime(const time_t *timep);
size_t strftime(char *s, size_t max, const char *fmt, const struct tm *tm);
int clock_gettime(clockid_t clk_id, struct timespec *tp);
__import int __nanosleep(long sec, long nsec);
static inline int nanosleep(const struct timespec *req, struct timespec *rem) {
  (void)rem;
  return __nanosleep(req->tv_sec, req->tv_nsec);
}
  `,
  "uchar.h": `
#pragma once
#include <stdint.h>
typedef uint_least16_t char16_t;
typedef uint_least32_t char32_t;
#define __STDC_UTF_16__ 1
#define __STDC_UTF_32__ 1
  `,
  "unistd.h": `
#pragma once
typedef long ssize_t;
typedef long off_t;
#define STDIN_FILENO  0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
#define F_OK 0
#define R_OK 4
#define W_OK 2
#define X_OK 1
__import int close(int fd);
__import long read(int fd, void *buf, long count);
__import long write(int fd, const void *buf, long count);
__import long lseek(int fd, long offset, int whence);
__import char *getcwd(char *buf, long size);
__import int chdir(const char *path);
__import int access(const char *path, int mode);
__import int rmdir(const char *path);
__import int unlink(const char *path);
__import int pipe(int pipefd[2]);
__import int dup(int oldfd);
__import int dup2(int oldfd, int newfd);
__import int getpid(void);
__import int isatty(int fd);
__import int usleep(unsigned int usec);
__import int ftruncate(int fd, long length);
__import long readlink(const char *path, char *buf, long bufsize);
__import int fsync(int fd);
__import int fdatasync(int fd);
__import unsigned int sleep(unsigned int seconds);
__import int symlink(const char *target, const char *linkpath);
__import int chmod(const char *path, int mode);
__import char *realpath(const char *path, char *resolved);
  `,
  "termios.h": `
#pragma once
#include <sys/types.h>

typedef unsigned int tcflag_t;
typedef unsigned char cc_t;
typedef unsigned int speed_t;

#define NCCS 20

struct termios {
  tcflag_t c_iflag;
  tcflag_t c_oflag;
  tcflag_t c_cflag;
  tcflag_t c_lflag;
  cc_t     c_cc[NCCS];
  speed_t  c_ispeed;
  speed_t  c_ospeed;
};

#define IGNBRK  0x00001
#define BRKINT  0x00002
#define IGNPAR  0x00004
#define PARMRK  0x00008
#define INPCK   0x00010
#define ISTRIP  0x00020
#define INLCR   0x00040
#define IGNCR   0x00080
#define ICRNL   0x00100
#define IXON    0x00200
#define IXOFF   0x00400
#define IXANY   0x00800
#define IMAXBEL 0x02000

#define OPOST   0x00001
#define ONLCR   0x00002
#define OCRNL   0x00004

#define CSIZE   0x00300
#define CS5     0x00000
#define CS6     0x00100
#define CS7     0x00200
#define CS8     0x00300
#define CSTOPB  0x00400
#define CREAD   0x00800
#define PARENB  0x01000
#define PARODD  0x02000
#define HUPCL   0x04000
#define CLOCAL  0x08000

#define ECHOE   0x00002
#define ECHOK   0x00004
#define ECHO    0x00008
#define ECHONL  0x00010
#define ISIG    0x00080
#define ICANON  0x00100
#define IEXTEN  0x00400
#define TOSTOP  0x00800
#define NOFLSH  0x80000000

#define VEOF    0
#define VEOL    1
#define VERASE  3
#define VKILL   5
#define VINTR   8
#define VQUIT   9
#define VSUSP   10
#define VSTART  12
#define VSTOP   13
#define VMIN    16
#define VTIME   17

#define TCSANOW   0
#define TCSADRAIN 1
#define TCSAFLUSH 2

#define B0      0
#define B9600   9600
#define B19200  19200
#define B38400  38400
#define B115200 115200

__import int __tcgetattr(int fd, int *iflag, int *oflag, int *cflag, int *lflag);
__import int __tcsetattr(int fd, int actions, int iflag, int oflag, int cflag, int lflag);

static inline int tcgetattr(int fd, struct termios *t) {
  int iflag, oflag, cflag, lflag;
  int r = __tcgetattr(fd, &iflag, &oflag, &cflag, &lflag);
  if (r == 0) {
    t->c_iflag = (tcflag_t)iflag;
    t->c_oflag = (tcflag_t)oflag;
    t->c_cflag = (tcflag_t)cflag;
    t->c_lflag = (tcflag_t)lflag;
  }
  return r;
}

static inline int tcsetattr(int fd, int actions, const struct termios *t) {
  return __tcsetattr(fd, actions, (int)t->c_iflag, (int)t->c_oflag, (int)t->c_cflag, (int)t->c_lflag);
}

static inline void cfmakeraw(struct termios *t) {
  t->c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
  t->c_oflag &= ~OPOST;
  t->c_lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
  t->c_cflag &= ~(CSIZE | PARENB);
  t->c_cflag |= CS8;
  t->c_cc[VMIN] = 1;
  t->c_cc[VTIME] = 0;
}

static inline speed_t cfgetispeed(const struct termios *t) { return t->c_ispeed; }
static inline speed_t cfgetospeed(const struct termios *t) { return t->c_ospeed; }
static inline int cfsetispeed(struct termios *t, speed_t s) { t->c_ispeed = s; return 0; }
static inline int cfsetospeed(struct termios *t, speed_t s) { t->c_ospeed = s; return 0; }
  `,
  "sys/ioctl.h": `
#pragma once

#define TIOCGWINSZ 0x5413

struct winsize {
  unsigned short ws_row;
  unsigned short ws_col;
  unsigned short ws_xpixel;
  unsigned short ws_ypixel;
};

__import int __ioctl_tiocgwinsz(int fd, int *rows, int *cols);

static inline int ioctl(int fd, unsigned long request, void *arg) {
  if (request == TIOCGWINSZ) {
    struct winsize *ws = (struct winsize *)arg;
    int rows, cols;
    int r = __ioctl_tiocgwinsz(fd, &rows, &cols);
    if (r == 0) {
      ws->ws_row = (unsigned short)rows;
      ws->ws_col = (unsigned short)cols;
      ws->ws_xpixel = 0;
      ws->ws_ypixel = 0;
    }
    return r;
  }
  return -1;
}
  `,
  "guc.h": `
#ifndef _GUC_H
#define _GUC_H

__require_source("__guc.c");

__import("c", "__jsstr")
__externref __jsstr(const char *s);

__import("c", "__jsstr2")
__externref __jsstr2(const char *s, int len);

__import("c", "__jsgetattr")
__externref __jsgetattr(__externref obj, __externref key);

__import("c", "__jslog")
void __jslog(__externref val);

__import("c", "__jsglobal")
__externref __jsglobal(void);

__import("c", "__jsstr_utf8len")
int __jsstr_utf8len(__externref s);

__import("c", "__jsstr_read")
int __jsstr_read(__externref s, char *buf, int maxlen, int *written);

__import("wasm:js-string", "length")
int __wjs_length(__externref s);

__import("wasm:js-string", "charCodeAt")
int __wjs_charCodeAt(__externref s, int idx);

__import("wasm:js-string", "codePointAt")
int __wjs_codePointAt(__externref s, int idx);

__import("wasm:js-string", "equals")
int __wjs_equals(__externref a, __externref b);

__import("wasm:js-string", "compare")
int __wjs_compare(__externref a, __externref b);

__import("wasm:js-string", "concat")
__refextern __wjs_concat(__externref a, __externref b);

__import("wasm:js-string", "substring")
__refextern __wjs_substring(__externref s, int start, int end);

__import("wasm:js-string", "fromCharCode")
__refextern __wjs_fromCharCode(int code);

__import("wasm:js-string", "fromCodePoint")
__refextern __wjs_fromCodePoint(int codePoint);

__import("wasm:js-string", "test")
int __wjs_test(__externref val);

__import("wasm:js-string", "cast")
__refextern __wjs_cast(__externref val);

__externref __jss(const char *s);

#endif
  `,
};

// Embedded standard library sources
const _stdlibSources = {
  "__guc.c": `
#include <string.h>
#include <guc.h>

__externref __jss(const char *s) {
    return __jsstr2(s, (int)strlen(s));
}
  `,
  "__SDL.c": `
#include <SDL.h>
#include <stdlib.h>
#include <string.h>

/* Opaque to user code (only the forward declaration is in SDL.h).
   'handle' is a 1-based index into the host's sdlWindows array.
   We reuse it as the SDL window ID (SDL_GetWindowID returns it,
   and event windowID fields carry it). This is fine because we
   control the entire stack — the real @kmamal/sdl window ID
   never leaks to C code. */
struct SDL_Window {
    int handle;
    SDL_Surface surface;
};

/* Low-level host imports — all operate on primitive values only.
   The host (host.js) knows nothing about C struct layouts. */
__import int __sdl_init(int flags);
__import void __sdl_quit(void);
__import int __sdl_create_window(const char *title, int x, int y, int w, int h, int flags);
__import void __sdl_destroy_window(int handle);
__import void __sdl_set_window_title(int handle, const char *title);
__import int __sdl_update_window_surface(int handle, const void *pixels, int w, int h, int pitch);
__import void __sdl_delay(int ms);
__import int __sdl_get_ticks(void);
__import void __sdl_set_animation_frame_func(void (*callback)(void));
__import int __sdl_open_audio_device(int freq, int format, int channels);
__import int __sdl_queue_audio(int dev, const void *data, int len);
__import int __sdl_get_queued_audio_size(int dev);
__import void __sdl_clear_queued_audio(int dev);
__import void __sdl_pause_audio_device(int dev, int pause_on);
__import void __sdl_close_audio_device(int dev);

int SDL_Init(Uint32 flags) {
    return __sdl_init((int)flags);
}

SDL_Window *SDL_CreateWindow(const char *title, int x, int y, int w, int h, Uint32 flags) {
    int handle = __sdl_create_window(title, x, y, w, h, (int)flags);
    int pitch = w * 4;
    SDL_Window *win = (SDL_Window *)malloc(sizeof(SDL_Window));
    win->handle = handle;
    win->surface.w = w;
    win->surface.h = h;
    win->surface.pitch = pitch;
    win->surface.pixels = malloc(pitch * h);
    memset(win->surface.pixels, 0, pitch * h);
    return win;
}

Uint32 SDL_GetWindowID(SDL_Window *window) {
    return (Uint32)window->handle;
}

SDL_Surface *SDL_GetWindowSurface(SDL_Window *window) {
    return &window->surface;
}

int SDL_UpdateWindowSurface(SDL_Window *window) {
    SDL_Surface *s = &window->surface;
    return __sdl_update_window_surface(window->handle, s->pixels, s->w, s->h, s->pitch);
}

/* ---- Event queue (freelist-based linked list) ---- */

typedef struct __SDL_EventEntry {
    SDL_Event event;
    struct __SDL_EventEntry *next;
} __SDL_EventEntry;

static __SDL_EventEntry *__sdl_eq_head;
static __SDL_EventEntry *__sdl_eq_tail;
static __SDL_EventEntry *__sdl_eq_free;

static __SDL_EventEntry *__sdl_eq_alloc(void) {
    __SDL_EventEntry *e = __sdl_eq_free;
    if (e) {
        __sdl_eq_free = e->next;
    } else {
        e = (__SDL_EventEntry *)malloc(sizeof(__SDL_EventEntry));
    }
    e->next = 0;
    return e;
}

static void __sdl_eq_push(__SDL_EventEntry *e) {
    if (__sdl_eq_tail) {
        __sdl_eq_tail->next = e;
    } else {
        __sdl_eq_head = e;
    }
    __sdl_eq_tail = e;
}

void __sdl_push_quit_event(int window_id) {
    __SDL_EventEntry *e = __sdl_eq_alloc();
    memset(&e->event, 0, sizeof(SDL_Event));
    e->event.type = SDL_QUIT;
    __sdl_eq_push(e);
}
__export __sdl_push_quit_event = __sdl_push_quit_event;

void __sdl_push_key_event(int window_id, int type, int scancode, int sym) {
    __SDL_EventEntry *e = __sdl_eq_alloc();
    memset(&e->event, 0, sizeof(SDL_Event));
    e->event.type = (Uint32)type;
    e->event.key.windowID = (Uint32)window_id;
    e->event.key.state = (type == SDL_KEYDOWN) ? SDL_PRESSED : SDL_RELEASED;
    e->event.key.keysym.scancode = scancode;
    e->event.key.keysym.sym = sym;
    __sdl_eq_push(e);
}
__export __sdl_push_key_event = __sdl_push_key_event;

void __sdl_push_mouse_button_event(int window_id, int type, int button, int x, int y) {
    __SDL_EventEntry *e = __sdl_eq_alloc();
    memset(&e->event, 0, sizeof(SDL_Event));
    e->event.type = (Uint32)type;
    e->event.button.windowID = (Uint32)window_id;
    e->event.button.button = (Uint8)button;
    e->event.button.state = (type == SDL_MOUSEBUTTONDOWN) ? SDL_PRESSED : SDL_RELEASED;
    e->event.button.x = x;
    e->event.button.y = y;
    __sdl_eq_push(e);
}
__export __sdl_push_mouse_button_event = __sdl_push_mouse_button_event;

void __sdl_push_mouse_motion_event(int window_id, int x, int y) {
    __SDL_EventEntry *e = __sdl_eq_alloc();
    memset(&e->event, 0, sizeof(SDL_Event));
    e->event.type = SDL_MOUSEMOTION;
    e->event.motion.windowID = (Uint32)window_id;
    e->event.motion.x = x;
    e->event.motion.y = y;
    __sdl_eq_push(e);
}
__export __sdl_push_mouse_motion_event = __sdl_push_mouse_motion_event;

void __sdl_push_mouse_wheel_event(int window_id, int x, int y) {
    __SDL_EventEntry *e = __sdl_eq_alloc();
    memset(&e->event, 0, sizeof(SDL_Event));
    e->event.type = SDL_MOUSEWHEEL;
    e->event.wheel.windowID = (Uint32)window_id;
    e->event.wheel.x = x;
    e->event.wheel.y = y;
    __sdl_eq_push(e);
}
__export __sdl_push_mouse_wheel_event = __sdl_push_mouse_wheel_event;

int SDL_PollEvent(SDL_Event *event) {
    __SDL_EventEntry *e = __sdl_eq_head;
    if (!e) return 0;
    __sdl_eq_head = e->next;
    if (!__sdl_eq_head) __sdl_eq_tail = 0;
    *event = e->event;
    e->next = __sdl_eq_free;
    __sdl_eq_free = e;
    return 1;
}

/* ---- Audio ---- */

SDL_AudioDeviceID SDL_OpenAudioDevice(const char *device, int iscapture,
                                      const SDL_AudioSpec *desired,
                                      SDL_AudioSpec *obtained, int allowed_changes) {
    int dev = __sdl_open_audio_device(desired->freq, desired->format, (int)desired->channels);
    if (dev <= 0) return 0;
    if (obtained) {
        obtained->freq = desired->freq;
        obtained->format = desired->format;
        obtained->channels = desired->channels;
    }
    return (SDL_AudioDeviceID)dev;
}

int SDL_QueueAudio(SDL_AudioDeviceID dev, const void *data, Uint32 len) {
    return __sdl_queue_audio((int)dev, data, (int)len);
}

Uint32 SDL_GetQueuedAudioSize(SDL_AudioDeviceID dev) {
    return (Uint32)__sdl_get_queued_audio_size((int)dev);
}

void SDL_ClearQueuedAudio(SDL_AudioDeviceID dev) {
    __sdl_clear_queued_audio((int)dev);
}

void SDL_PauseAudioDevice(SDL_AudioDeviceID dev, int pause_on) {
    __sdl_pause_audio_device((int)dev, pause_on);
}

void SDL_CloseAudioDevice(SDL_AudioDeviceID dev) {
    __sdl_close_audio_device((int)dev);
}

void SDL_DestroyWindow(SDL_Window *window) {
    __sdl_destroy_window(window->handle);
    free(window->surface.pixels);
    free(window);
}

void SDL_Quit(void) {
    __sdl_quit();
}

void SDL_Delay(Uint32 ms) {
    __sdl_delay((int)ms);
}

Uint32 SDL_GetTicks(void) {
    return (Uint32)__sdl_get_ticks();
}

void SDL_SetWindowTitle(SDL_Window *window, const char *title) {
    __sdl_set_window_title(window->handle, title);
}

void __setAnimationFrameFunc(void (*callback)(void)) {
    __sdl_set_animation_frame_func(callback);
}
  `,
  "__alloca.c": `
void *alloca(long size) {
  return __builtin(alloca, size);
}
  `,
  "__setjmp.c": `
int __setjmp_id_counter;
  `,
  "__assert.c": `
#include <stdio.h>

void __assert_fail(const char *expr, const char *file, int line) {
  printf("Assertion failed: %s, file %s, line %d\\n", expr, file, line);
  __wasm(void, (), op 0);
}
  `,
  "__atexit.c": `
static void (*__atexit_funcs[32])(void);
static int __atexit_count = 0;

int atexit(void (*func)(void)) {
  if (__atexit_count >= 32) return -1;
  __atexit_funcs[__atexit_count++] = func;
  return 0;
}

void __run_atexits(void) {
  while (__atexit_count > 0)
    __atexit_funcs[--__atexit_count]();
}
__export __run_atexits = __run_atexits;
  `,
  "__ctype.c": `
int isdigit(int c) { return c >= '0' && c <= '9'; }
int islower(int c) { return c >= 'a' && c <= 'z'; }
int isupper(int c) { return c >= 'A' && c <= 'Z'; }
int isalpha(int c) { return islower(c) || isupper(c); }
int isalnum(int c) { return isalpha(c) || isdigit(c); }
int isblank(int c) { return c == ' ' || c == '\\t'; }
int iscntrl(int c) { return (c >= 0 && c < 32) || c == 127; }
int isprint(int c) { return c >= 32 && c <= 126; }
int isgraph(int c) { return c > 32 && c <= 126; }
int isspace(int c) {
  return c == ' ' || c == '\\t' || c == '\\n' ||
       c == '\\r' || c == '\\f' || c == '\\v';
}
int ispunct(int c) { return isgraph(c) && !isalnum(c); }
int isxdigit(int c) {
  return isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
int tolower(int c) { return isupper(c) ? c + ('a' - 'A') : c; }
int toupper(int c) { return islower(c) ? c + ('A' - 'a') : c; }
  `,
  "__wchar.c": `
#include <stddef.h>

/* --- wctype functions (ASCII baseline) --- */
int iswalpha(unsigned int c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
int iswupper(unsigned int c) { return c >= 'A' && c <= 'Z'; }
int iswlower(unsigned int c) { return c >= 'a' && c <= 'z'; }
int iswdigit(unsigned int c) { return c >= '0' && c <= '9'; }
int iswalnum(unsigned int c) { return iswalpha(c) || iswdigit(c); }
int iswblank(unsigned int c) { return c == ' ' || c == '\\t'; }
int iswspace(unsigned int c) {
  return c == ' ' || c == '\\t' || c == '\\n' ||
         c == '\\r' || c == '\\f' || c == '\\v';
}
int iswcntrl(unsigned int c) { return (c < 32) || c == 127; }
int iswprint(unsigned int c) { return c >= 32 && c <= 126; }
int iswgraph(unsigned int c) { return c > 32 && c <= 126; }
int iswpunct(unsigned int c) { return iswgraph(c) && !iswalnum(c); }
int iswxdigit(unsigned int c) {
  return iswdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
unsigned int towlower(unsigned int c) { return iswupper(c) ? c + ('a' - 'A') : c; }
unsigned int towupper(unsigned int c) { return iswlower(c) ? c + ('A' - 'a') : c; }

/* --- wchar string functions --- */
size_t wcslen(const wchar_t *s) {
  size_t len = 0;
  while (s[len]) len++;
  return len;
}
wchar_t *wcscpy(wchar_t *dest, const wchar_t *src) {
  size_t i = 0;
  while (src[i]) { dest[i] = src[i]; i++; }
  dest[i] = 0;
  return dest;
}
wchar_t *wcsncpy(wchar_t *dest, const wchar_t *src, size_t n) {
  size_t i = 0;
  while (i < n && src[i]) { dest[i] = src[i]; i++; }
  while (i < n) { dest[i] = 0; i++; }
  return dest;
}
int wcscmp(const wchar_t *s1, const wchar_t *s2) {
  while (*s1 && *s1 == *s2) { s1++; s2++; }
  return *s1 - *s2;
}
int wcsncmp(const wchar_t *s1, const wchar_t *s2, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s1[i] != s2[i] || !s1[i]) return s1[i] - s2[i];
  }
  return 0;
}
wchar_t *wcscat(wchar_t *dest, const wchar_t *src) {
  wchar_t *p = dest;
  while (*p) p++;
  while (*src) { *p = *src; p++; src++; }
  *p = 0;
  return dest;
}
wchar_t *wcsncat(wchar_t *dest, const wchar_t *src, size_t n) {
  wchar_t *p = dest;
  while (*p) p++;
  while (n-- && *src) { *p++ = *src++; }
  *p = 0;
  return dest;
}
wchar_t *wcschr(const wchar_t *s, wchar_t c) {
  while (*s) {
    if (*s == c) return (wchar_t *)s;
    s++;
  }
  if (c == 0) return (wchar_t *)s;
  return (wchar_t *)0;
}
wchar_t *wcsrchr(const wchar_t *s, wchar_t c) {
  const wchar_t *last = (const wchar_t *)0;
  while (*s) {
    if (*s == c) last = s;
    s++;
  }
  if (c == 0) return (wchar_t *)s;
  return (wchar_t *)last;
}
wchar_t *wcsstr(const wchar_t *haystack, const wchar_t *needle) {
  if (!*needle) return (wchar_t *)haystack;
  while (*haystack) {
    const wchar_t *h = haystack;
    const wchar_t *n = needle;
    while (*h && *n && *h == *n) { h++; n++; }
    if (!*n) return (wchar_t *)haystack;
    haystack++;
  }
  return (wchar_t *)0;
}
size_t wcsspn(const wchar_t *s, const wchar_t *accept) {
  size_t count = 0;
  while (*s) {
    const wchar_t *a = accept;
    int found = 0;
    while (*a) { if (*s == *a) { found = 1; break; } a++; }
    if (!found) break;
    s++; count++;
  }
  return count;
}
size_t wcscspn(const wchar_t *s, const wchar_t *reject) {
  size_t count = 0;
  while (*s) {
    const wchar_t *r = reject;
    while (*r) { if (*s == *r) return count; r++; }
    s++; count++;
  }
  return count;
}
wchar_t *wcspbrk(const wchar_t *s, const wchar_t *accept) {
  while (*s) {
    const wchar_t *a = accept;
    while (*a) { if (*s == *a) return (wchar_t *)s; a++; }
    s++;
  }
  return (wchar_t *)0;
}
wchar_t *wcstok(wchar_t *str, const wchar_t *delim, wchar_t **saveptr) {
  if (str) *saveptr = str;
  if (!*saveptr) return (wchar_t *)0;
  *saveptr += wcsspn(*saveptr, delim);
  if (!**saveptr) { *saveptr = (wchar_t *)0; return (wchar_t *)0; }
  wchar_t *tok = *saveptr;
  *saveptr += wcscspn(*saveptr, delim);
  if (**saveptr) { **saveptr = 0; (*saveptr)++; }
  else { *saveptr = (wchar_t *)0; }
  return tok;
}
int wcscoll(const wchar_t *s1, const wchar_t *s2) { return wcscmp(s1, s2); }
size_t wcsxfrm(wchar_t *dest, const wchar_t *src, size_t n) {
  size_t len = wcslen(src);
  if (n > 0) {
    size_t copy = len < n ? len : n - 1;
    for (size_t i = 0; i < copy; i++) dest[i] = src[i];
    dest[copy] = 0;
  }
  return len;
}

/* --- wmem functions --- */
wchar_t *wmemcpy(wchar_t *dest, const wchar_t *src, size_t n) {
  for (size_t i = 0; i < n; i++) dest[i] = src[i];
  return dest;
}
wchar_t *wmemmove(wchar_t *dest, const wchar_t *src, size_t n) {
  if (dest < src) { for (size_t i = 0; i < n; i++) dest[i] = src[i]; }
  else { for (size_t i = n; i > 0; i--) dest[i-1] = src[i-1]; }
  return dest;
}
wchar_t *wmemset(wchar_t *dest, wchar_t c, size_t n) {
  for (size_t i = 0; i < n; i++) dest[i] = c;
  return dest;
}
int wmemcmp(const wchar_t *s1, const wchar_t *s2, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s1[i] != s2[i]) return s1[i] - s2[i];
  }
  return 0;
}
wchar_t *wmemchr(const wchar_t *s, wchar_t c, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s[i] == c) return (wchar_t *)(s + i);
  }
  return (wchar_t *)0;
}

/* --- multibyte/wide conversions (UTF-8) --- */
#include <wchar.h>
unsigned int btowc(int c) { return (c >= 0 && c <= 0x7F) ? (unsigned int)c : (unsigned int)-1; }
int wctob(unsigned int c) { return (c <= 0x7F) ? (int)c : -1; }
int mbsinit(const mbstate_t *ps) { (void)ps; return 1; }

size_t wcrtomb(char *s, wchar_t wc, mbstate_t *ps) {
  (void)ps;
  unsigned int c = (unsigned int)wc;
  if (!s) return 1;
  if (c < 0x80) { s[0] = (char)c; return 1; }
  if (c < 0x800) { s[0] = (char)(0xC0 | (c >> 6)); s[1] = (char)(0x80 | (c & 0x3F)); return 2; }
  if (c < 0x10000) { s[0] = (char)(0xE0 | (c >> 12)); s[1] = (char)(0x80 | ((c >> 6) & 0x3F)); s[2] = (char)(0x80 | (c & 0x3F)); return 3; }
  if (c < 0x110000) { s[0] = (char)(0xF0 | (c >> 18)); s[1] = (char)(0x80 | ((c >> 12) & 0x3F)); s[2] = (char)(0x80 | ((c >> 6) & 0x3F)); s[3] = (char)(0x80 | (c & 0x3F)); return 4; }
  return (size_t)-1;
}

size_t mbrtowc(wchar_t *pwc, const char *s, size_t n, mbstate_t *ps) {
  (void)ps;
  if (!s) return 0;
  if (n == 0) return (size_t)-2;
  unsigned char b0 = (unsigned char)s[0];
  if (b0 < 0x80) {
    if (pwc) *pwc = b0;
    return b0 ? 1 : 0;
  }
  unsigned int cp; size_t len;
  if ((b0 & 0xE0) == 0xC0)      { cp = b0 & 0x1F; len = 2; }
  else if ((b0 & 0xF0) == 0xE0) { cp = b0 & 0x0F; len = 3; }
  else if ((b0 & 0xF8) == 0xF0) { cp = b0 & 0x07; len = 4; }
  else return (size_t)-1;
  if (len > n) return (size_t)-2;
  for (size_t i = 1; i < len; i++) {
    unsigned char bi = (unsigned char)s[i];
    if ((bi & 0xC0) != 0x80) return (size_t)-1;
    cp = (cp << 6) | (bi & 0x3F);
  }
  if (pwc) *pwc = (wchar_t)cp;
  return cp ? len : 0;
}
  `,
  "__dirent.c": `
#include <dirent.h>
#include <stdlib.h>

__import int __opendir(const char *name);
__import int __readdir(int handle, void *dirent_buf);
__import int __closedir(int handle);

struct __DIR {
  int fd;
  struct dirent ent;
};

DIR *opendir(const char *name) {
  int handle = __opendir(name);
  if (handle < 0) return (DIR *)0;
  DIR *dirp = (DIR *)malloc(sizeof(DIR));
  if (!dirp) return (DIR *)0;
  dirp->fd = handle;
  return dirp;
}

int closedir(DIR *dirp) {
  if (!dirp) return -1;
  int ret = __closedir(dirp->fd);
  free(dirp);
  return ret;
}

struct dirent *readdir(DIR *dirp) {
  if (!dirp) return (struct dirent *)0;
  int result = __readdir(dirp->fd, &dirp->ent);
  if (result < 0) return (struct dirent *)0;
  return &dirp->ent;
}
  `,
  "__emscripten.c": `
#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
__import void __sdl_set_animation_frame_func(void (*callback)(void));
__import void __emscripten_async_call(void (*func)(void *), void *arg, int millis);
__import float __emscripten_random(void);

void emscripten_set_main_loop(void (*func)(void), int fps, int simulate_infinite_loop) {
  if (fps != 0) {
    printf("emscripten_set_main_loop: unsupported fps=%d (only 0 is supported)\\n", fps);
    exit(1);
  }
  (void)simulate_infinite_loop;
  __sdl_set_animation_frame_func(func);
}

void emscripten_async_call(void (*func)(void *), void *arg, int millis) {
  __emscripten_async_call(func, arg, millis);
}

float emscripten_random(void) {
  return __emscripten_random();
}
  `,
  "__errno.c": `
int errno;
void __errno_set(int e) { errno = e; }
__export __errno_set = __errno_set;
  `,
  "__getopt.c": `
#include <getopt.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

char *optarg = (void *)0;
int optind = 1;
int opterr = 1;
int optopt = 0;

// Position within the current argv[optind] (0 means we haven't started
// scanning the current arg, so the next call will look at optind fresh).
static int __optpos = 0;

// Skip GNU-mode prefix flags ('+'/'-') and detect the silent ':' flag.
static const char *__skip_modifiers(const char *s, int *silent) {
  if (*s == '+' || *s == '-') s++;
  if (*s == ':') { *silent = 1; s++; }
  return s;
}

// Find character c in optstring (after modifiers stripped).
// Returns pointer to the matching char, or NULL if not found.
static const char *__find_short(int c, const char *optstring) {
  if (c == ':' || c == '?' || c == '\\0') return (void *)0;
  for (const char *p = optstring; *p; p++) {
    if (*p == c) return p;
  }
  return (void *)0;
}

// Strip leading directory components from argv[0] for diagnostic output.
static const char *__progname(int argc, char *const argv[]) {
  if (argc <= 0 || !argv[0]) return "?";
  const char *s = argv[0];
  const char *base = s;
  while (*s) {
    if (*s == '/') base = s + 1;
    s++;
  }
  return base;
}

int getopt(int argc, char *const argv[], const char *optstring) {
  // POSIX/glibc convention: optind == 0 requests a reset of internal state.
  if (optind == 0) { optind = 1; __optpos = 0; }

  optarg = (void *)0;
  int silent = 0;
  const char *opts = __skip_modifiers(optstring, &silent);

  if (__optpos == 0) {
    if (optind >= argc) return -1;
    const char *arg = argv[optind];
    if (!arg || arg[0] != '-' || arg[1] == 0) return -1;
    if (arg[1] == '-' && arg[2] == 0) {
      // "--" terminator: consume and stop option processing
      optind++;
      return -1;
    }
    __optpos = 1;  // skip the leading '-'
  }

  const char *arg = argv[optind];
  int c = (unsigned char)arg[__optpos];
  __optpos++;
  int reached_end = (arg[__optpos] == 0);

  const char *match = __find_short(c, opts);

  if (!match) {
    if (reached_end) { optind++; __optpos = 0; }
    if (opterr && !silent) {
      fprintf(stderr, "%s: invalid option -- '%c'\\n", __progname(argc, argv), c);
    }
    optopt = c;
    return '?';
  }

  if (match[1] != ':') {
    // No argument
    if (reached_end) { optind++; __optpos = 0; }
    return c;
  }

  // Has an argument (required if "x:", optional if "x::")
  int optional = (match[2] == ':');

  if (!reached_end) {
    optarg = (char *)&arg[__optpos];
    optind++;
    __optpos = 0;
    return c;
  }

  // Argument is in the next argv element (or missing)
  __optpos = 0;
  optind++;

  if (optional) return c;  // optional and not given

  if (optind >= argc) {
    if (opterr && !silent) {
      fprintf(stderr, "%s: option requires an argument -- '%c'\\n", __progname(argc, argv), c);
    }
    optopt = c;
    return silent ? ':' : '?';
  }

  optarg = argv[optind++];
  return c;
}

// --- Long-option core (shared by getopt_long / getopt_long_only) -------

static int __getopt_long_core(int argc, char *const argv[], const char *optstring,
                              const struct option *longopts, int *longindex,
                              int allow_dash) {
  if (optind == 0) { optind = 1; __optpos = 0; }

  // Mid-arg short-option chain: continue scanning short.
  if (__optpos != 0) {
    return getopt(argc, argv, optstring);
  }

  if (optind >= argc) return -1;
  const char *arg = argv[optind];
  if (!arg || arg[0] != '-' || arg[1] == 0) return -1;

  // "--" terminator
  if (arg[1] == '-' && arg[2] == 0) {
    optind++;
    return -1;
  }

  int silent = 0;
  __skip_modifiers(optstring, &silent);

  // Determine where the long-option name starts.
  // "--name..." → always treated as long.
  // "-name..."  → treated as long only in long_only mode.
  const char *name;
  int double_dash = (arg[1] == '-');
  if (double_dash) {
    name = arg + 2;
  } else if (allow_dash) {
    name = arg + 1;
  } else {
    return getopt(argc, argv, optstring);
  }

  // Split out "=value" if present.
  const char *eq = strchr(name, '=');
  size_t namelen = eq ? (size_t)(eq - name) : strlen(name);

  // Match against longopts: prefer exact match, else unambiguous prefix.
  int match_idx = -1;
  int exact = 0;
  int ambig = 0;
  for (int i = 0; longopts[i].name; i++) {
    if (strncmp(longopts[i].name, name, namelen) == 0) {
      if (strlen(longopts[i].name) == namelen) {
        match_idx = i;
        exact = 1;
        ambig = 0;
        break;
      }
      if (match_idx == -1) match_idx = i;
      else ambig = 1;
    }
  }

  // In long-only mode, if no exact long match, fall back to short option
  // processing (so "-h" with optstring "h" works even if there's no long
  // option named "h").
  if (allow_dash && !double_dash && !exact) {
    return getopt(argc, argv, optstring);
  }

  if (ambig) {
    if (opterr && !silent) {
      fprintf(stderr, "%s: option '%s%.*s' is ambiguous\\n",
              __progname(argc, argv), double_dash ? "--" : "-", (int)namelen, name);
    }
    optind++;
    optopt = 0;
    return '?';
  }

  if (match_idx == -1) {
    if (opterr && !silent) {
      fprintf(stderr, "%s: unrecognized option '%s%s'\\n",
              __progname(argc, argv), double_dash ? "--" : "-", name);
    }
    optind++;
    optopt = 0;
    return '?';
  }

  const struct option *lo = &longopts[match_idx];
  if (longindex) *longindex = match_idx;

  optarg = (void *)0;

  if (lo->has_arg == required_argument || lo->has_arg == optional_argument) {
    if (eq) {
      optarg = (char *)(eq + 1);
      optind++;
    } else if (lo->has_arg == required_argument) {
      optind++;
      if (optind >= argc) {
        if (opterr && !silent) {
          fprintf(stderr, "%s: option '--%s' requires an argument\\n",
                  __progname(argc, argv), lo->name);
        }
        optopt = lo->val;
        return silent ? ':' : '?';
      }
      optarg = argv[optind++];
    } else {
      // optional_argument and not given
      optind++;
    }
  } else {
    // no_argument
    if (eq) {
      if (opterr && !silent) {
        fprintf(stderr, "%s: option '--%s' doesn't allow an argument\\n",
                __progname(argc, argv), lo->name);
      }
      optind++;
      optopt = lo->val;
      return '?';
    }
    optind++;
  }

  if (lo->flag) {
    *lo->flag = lo->val;
    return 0;
  }
  return lo->val;
}

int getopt_long(int argc, char *const argv[], const char *optstring,
                const struct option *longopts, int *longindex) {
  return __getopt_long_core(argc, argv, optstring, longopts, longindex, 0);
}

int getopt_long_only(int argc, char *const argv[], const char *optstring,
                     const struct option *longopts, int *longindex) {
  return __getopt_long_core(argc, argv, optstring, longopts, longindex, 1);
}
  `,
  "__signal.c": `
#include <signal.h>
__sighandler_t signal(int __sig, __sighandler_t __handler) { (void)__sig; (void)__handler; return SIG_DFL; }
int raise(int __sig) { (void)__sig; return 0; }
  `,
  "__locale.c": `
#include <locale.h>
#include <string.h>

static struct lconv __c_lconv = {
  ".",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  127,
  127,
  127,
  127,
  127,
  127,
  127,
  127,
};

char *setlocale(int category, const char *locale) {
  if (locale == 0) return "C";
  if (locale[0] == '\\0' || strcmp(locale, "C") == 0 || strcmp(locale, "POSIX") == 0)
    return "C";
  return 0;
}

struct lconv *localeconv(void) {
  return &__c_lconv;
}
  `,
  "__malloc.c": `
#include <__malloc.h>
#include <stdio.h>

// TLSF (Two-Level Segregated Fit) allocator
//
// Block layout (8-byte header):
//   +0: size_and_flags (long) - bits[31:3]=block size/8, bit0=FREE, bit1=PREV_FREE
//   +4: prev_phys (long) - address of previous physical block
// Free blocks additionally store at payload:
//   +8: next_free (long)
//   +12: prev_free (long)

#define FREE_BIT      1
#define PREV_FREE_BIT 2
#define FLAG_BITS     3

#define BLOCK_OVERHEAD  8
#define MIN_BLOCK_SIZE  16
#define BLOCK_ALIGN     8

#define SL_LOG2   4
#define SEARCH_ROUND(size) ((size) + (1 << (31 - __builtin_clz((int)(size)) - SL_LOG2)) - 1)
#define SL_COUNT  (1 << SL_LOG2)
#define FL_SHIFT  4
#define FL_MAX    30
#define FL_COUNT  (FL_MAX - FL_SHIFT + 1)

static long fl_bitmap;
static long sl_bitmap[FL_COUNT];
static long free_heads[FL_COUNT * SL_COUNT];
static long pool_start;
static long pool_end;
static long last_block;
static int  initialized;

static long block_size(long block) {
  return *(long *)block & ~FLAG_BITS;
}

static int block_is_free(long block) {
  return *(long *)block & FREE_BIT;
}

static int block_prev_is_free(long block) {
  return *(long *)block & PREV_FREE_BIT;
}

static long block_prev_phys(long block) {
  return *(long *)(block + 4);
}

static long block_next_phys(long block) {
  return block + block_size(block);
}

static long block_payload(long block) {
  return block + BLOCK_OVERHEAD;
}

static long payload_to_block(long payload) {
  return payload - BLOCK_OVERHEAD;
}

static long block_get_next_free(long block) {
  return *(long *)(block + 8);
}

static void block_set_next_free(long block, long nf) {
  *(long *)(block + 8) = nf;
}

static long block_get_prev_free(long block) {
  return *(long *)(block + 12);
}

static void block_set_prev_free(long block, long pf) {
  *(long *)(block + 12) = pf;
}

// mapping_insert: floor mapping for insertion
static void mapping_insert(long size, int *fl, int *sl) {
  if (size < (1 << (FL_SHIFT + 1))) {
    *fl = 0;
    *sl = (int)((size - MIN_BLOCK_SIZE) >> 3);
  } else {
    int t = 31 - __builtin_clz((int)size);
    *sl = (int)((size >> (t - SL_LOG2)) & (SL_COUNT - 1));
    *fl = t - FL_SHIFT;
  }
}

// mapping_search: ceiling mapping for search (rounds up)
static void mapping_search(long size, int *fl, int *sl) {
  long rounded = SEARCH_ROUND(size);
  mapping_insert(rounded, fl, sl);
}

static void insert_free_block(long block) {
  int fl, sl;
  long sz = block_size(block);
  mapping_insert(sz, &fl, &sl);

  long head = free_heads[fl * SL_COUNT + sl];
  block_set_next_free(block, head);
  block_set_prev_free(block, 0);
  if (head) block_set_prev_free(head, block);
  free_heads[fl * SL_COUNT + sl] = block;

  fl_bitmap = fl_bitmap | (1 << fl);
  sl_bitmap[fl] = sl_bitmap[fl] | (1 << sl);
}

static void remove_free_block(long block) {
  int fl, sl;
  long sz = block_size(block);
  mapping_insert(sz, &fl, &sl);

  long nf = block_get_next_free(block);
  long pf = block_get_prev_free(block);
  if (nf && block_get_prev_free(nf) != block) {
    puts("Corrupted heap: free list broken (next->prev != cur)");
    __wasm(void, (), op 0x00);
  }
  if (pf && block_get_next_free(pf) != block) {
    puts("Corrupted heap: free list broken (prev->next != cur)");
    __wasm(void, (), op 0x00);
  }
  if (nf) block_set_prev_free(nf, pf);
  if (pf) block_set_next_free(pf, nf);
  else {
    free_heads[fl * SL_COUNT + sl] = nf;
    if (!nf) {
      sl_bitmap[fl] = sl_bitmap[fl] & ~(1 << sl);
      if (!sl_bitmap[fl])
        fl_bitmap = fl_bitmap & ~(1 << fl);
    }
  }
}

static long find_suitable_block(int *fl, int *sl) {
  // Search current SL bitmap from sl upward
  long sl_map = sl_bitmap[*fl] & (~0L << *sl);
  if (!sl_map) {
    // Search FL bitmap from fl+1 upward
    long fl_map = fl_bitmap & (~0L << (*fl + 1));
    if (!fl_map) return 0;
    *fl = __builtin_ctz((int)fl_map);
    sl_map = sl_bitmap[*fl];
  }
  *sl = __builtin_ctz((int)sl_map);
  return free_heads[*fl * SL_COUNT + *sl];
}

static long merge_prev(long block) {
  if (block_prev_is_free(block)) {
    long prev = block_prev_phys(block);
    remove_free_block(prev);
    long new_size = block_size(prev) + block_size(block);
    *(long *)prev = (*(long *)prev & FLAG_BITS) | new_size;
    // Update prev_phys of next physical block
    long next = block_next_phys(prev);
    if (next < pool_end)
      *(long *)(next + 4) = prev;
    if (block == last_block)
      last_block = prev;
    block = prev;
  }
  return block;
}

static long merge_next(long block) {
  long next = block_next_phys(block);
  if (next < pool_end && block_is_free(next)) {
    remove_free_block(next);
    long new_size = block_size(block) + block_size(next);
    *(long *)block = (*(long *)block & FLAG_BITS) | new_size;
    // Update prev_phys of block after next
    long after = block_next_phys(block);
    if (after < pool_end)
      *(long *)(after + 4) = block;
    if (next == last_block)
      last_block = block;
  }
  return block;
}

static void split_block(long block, long needed) {
  long remainder_size = block_size(block) - needed;
  if (remainder_size >= MIN_BLOCK_SIZE) {
    // Resize current block
    *(long *)block = (*(long *)block & FLAG_BITS) | needed;
    // Create remainder block
    long rem = block + needed;
    *(long *)rem = remainder_size | FREE_BIT;
    *(long *)(rem + 4) = block;
    // Update next block's prev_phys
    long next = rem + remainder_size;
    if (next < pool_end)
      *(long *)(next + 4) = rem;
    if (block == last_block)
      last_block = rem;
    insert_free_block(rem);
    // Set PREV_FREE on successor
    next = block_next_phys(block);
    if (next < pool_end)
      *(long *)next = *(long *)next | PREV_FREE_BIT;
  }
}

static void block_mark_used(long block) {
  *(long *)block = *(long *)block & ~FREE_BIT;
  // Clear PREV_FREE on next physical block
  long next = block_next_phys(block);
  if (next < pool_end)
    *(long *)next = *(long *)next & ~PREV_FREE_BIT;
}

static void block_mark_free(long block) {
  *(long *)block = *(long *)block | FREE_BIT;
  // Set PREV_FREE on next physical block
  long next = block_next_phys(block);
  if (next < pool_end)
    *(long *)next = *(long *)next | PREV_FREE_BIT;
}

static void init_pool(void) {
  pool_start = __builtin(heap_base);
  // Align pool_start to BLOCK_ALIGN
  pool_start = (pool_start + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);
  pool_end = pool_start;
  last_block = 0;
  fl_bitmap = 0;
  int i = 0;
  while (i < FL_COUNT) { sl_bitmap[i] = 0; i = i + 1; }
  i = 0;
  while (i < FL_COUNT * SL_COUNT) { free_heads[i] = 0; i = i + 1; }
  initialized = 1;
}

static int grow_pool(long needed) {
  // needed includes BLOCK_OVERHEAD
  long new_end = pool_end + needed;
  // Align to page boundary for wasm memory.grow
  long pages = (new_end + 65535) / 65536;
  if (pages > __builtin(memory_size)) {
    long grow = pages - __builtin(memory_size);
    if (__builtin(memory_grow, grow) == (size_t)-1)
      return 0;
  }
  // Create a new block at pool_end
  long block = pool_end;
  long block_sz = new_end - pool_end;
  // Round up so mapping_search can find this block
  block_sz = SEARCH_ROUND(block_sz);
  // Round up to alignment
  block_sz = (block_sz + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);
  new_end = pool_end + block_sz;
  // Re-check pages after rounding
  pages = (new_end + 65535) / 65536;
  if (pages > __builtin(memory_size)) {
    long grow = pages - __builtin(memory_size);
    if (__builtin(memory_grow, grow) == (size_t)-1)
      return 0;
  }

  *(long *)block = block_sz | FREE_BIT;
  *(long *)(block + 4) = last_block;
  pool_end = new_end;

  // If last block is free, merge
  if (last_block && block_is_free(last_block)) {
    // Set prev_free bit so merge_prev works
    *(long *)block = *(long *)block | PREV_FREE_BIT;
    last_block = block;
    block = merge_prev(block);
  } else {
    last_block = block;
  }

  insert_free_block(block);
  return 1;
}

static long adjust_request(long size) {
  // Add overhead and ensure minimum size
  long adjusted = size + BLOCK_OVERHEAD;
  if (adjusted < MIN_BLOCK_SIZE) adjusted = MIN_BLOCK_SIZE;
  // Align up
  adjusted = (adjusted + BLOCK_ALIGN - 1) & ~(BLOCK_ALIGN - 1);
  return adjusted;
}

void *malloc(size_t size) {
  if (size == 0) return (void *)0;
  if (size > 0x40000000L) return (void *)0;

  if (!initialized) init_pool();

  long adjusted = adjust_request((long)size);

  int fl, sl;
  mapping_search(adjusted, &fl, &sl);
  if (fl >= FL_COUNT) {
    // Too large even for search
    if (!grow_pool(adjusted)) return (void *)0;
    mapping_search(adjusted, &fl, &sl);
  }

  long block = find_suitable_block(&fl, &sl);
  if (!block) {
    if (!grow_pool(adjusted)) return (void *)0;
    mapping_search(adjusted, &fl, &sl);
    block = find_suitable_block(&fl, &sl);
    if (!block) return (void *)0;
  }

  remove_free_block(block);
  split_block(block, adjusted);
  block_mark_used(block);

  return (void *)block_payload(block);
}

void free(void *ptr) {
  if (!ptr) return;

  long block = payload_to_block((long)ptr);

  // Bounds check
  if (block < pool_start || block >= pool_end) {
    puts("free: double free detected");
    __wasm(void, (), op 0x00);
  }
  // Double-free detection: block must not already be free
  if (block_is_free(block)) {
    puts("free: double free detected");
    __wasm(void, (), op 0x00);
  }

  block_mark_free(block);
  block = merge_prev(block);
  block = merge_next(block);
  insert_free_block(block);
}

void *calloc(size_t count, size_t size) {
  if (size != 0 && count > 0x40000000L / size) return (void *)0;
  size_t total = count * size;
  void *p = malloc(total);
  if (p) __builtin(memory_fill, p, 0, total);
  return p;
}

void *realloc(void *ptr, size_t new_size) {
  if (!ptr) return malloc(new_size);
  if (new_size == 0) { free(ptr); return (void *)0; }

  long block = payload_to_block((long)ptr);
  long old_payload = block_size(block) - BLOCK_OVERHEAD;

  // If new size fits in current block, keep it
  if (new_size <= (size_t)old_payload) return ptr;

  // Allocate new, copy, free old
  void *new_ptr = malloc(new_size);
  if (!new_ptr) return (void *)0;
  __builtin(memory_copy, new_ptr, ptr, old_payload);
  free(ptr);
  return new_ptr;
}

void *aligned_alloc(size_t alignment, size_t size) {
  // C11 7.22.3.1: alignment must be a supported alignment, size a multiple of alignment
  if (alignment == 0 || (alignment & (alignment - 1)) != 0) return (void *)0;
  if (size % alignment != 0) return (void *)0;
  // TLSF malloc returns 8-byte aligned memory (BLOCK_ALIGN == 8).
  // Alignments up to 8 are satisfied directly. Larger extended alignments are
  // not supported (the compiler rejects _Alignas > max_align_t == 8).
  if (alignment > 8) return (void *)0;
  return malloc(size);
}

void __inspect_heap(struct __heap_info *info) {
  if (!initialized) init_pool();
  info->heap_start = pool_start;
  info->heap_end = pool_end;
  info->total_bytes = pool_end - pool_start;
  long fb = 0;
  long fby = 0;
  long lf = 0;
  int f = 0;
  while (f < FL_COUNT) {
    int s = 0;
    while (s < SL_COUNT) {
      long b = free_heads[f * SL_COUNT + s];
      while (b) {
        long sz = block_size(b) - BLOCK_OVERHEAD;
        fb = fb + 1;
        fby = fby + sz;
        if (sz > lf) lf = sz;
        b = block_get_next_free(b);
      }
      s = s + 1;
    }
    f = f + 1;
  }
  info->free_blocks = fb;
  info->free_bytes = fby;
  info->largest_free = lf;
}
  `,
  "__math.c": `
#include <math.h>

// Unary f64 (double)
double fabs(double x) { return __wasm(double, (x), op 0x99); }
double ceil(double x) { return __wasm(double, (x), op 0x9B); }
double floor(double x) { return __wasm(double, (x), op 0x9C); }
double trunc(double x) { return __wasm(double, (x), op 0x9D); }
double nearbyint(double x) { return __wasm(double, (x), op 0x9E); }
double rint(double x) { return __wasm(double, (x), op 0x9E); }
double sqrt(double x) { return __wasm(double, (x), op 0x9F); }

// Unary f32 (float)
float fabsf(float x) { return __wasm(float, (x), op 0x8B); }
float ceilf(float x) { return __wasm(float, (x), op 0x8D); }
float floorf(float x) { return __wasm(float, (x), op 0x8E); }
float truncf(float x) { return __wasm(float, (x), op 0x8F); }
float nearbyintf(float x) { return __wasm(float, (x), op 0x90); }
float rintf(float x) { return __wasm(float, (x), op 0x90); }
float sqrtf(float x) { return __wasm(float, (x), op 0x91); }

// Binary f64 (double)
double fmin(double x, double y) { return __wasm(double, (x, y), op 0xA4); }
double fmax(double x, double y) { return __wasm(double, (x, y), op 0xA5); }
double copysign(double x, double y) { return __wasm(double, (x, y), op 0xA6); }

// Binary f32 (float)
float fminf(float x, float y) { return __wasm(float, (x, y), op 0x96); }
float fmaxf(float x, float y) { return __wasm(float, (x, y), op 0x97); }
float copysignf(float x, float y) { return __wasm(float, (x, y), op 0x98); }

// Float wrappers for host-imported functions
float sinf(float x) { return (float)sin((double)x); }
float cosf(float x) { return (float)cos((double)x); }
float tanf(float x) { return (float)tan((double)x); }
float asinf(float x) { return (float)asin((double)x); }
float acosf(float x) { return (float)acos((double)x); }
float atanf(float x) { return (float)atan((double)x); }
float atan2f(float y, float x) { return (float)atan2((double)y, (double)x); }
float sinhf(float x) { return (float)sinh((double)x); }
float coshf(float x) { return (float)cosh((double)x); }
float tanhf(float x) { return (float)tanh((double)x); }
float asinhf(float x) { return (float)asinh((double)x); }
float acoshf(float x) { return (float)acosh((double)x); }
float atanhf(float x) { return (float)atanh((double)x); }
float expf(float x) { return (float)exp((double)x); }
float expm1f(float x) { return (float)expm1((double)x); }
float logf(float x) { return (float)log((double)x); }
float log2f(float x) { return (float)log2((double)x); }
float log10f(float x) { return (float)log10((double)x); }
float log1pf(float x) { return (float)log1p((double)x); }
float powf(float x, float y) { return (float)pow((double)x, (double)y); }
float cbrtf(float x) { return (float)cbrt((double)x); }
float hypotf(float x, float y) { return (float)hypot((double)x, (double)y); }
float fmodf(float x, float y) { return (float)fmod((double)x, (double)y); }

// round: ties away from zero
double round(double x) {
  double t = trunc(x);
  if (fabs(x - t) >= 0.5) return t + copysign(1.0, x);
  return t;
}
float roundf(float x) {
  float t = truncf(x);
  if (fabsf(x - t) >= 0.5f) return t + copysignf(1.0f, x);
  return t;
}

double fdim(double x, double y) { return x > y ? x - y : 0.0; }
float fdimf(float x, float y) { return x > y ? x - y : 0.0f; }

long lround(double x) { return (long)round(x); }
long lrint(double x) { return (long)rint(x); }
long lroundf(float x) { return (long)roundf(x); }
long lrintf(float x) { return (long)rintf(x); }

// nextafter: return next representable value from x toward y
// IEEE 754 doubles have the property that consecutive values have
// consecutive bit patterns (within the same sign), so +-1 on the
// reinterpreted integer gives the adjacent double.
double nextafter(double x, double y) {
  if (x != x || y != y) return x + y;
  if (x == y) return y;
  long long bits = __wasm(long long, (x), op 0xBD);
  if (x == 0.0) {
    bits = 1LL;
    double tiny = __wasm(double, (bits), op 0xBF);
    return copysign(tiny, y);
  }
  if ((x < y) == (x > 0.0)) bits++;
  else bits--;
  return __wasm(double, (bits), op 0xBF);
}
float nextafterf(float x, float y) {
  if (x != x || y != y) return x + y;
  if (x == y) return y;
  int bits = __wasm(int, (x), op 0xBC);
  if (x == 0.0f) {
    bits = 1;
    float tiny = __wasm(float, (bits), op 0xBE);
    return copysignf(tiny, y);
  }
  if ((x < y) == (x > 0.0f)) bits++;
  else bits--;
  return __wasm(float, (bits), op 0xBE);
}

// frexp: split x into normalized fraction [0.5, 1) and exponent
double frexp(double x, int *exp) {
  long long bits = __wasm(long long, (x), op 0xBD);
  long long emask = (long long)0x7FF << 52;
  int e = (int)((bits >> 52) & 0x7FF);
  if (e == 0) {
    if (x == 0.0) { *exp = 0; return x; }
    // Subnormal: multiply by 2^52 to normalize
    x = x * 4503599627370496.0;
    bits = __wasm(long long, (x), op 0xBD);
    e = (int)((bits >> 52) & 0x7FF);
    e = e - 52;
  } else if (e == 0x7FF) {
    *exp = 0;
    return x;
  }
  *exp = e - 1022;
  bits = (bits & ~emask) | ((long long)0x3FE << 52);
  return __wasm(double, (bits), op 0xBF);
}

// ldexp: multiply x by 2^n
// Uses repeated scaling to handle the full range of n without
// overflowing intermediate exponent calculations.
// Special cases (zero, inf, NaN) are handled naturally by multiplication.
double ldexp(double x, int n) {
  if (n > 1023) {
    x *= 8.98846567431158e307;  // 2^1023
    n -= 1023;
    if (n > 1023) {
      x *= 8.98846567431158e307;
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    x *= 2.2250738585072014e-308;  // 2^-1022
    n += 1022;
    if (n < -1022) {
      x *= 2.2250738585072014e-308;
      n += 1022;
      if (n < -1022) n = -1022;
    }
  }
  long long scale_bits = (long long)(n + 1023) << 52;
  double scale = __wasm(double, (scale_bits), op 0xBF);
  return x * scale;
}

float ldexpf(float x, int n) { return (float)ldexp((double)x, n); }

// ilogb: extract unbiased exponent as int
int ilogb(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  int e = (int)((bits >> 52) & 0x7FF);
  if (e == 0) {
    if (x == 0.0) return -2147483647 - 1;
    x = fabs(x) * 4503599627370496.0;
    bits = __wasm(long long, (x), op 0xBD);
    e = (int)((bits >> 52) & 0x7FF);
    return e - 1023 - 52;
  }
  if (e == 0x7FF) return 2147483647;
  return e - 1023;
}

// logb: extract exponent as double
double logb(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  int e = (int)((bits >> 52) & 0x7FF);
  if (e == 0) {
    if (x == 0.0) return -1.0 / 0.0;
    x = fabs(x) * 4503599627370496.0;
    bits = __wasm(long long, (x), op 0xBD);
    e = (int)((bits >> 52) & 0x7FF);
    return (double)(e - 1023 - 52);
  }
  if (e == 0x7FF) return x * x;
  return (double)(e - 1023);
}

double modf(double x, double *iptr) {
  *iptr = trunc(x);
  return x - *iptr;
}
float modff(float x, float *iptr) {
  *iptr = truncf(x);
  return x - *iptr;
}

double nan(const char *tag) { (void)tag; return NAN; }
float nanf(const char *tag) { (void)tag; return NAN; }

// IEEE 754 classification via bit inspection. The standard isnan/isinf
// etc. macros need underlying functions; we provide both float and
// double variants.
int __isnand(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  long long exp = (bits >> 52) & 0x7FFL;
  long long frac = bits & 0xFFFFFFFFFFFFFL;
  return exp == 0x7FF && frac != 0;
}
int __isinfd(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  long long exp = (bits >> 52) & 0x7FFL;
  long long frac = bits & 0xFFFFFFFFFFFFFL;
  return exp == 0x7FF && frac == 0;
}
int __isfinited(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  long long exp = (bits >> 52) & 0x7FFL;
  return exp != 0x7FF;
}
int __isnormald(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  long long exp = (bits >> 52) & 0x7FFL;
  return exp != 0 && exp != 0x7FF;
}
int __signbitd(double x) {
  long long bits = __wasm(long long, (x), op 0xBD);
  return (int)((bits >> 63) & 1L);
}
int __isnanf(float x) {
  int bits = __wasm(int, (x), op 0xBC);
  int exp = (bits >> 23) & 0xFF;
  int frac = bits & 0x7FFFFF;
  return exp == 0xFF && frac != 0;
}
int __isinff(float x) {
  int bits = __wasm(int, (x), op 0xBC);
  int exp = (bits >> 23) & 0xFF;
  int frac = bits & 0x7FFFFF;
  return exp == 0xFF && frac == 0;
}
int __isfinitef(float x) {
  int bits = __wasm(int, (x), op 0xBC);
  int exp = (bits >> 23) & 0xFF;
  return exp != 0xFF;
}
int __isnormalf(float x) {
  int bits = __wasm(int, (x), op 0xBC);
  int exp = (bits >> 23) & 0xFF;
  return exp != 0 && exp != 0xFF;
}
int __signbitf(float x) {
  int bits = __wasm(int, (x), op 0xBC);
  return (bits >> 31) & 1;
}

float frexpf(float x, int *exp) {
  double d = (double)x;
  double r = frexp(d, exp);
  return (float)r;
}

float erff(float x)    { return (float)erf((double)x); }
float erfcf(float x)   { return (float)erfc((double)x); }
float tgammaf(float x) { return (float)tgamma((double)x); }
float lgammaf(float x) { return (float)lgamma((double)x); }
  `,
  "__stdio.c": `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

static char __stdin_buf[BUFSIZ];
static char __stdout_buf[BUFSIZ];

FILE __stdin_file  = {0, __F_READ,  _IOLBF, __stdin_buf,  BUFSIZ, 0, 0, EOF};
FILE __stdout_file = {1, __F_WRITE, _IOLBF, __stdout_buf, BUFSIZ, 0, 0, EOF};
FILE __stderr_file = {2, __F_WRITE, _IONBF, 0, 0, 0, 0, EOF};

static FILE *__open_files[64];
static int __num_open_files;

static int __flush_buf(FILE *stream) {
  int pos = 0;
  while (pos < stream->buf_pos) {
    long w = write(stream->fd, stream->buf + pos, stream->buf_pos - pos);
    if (w <= 0) {
      /* Preserve unwritten data at front of buffer */
      int remaining = stream->buf_pos - pos;
      memmove(stream->buf, stream->buf + pos, remaining);
      stream->buf_pos = remaining;
      stream->flags |= __F_ERR;
      return -1;
    }
    pos += w;
  }
  stream->buf_pos = 0;
  return 0;
}

int fflush(FILE *stream) {
  if (!stream) {
    fflush(stdout);
    fflush(stderr);
    for (int i = 0; i < __num_open_files; i++) {
      if (__open_files[i]) fflush(__open_files[i]);
    }
    return 0;
  }
  if ((stream->flags & __F_WRITE) && !(stream->flags & __F_RBUF) && stream->buf_pos > 0) {
    return __flush_buf(stream);
  }
  return 0;
}

size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream) {
  if (!(stream->flags & __F_WRITE)) {
    write(2, "fwrite: stream is not writable\\n", 31);
    __wasm(void, (), op 0);
  }
  size_t total = size * nmemb;
  const char *src = (const char *)ptr;

  if (stream->buf_mode == _IONBF || !stream->buf) {
    long w = write(stream->fd, src, total);
    if (w < 0) { stream->flags |= __F_ERR; return 0; }
    return w / size;
  }

  if (stream->buf_mode == _IOLBF) {
    for (size_t i = 0; i < total; i++) {
      stream->buf[stream->buf_pos++] = src[i];
      if (src[i] == '\\n' || stream->buf_pos >= stream->buf_size) {
        if (__flush_buf(stream) < 0) return i / size;
      }
    }
    return nmemb;
  }

  /* _IOFBF */
  for (size_t i = 0; i < total; i++) {
    stream->buf[stream->buf_pos++] = src[i];
    if (stream->buf_pos >= stream->buf_size) {
      if (__flush_buf(stream) < 0) return i / size;
    }
  }
  return nmemb;
}

size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream) {
  if (!(stream->flags & __F_READ)) {
    write(2, "fread: stream is not readable\\n", 30);
    __wasm(void, (), op 0);
  }
  size_t total = size * nmemb;
  char *dst = (char *)ptr;
  size_t got = 0;
  if (stream->ungetc_char != EOF && got < total) {
    dst[got++] = (unsigned char)stream->ungetc_char;
    stream->ungetc_char = EOF;
  }
  while (got < total) {
    if (stream->buf_pos < stream->buf_len) {
      size_t avail = stream->buf_len - stream->buf_pos;
      size_t want = total - got;
      size_t n = avail < want ? avail : want;
      memcpy(dst + got, stream->buf + stream->buf_pos, n);
      stream->buf_pos += n;
      got += n;
    } else {
      /* C11 7.21.3p3: flush all line-buffered output streams when input
         is requested on an unbuffered or line-buffered stream */
      if (stream->buf_mode != _IOFBF) fflush(0);
      if (!stream->buf || stream->buf_size == 0) {
        long r = read(stream->fd, dst + got, total - got);
        if (r <= 0) {
          if (r == 0) stream->flags |= __F_EOF;
          else stream->flags |= __F_ERR;
          break;
        }
        got += r;
      } else {
        long r = read(stream->fd, stream->buf, stream->buf_size);
        if (r <= 0) {
          if (r == 0) stream->flags |= __F_EOF;
          else stream->flags |= __F_ERR;
          break;
        }
        stream->buf_len = r;
        stream->buf_pos = 0;
        stream->flags |= __F_RBUF;
      }
    }
  }
  return got / size;
}

int fgetc(FILE *stream) {
  unsigned char c;
  size_t n = fread(&c, 1, 1, stream);
  if (n == 0) return EOF;
  return c;
}

int ungetc(int c, FILE *stream) {
  if (c == EOF) return EOF;
  stream->ungetc_char = (unsigned char)c;
  stream->flags &= ~__F_EOF;
  return (unsigned char)c;
}

char *fgets(char *s, int n, FILE *stream) {
  if (n <= 0) return 0;
  int i = 0;
  while (i < n - 1) {
    int c = fgetc(stream);
    if (c == EOF) break;
    s[i++] = c;
    if (c == '\\n') break;
  }
  if (i == 0) return 0;
  s[i] = '\\0';
  return s;
}

int fputc(int c, FILE *stream) {
  unsigned char ch = c;
  size_t n = fwrite(&ch, 1, 1, stream);
  if (n == 0) return EOF;
  return ch;
}

int fputs(const char *s, FILE *stream) {
  size_t len = strlen(s);
  size_t n = fwrite(s, 1, len, stream);
  if (n < len) return EOF;
  return 0;
}

int vfprintf(FILE *stream, const char *fmt, va_list ap) {
  va_list ap2;
  va_copy(ap2, ap);
  int len = vsnprintf(0, 0, fmt, ap);
  char stackbuf[256];
  char *buf = stackbuf;
  if (len + 1 > 256) {
    buf = (char *)malloc(len + 1);
  }
  vsnprintf(buf, len + 1, fmt, ap2);
  va_end(ap2);
  fwrite(buf, 1, len, stream);
  if (buf != stackbuf) free(buf);
  return len;
}

int fprintf(FILE *stream, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfprintf(stream, fmt, ap);
  va_end(ap);
  return r;
}

int vprintf(const char *fmt, va_list ap) {
  return vfprintf(stdout, fmt, ap);
}

int printf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfprintf(stdout, fmt, ap);
  va_end(ap);
  return r;
}

int putchar(int c) {
  return fputc(c, stdout);
}

int puts(const char *s) {
  fputs(s, stdout);
  fputc('\\n', stdout);
  return 0;
}

FILE *fopen(const char *path, const char *mode) {
  int flags = 0;
  int fflags = 0;
  if (mode[0] == 'r') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR;
      fflags = __F_READ | __F_WRITE;
    } else {
      flags = O_RDONLY;
      fflags = __F_READ;
    }
  } else if (mode[0] == 'w') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR | O_CREAT | O_TRUNC;
      fflags = __F_READ | __F_WRITE;
    } else {
      flags = O_WRONLY | O_CREAT | O_TRUNC;
      fflags = __F_WRITE;
    }
  } else if (mode[0] == 'a') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR | O_CREAT | O_APPEND;
      fflags = __F_READ | __F_WRITE | __F_APPEND;
    } else {
      flags = O_WRONLY | O_CREAT | O_APPEND;
      fflags = __F_WRITE | __F_APPEND;
    }
  } else {
    return 0;
  }
  int fd = open(path, flags, 0666);
  if (fd < 0) return 0;

  FILE *f = (FILE *)malloc(sizeof(FILE));
  char *buf = (char *)malloc(BUFSIZ);
  f->fd = fd;
  f->flags = fflags;
  f->buf_mode = _IOFBF;
  f->buf = buf;
  f->buf_size = BUFSIZ;
  f->buf_pos = 0;
  f->buf_len = 0;
  f->ungetc_char = EOF;

  if (__num_open_files < 64) {
    __open_files[__num_open_files++] = f;
  }
  return f;
}

int fclose(FILE *stream) {
  fflush(stream);
  int r = close(stream->fd);
  if (stream->buf) free(stream->buf);
  for (int i = 0; i < __num_open_files; i++) {
    if (__open_files[i] == stream) {
      __open_files[i] = __open_files[--__num_open_files];
      break;
    }
  }
  free(stream);
  return r;
}

int fseek(FILE *stream, long offset, int whence) {
  fflush(stream);
  stream->buf_pos = 0;
  stream->buf_len = 0;
  stream->ungetc_char = EOF;
  long r = lseek(stream->fd, offset, whence);
  if (r < 0) return -1;
  stream->flags &= ~(__F_EOF | __F_RBUF);
  return 0;
}

long ftell(FILE *stream) {
  long pos = lseek(stream->fd, 0, SEEK_CUR);
  if (pos < 0) return -1;
  if (stream->flags & __F_READ) {
    pos -= (stream->buf_len - stream->buf_pos);
    if (stream->ungetc_char != EOF) pos--;
  }
  if (stream->flags & __F_WRITE) {
    pos += stream->buf_pos;
  }
  return pos;
}

void rewind(FILE *stream) {
  fseek(stream, 0, SEEK_SET);
  stream->flags &= ~__F_ERR;
}

int fgetpos(FILE *stream, fpos_t *pos) {
  long p = ftell(stream);
  if (p < 0) return -1;
  *pos = p;
  return 0;
}

int fsetpos(FILE *stream, const fpos_t *pos) {
  return fseek(stream, *pos, SEEK_SET);
}

int feof(FILE *stream) {
  return (stream->flags & __F_EOF) != 0;
}

int ferror(FILE *stream) {
  return (stream->flags & __F_ERR) != 0;
}

void clearerr(FILE *stream) {
  stream->flags &= ~(__F_EOF | __F_ERR);
}

int setvbuf(FILE *stream, char *buf, int mode, size_t size) {
  fflush(stream);
  stream->buf_mode = mode;
  if (buf) {
    stream->buf = buf;
    stream->buf_size = size;
  }
  stream->buf_pos = 0;
  stream->buf_len = 0;
  return 0;
}

int vsscanf(const char *s, const char *fmt, va_list ap) {
  int consumed;
  int len = strlen(s);
  return __vsscanf_impl(s, len, fmt, &consumed, ap);
}

int sscanf(const char *s, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vsscanf(s, fmt, ap);
  va_end(ap);
  return r;
}

int vfscanf(FILE *stream, const char *fmt, va_list ap) {
  if (!(stream->flags & __F_READ)) {
    write(2, "vfscanf: stream is not readable\\n", 32);
    __wasm(void, (), op 0);
  }

  /* Handle ungetc char: push it back into the buffer */
  if (stream->ungetc_char != EOF) {
    if (stream->buf_pos > 0) {
      stream->buf_pos--;
      stream->buf[stream->buf_pos] = (char)stream->ungetc_char;
    } else if (stream->buf_len < stream->buf_size) {
      memmove(stream->buf + 1, stream->buf, stream->buf_len);
      stream->buf[0] = (char)stream->ungetc_char;
      stream->buf_len++;
    } else {
      write(2, "vfscanf: buffer full with ungetc pending\\n", 41);
      __wasm(void, (), op 0);
    }
    stream->ungetc_char = EOF;
  }

  /* If buffer empty, try to fill it */
  if (stream->buf_pos >= stream->buf_len) {
    long r = read(stream->fd, stream->buf, stream->buf_size);
    if (r <= 0) {
      if (r == 0) stream->flags |= __F_EOF;
      else stream->flags |= __F_ERR;
      return -1;
    }
    stream->buf_pos = 0;
    stream->buf_len = r;
  }

  /* Shift data to buffer start for accumulation */
  if (stream->buf_pos > 0) {
    memmove(stream->buf, stream->buf + stream->buf_pos, stream->buf_len - stream->buf_pos);
    stream->buf_len -= stream->buf_pos;
    stream->buf_pos = 0;
  }

  /* Loop: try parsing, refill if consumed everything */
  for (;;) {
    va_list ap2;
    va_copy(ap2, ap);
    int consumed;
    int result = __vsscanf_impl(stream->buf, stream->buf_len, fmt, &consumed, ap2);
    va_end(ap2);

    if (consumed < stream->buf_len || (stream->flags & __F_EOF)) {
      /* Done: didn't consume everything, or no more data */
      stream->buf_pos = consumed;
      return result;
    }

    /* Consumed everything — need more data */
    if (stream->buf_len >= stream->buf_size) {
      /* Buffer full, field exceeds buffer size */
      write(2, "vfscanf: field exceeds buffer size\\n", 35);
      __wasm(void, (), op 0);
    }

    long got = read(stream->fd, stream->buf + stream->buf_len,
                    stream->buf_size - stream->buf_len);
    if (got <= 0) {
      if (got == 0) stream->flags |= __F_EOF;
      else stream->flags |= __F_ERR;
      stream->buf_pos = consumed;
      return result;
    }
    stream->buf_len += got;
    /* Loop back and retry with more data */
  }
}

int fscanf(FILE *stream, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vfscanf(stream, fmt, ap);
  va_end(ap);
  return r;
}

int vscanf(const char *fmt, va_list ap) {
  return vfscanf(stdin, fmt, ap);
}

int scanf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vscanf(fmt, ap);
  va_end(ap);
  return r;
}

void setbuf(FILE *stream, char *buf) {
  setvbuf(stream, buf, buf ? _IOFBF : _IONBF, BUFSIZ);
}

void perror(const char *s) {
  if (s && *s)
    fprintf(stderr, "%s: %s\\n", s, strerror(errno));
  else
    fprintf(stderr, "%s\\n", strerror(errno));
}

// Intentionally aborts — vsprintf has no bounds checking and is unsafe.
// Do NOT replace with a working implementation. Use vsnprintf instead.
int vsprintf(char *buf, const char *fmt, va_list ap) {
  fprintf(stderr, "vsprintf() is unsafe and not supported; use vsnprintf() instead\\n");
  abort();
  return 0;
}

int sprintf(char *buf, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vsnprintf(buf, 0x7fffffff, fmt, ap);
  va_end(ap);
  return r;
}

int snprintf(char *buf, size_t size, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int r = vsnprintf(buf, size, fmt, ap);
  va_end(ap);
  return r;
}

// Variadic wrapper around __open_impl (non-variadic host import).
int open(const char *path, int flags, ...) {
  int mode = 0;
  if (flags & 0x40) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  return __open_impl(path, flags, mode);
}

// Intentionally aborts — gets has no bounds checking and is unsafe.
// Do NOT replace with a working implementation. Use fgets instead.
char *gets(char *s) {
  fprintf(stderr, "gets() is unsafe and not supported; use fgets() instead\\n");
  abort();
  return 0;
}

static void __stdio_cleanup(void) {
  fflush(0);
}
// Register stdio cleanup as an atexit handler.
// This uses a GCC-style constructor attribute to run at startup.
// For now, we use a dummy function pointer to trigger registration.
static int __stdio_cleanup_registered = atexit(__stdio_cleanup);

FILE *freopen(const char *path, const char *mode, FILE *stream) {
  if (!stream) return 0;
  fflush(stream);
  close(stream->fd);
  if (!path) return 0;
  int flags = 0;
  int fflags = 0;
  if (mode[0] == 'r') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR; fflags = __F_READ | __F_WRITE;
    } else {
      flags = O_RDONLY; fflags = __F_READ;
    }
  } else if (mode[0] == 'w') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR | O_CREAT | O_TRUNC; fflags = __F_READ | __F_WRITE;
    } else {
      flags = O_WRONLY | O_CREAT | O_TRUNC; fflags = __F_WRITE;
    }
  } else if (mode[0] == 'a') {
    if (mode[1] == '+' || (mode[1] == 'b' && mode[2] == '+')) {
      flags = O_RDWR | O_CREAT | O_APPEND; fflags = __F_READ | __F_WRITE | __F_APPEND;
    } else {
      flags = O_WRONLY | O_CREAT | O_APPEND; fflags = __F_WRITE | __F_APPEND;
    }
  } else {
    return 0;
  }
  int fd = open(path, flags, 0666);
  if (fd < 0) return 0;
  stream->fd = fd;
  stream->flags = fflags;
  stream->buf_pos = 0;
  stream->buf_len = 0;
  stream->ungetc_char = EOF;
  return stream;
}

FILE *tmpfile(void) { return 0; }
char *tmpnam(char *s) { (void)s; return 0; }
FILE *popen(const char *command, const char *type) {
  (void)command; (void)type; return 0;
}
int pclose(FILE *stream) { (void)stream; return -1; }
  `,
  "__stdlib.c": `
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <inttypes.h>
#include <__atexit.h>
__import double __strtod_impl(const char *nptr, char **endptr, const char *bound);

int abs(int n) { return n < 0 ? -n : n; }
long labs(long n) { return n < 0 ? -n : n; }

int atoi(const char *nptr) { return (int)strtol(nptr, (char **)0, 10); }
long atol(const char *nptr) { return strtol(nptr, (char **)0, 10); }

static int __digit_value(char c, int base) {
  int v;
  if (c >= '0' && c <= '9') v = c - '0';
  else if (c >= 'a' && c <= 'z') v = c - 'a' + 10;
  else if (c >= 'A' && c <= 'Z') v = c - 'A' + 10;
  else return -1;
  if (v >= base) return -1;
  return v;
}

// Core integer parser: accumulates magnitude as unsigned long long.
// Returns the parsed magnitude. Sets *neg, *any, *overflow, and *endp.
static unsigned long long __strtou_core(
    const char *nptr, const char **endp, int base,
    int *neg, int *any, int *overflow) {
  const char *s = nptr;
  while (*s == ' ' || *s == '\\t' || *s == '\\n' ||
         *s == '\\r' || *s == '\\f' || *s == '\\v')
    s++;
  *neg = 0;
  if (*s == '-') { *neg = 1; s++; }
  else if (*s == '+') { s++; }
  if ((base == 0 || base == 16) && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) {
    base = 16; s += 2;
  } else if (base == 0 && s[0] == '0') {
    base = 8; s++;
  } else if (base == 0) {
    base = 10;
  }
  unsigned long long result = 0;
  *any = 0;
  *overflow = 0;
  while (1) {
    int d = __digit_value(*s, base);
    if (d < 0) break;
    *any = 1;
    if (result > (18446744073709551615ULL - (unsigned)d) / (unsigned)base) *overflow = 1;
    if (!*overflow) result = result * base + d;
    s++;
  }
  *endp = s;
  return result;
}

unsigned long long strtoull(const char *nptr, char **endptr, int base) {
  const char *end;
  int neg, any, overflow;
  unsigned long long val = __strtou_core(nptr, &end, base, &neg, &any, &overflow);
  if (overflow) { errno = ERANGE; val = 18446744073709551615ULL; }
  else if (neg) { val = -val; }
  if (endptr) *endptr = (char *)(any ? end : nptr);
  return val;
}

long long strtoll(const char *nptr, char **endptr, int base) {
  const char *end;
  int neg, any, overflow;
  unsigned long long val = __strtou_core(nptr, &end, base, &neg, &any, &overflow);
  if (overflow || (!neg && val > 9223372036854775807ULL) ||
      (neg && val > 9223372036854775808ULL)) {
    errno = ERANGE;
    if (endptr) *endptr = (char *)(any ? end : nptr);
    return neg ? (-9223372036854775807LL - 1LL) : 9223372036854775807LL;
  }
  if (endptr) *endptr = (char *)(any ? end : nptr);
  return neg ? -(long long)val : (long long)val;
}

unsigned long strtoul(const char *nptr, char **endptr, int base) {
  const char *end;
  int neg, any, overflow;
  unsigned long long val = __strtou_core(nptr, &end, base, &neg, &any, &overflow);
  if (overflow || val > 4294967295ULL) { errno = ERANGE; val = 4294967295ULL; neg = 0; }
  if (endptr) *endptr = (char *)(any ? end : nptr);
  return neg ? -(unsigned long)val : (unsigned long)val;
}

long strtol(const char *nptr, char **endptr, int base) {
  const char *end;
  int neg, any, overflow;
  unsigned long long val = __strtou_core(nptr, &end, base, &neg, &any, &overflow);
  if (overflow || (!neg && val > 2147483647ULL) ||
      (neg && val > 2147483648ULL)) {
    errno = ERANGE;
    if (endptr) *endptr = (char *)(any ? end : nptr);
    return neg ? (-2147483647L - 1L) : 2147483647L;
  }
  if (endptr) *endptr = (char *)(any ? end : nptr);
  return neg ? -(long)val : (long)val;
}

double strtod(const char *nptr, char **endptr) {
  const char *s = nptr;
  while (*s == ' ' || *s == '\\t' || *s == '\\n' ||
         *s == '\\r' || *s == '\\f' || *s == '\\v')
    s++;
  const char *bound = s;
  if (*bound == '+' || *bound == '-') bound++;
  while (*bound >= '0' && *bound <= '9') bound++;
  if (*bound == '.') { bound++; while (*bound >= '0' && *bound <= '9') bound++; }
  if (*bound == 'e' || *bound == 'E') {
    const char *e = bound + 1;
    if (*e == '+' || *e == '-') e++;
    if (*e >= '0' && *e <= '9') {
      bound = e;
      while (*bound >= '0' && *bound <= '9') bound++;
    }
  }
  return __strtod_impl(nptr, endptr, bound);
}

float strtof(const char *nptr, char **endptr) {
  return (float)strtod(nptr, endptr);
}

long double strtold(const char *nptr, char **endptr) {
  return (long double)strtod(nptr, endptr);
}

double atof(const char *nptr) {
  return strtod(nptr, (char **)0);
}

long long atoll(const char *nptr) {
  return strtoll(nptr, (char **)0, 10);
}

long long llabs(long long n) { return n < 0 ? -n : n; }

intmax_t imaxabs(intmax_t n) { return n < 0 ? -n : n; }

imaxdiv_t imaxdiv(intmax_t numer, intmax_t denom) {
  imaxdiv_t r;
  r.quot = numer / denom;
  r.rem = numer % denom;
  return r;
}

intmax_t strtoimax(const char *nptr, char **endptr, int base) {
  return (intmax_t)strtoll(nptr, endptr, base);
}

uintmax_t strtoumax(const char *nptr, char **endptr, int base) {
  return (uintmax_t)strtoull(nptr, endptr, base);
}

static unsigned long __rand_next = 1;
int rand(void) {
  __rand_next = __rand_next * 1103515245 + 12345;
  return (__rand_next / 65536) % 32768;
}
void srand(unsigned int seed) { __rand_next = seed; }

void *bsearch(const void *key, const void *base, size_t nmemb,
              size_t size, int (*compar)(const void *, const void *)) {
  size_t lo = 0;
  size_t hi = nmemb;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    const void *p = (const char *)base + mid * size;
    int cmp = compar(key, p);
    if (cmp < 0) hi = mid;
    else if (cmp > 0) lo = mid + 1;
    else return (void *)p;
  }
  return (void *)0;
}

static void __swap(char *a, char *b, size_t size) {
  size_t i = 0;
  while (i < size) {
    char t = a[i];
    a[i] = b[i];
    b[i] = t;
    i++;
  }
}

static void __siftdown(char *base, size_t nmemb, size_t size, size_t i,
                        int (*compar)(const void *, const void *)) {
  while (1) {
    size_t left = 2 * i + 1;
    size_t right = 2 * i + 2;
    size_t largest = i;
    if (left < nmemb &&
        compar(base + left * size, base + largest * size) > 0)
      largest = left;
    if (right < nmemb &&
        compar(base + right * size, base + largest * size) > 0)
      largest = right;
    if (largest == i) break;
    __swap(base + i * size, base + largest * size, size);
    i = largest;
  }
}

void qsort(void *base, size_t nmemb, size_t size,
           int (*compar)(const void *, const void *)) {
  if (nmemb < 2) return;
  char *b = (char *)base;
  // Build max-heap
  size_t i = nmemb / 2;
  while (i > 0) {
    i--;
    __siftdown(b, nmemb, size, i, compar);
  }
  // Extract elements
  size_t end = nmemb;
  while (end > 1) {
    end--;
    __swap(b, b + end * size, size);
    __siftdown(b, end, size, 0, compar);
  }
}

__import void __exit(int status);

void exit(int status) {
  fflush(0);
  __run_atexits();
  __exit(status);
}
__export exit = exit;


void abort(void) {
  __builtin_abort();
}

div_t div(int numer, int denom) {
  div_t r;
  r.quot = numer / denom;
  r.rem = numer % denom;
  return r;
}

ldiv_t ldiv(long numer, long denom) {
  ldiv_t r;
  r.quot = numer / denom;
  r.rem = numer % denom;
  return r;
}

lldiv_t lldiv(long long numer, long long denom) {
  lldiv_t r;
  r.quot = numer / denom;
  r.rem = numer % denom;
  return r;
}

__import int __getenv(const char *name, char *buf, int buf_size);
__import int __setenv(const char *name, const char *value, int overwrite);
__import int __unsetenv(const char *name);

static char __getenv_buf[4096];

char *getenv(const char *name) {
  int len = __getenv(name, __getenv_buf, sizeof(__getenv_buf));
  if (len < 0) return 0;
  return __getenv_buf;
}

int setenv(const char *name, const char *value, int overwrite) {
  return __setenv(name, value, overwrite);
}

int unsetenv(const char *name) {
  return __unsetenv(name);
}

int system(const char *command) {
  if (!command) return 0;  /* no command processor available */
  return -1;
}

int mblen(const char *s, size_t n) {
  if (!s) return 0;
  if (n == 0 || *s == '\\0') return 0;
  return 1;
}

int mbtowc(wchar_t *pwc, const char *s, size_t n) {
  if (!s) return 0;
  if (n == 0) return -1;
  if (*s == '\\0') {
    if (pwc) *pwc = 0;
    return 0;
  }
  if (pwc) *pwc = (unsigned char)*s;
  return 1;
}

int wctomb(char *s, wchar_t wc) {
  if (!s) return 0;
  if (wc < 0 || wc > 255) return -1;
  *s = (char)wc;
  return 1;
}

size_t mbstowcs(wchar_t *dest, const char *src, size_t n) {
  size_t i;
  for (i = 0; i < n; i++) {
    if (dest) dest[i] = (unsigned char)src[i];
    if (src[i] == '\\0') return i;
  }
  return i;
}

size_t wcstombs(char *dest, const wchar_t *src, size_t n) {
  size_t i;
  for (i = 0; i < n; i++) {
    if (src[i] < 0 || src[i] > 255) return (size_t)-1;
    if (dest) dest[i] = (char)src[i];
    if (src[i] == '\\0') return i;
  }
  return i;
}
  `,
  "__string.c": `
#include <stddef.h>
#include <stdlib.h>
#include <errno.h>

void *memcpy(void *dest, const void *src, size_t n) {
  __builtin(memory_copy, dest, src, n);
  return dest;
}

void *memmove(void *dest, const void *src, size_t n) {
  // wasm memory.copy handles overlapping regions correctly
  __builtin(memory_copy, dest, src, n);
  return dest;
}

void *memset(void *s, int c, size_t n) {
  __builtin(memory_fill, s, c, n);
  return s;
}

int memcmp(const void *s1, const void *s2, size_t n) {
  const unsigned char *a = (const unsigned char *)s1;
  const unsigned char *b = (const unsigned char *)s2;
  for (size_t i = 0; i < n; i++) {
    if (a[i] != b[i]) return a[i] - b[i];
  }
  return 0;
}

size_t strlen(const char *s) {
  size_t len = 0;
  while (s[len]) len++;
  return len;
}

char *strcpy(char *dest, const char *src) {
  size_t i = 0;
  while (src[i]) { dest[i] = src[i]; i++; }
  dest[i] = 0;
  return dest;
}

char *strncpy(char *dest, const char *src, size_t n) {
  size_t i = 0;
  while (i < n && src[i]) { dest[i] = src[i]; i++; }
  while (i < n) { dest[i] = 0; i++; }
  return dest;
}

int strcmp(const char *s1, const char *s2) {
  while (*s1 && *s1 == *s2) { s1++; s2++; }
  return (unsigned char)*s1 - (unsigned char)*s2;
}

int strncmp(const char *s1, const char *s2, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (s1[i] != s2[i] || !s1[i]) return (unsigned char)s1[i] - (unsigned char)s2[i];
  }
  return 0;
}

char *strcat(char *dest, const char *src) {
  char *p = dest;
  while (*p) p++;
  while (*src) { *p = *src; p++; src++; }
  *p = 0;
  return dest;
}

char *strchr(const char *s, int c) {
  while (*s) {
    if (*s == (char)c) return (char *)s;
    s++;
  }
  if (c == 0) return (char *)s;
  return (char *)0;
}

char *strrchr(const char *s, int c) {
  const char *last = (const char *)0;
  while (*s) {
    if (*s == (char)c) last = s;
    s++;
  }
  if (c == 0) return (char *)s;
  return (char *)last;
}

char *strstr(const char *haystack, const char *needle) {
  if (!*needle) return (char *)haystack;
  while (*haystack) {
    const char *h = haystack;
    const char *n = needle;
    while (*h && *n && *h == *n) { h++; n++; }
    if (!*n) return (char *)haystack;
    haystack++;
  }
  return (char *)0;
}

void *memchr(const void *s, int c, size_t n) {
  const unsigned char *p = (const unsigned char *)s;
  for (size_t i = 0; i < n; i++) {
    if (p[i] == (unsigned char)c) return (void *)(p + i);
  }
  return (void *)0;
}

char *strncat(char *dest, const char *src, size_t n) {
  char *p = dest;
  while (*p) p++;
  while (n-- && *src) { *p++ = *src++; }
  *p = 0;
  return dest;
}

size_t strspn(const char *s, const char *accept) {
  size_t count = 0;
  while (*s) {
    const char *a = accept;
    int found = 0;
    while (*a) { if (*s == *a) { found = 1; break; } a++; }
    if (!found) break;
    s++;
    count++;
  }
  return count;
}

size_t strcspn(const char *s, const char *reject) {
  size_t count = 0;
  while (*s) {
    const char *r = reject;
    while (*r) { if (*s == *r) return count; r++; }
    s++;
    count++;
  }
  return count;
}

char *strpbrk(const char *s, const char *accept) {
  while (*s) {
    const char *a = accept;
    while (*a) { if (*s == *a) return (char *)s; a++; }
    s++;
  }
  return (char *)0;
}

char *strtok(char *str, const char *delim) {
  static char *next;
  if (str) next = str;
  if (!next) return (char *)0;
  next += strspn(next, delim);
  if (!*next) { next = (char *)0; return (char *)0; }
  char *tok = next;
  next += strcspn(next, delim);
  if (*next) { *next = 0; next++; }
  else { next = (char *)0; }
  return tok;
}

int strcoll(const char *s1, const char *s2) {
  return strcmp(s1, s2);
}

size_t strxfrm(char *dest, const char *src, size_t n) {
  size_t len = strlen(src);
  if (n > 0) {
    size_t copy = len < n ? len : n - 1;
    size_t i;
    for (i = 0; i < copy; i++) dest[i] = src[i];
    dest[i] = 0;
  }
  return len;
}

char *strerror(int errnum) {
  switch (errnum) {
  case 0:          return "Success";
  case EPERM:      return "Operation not permitted";
  case ENOENT:     return "No such file or directory";
  case ESRCH:      return "No such process";
  case EINTR:      return "Interrupted system call";
  case EIO:        return "Input/output error";
  case ENXIO:      return "No such device or address";
  case E2BIG:      return "Argument list too long";
  case ENOEXEC:    return "Exec format error";
  case EBADF:      return "Bad file descriptor";
  case ECHILD:     return "No child processes";
  case EAGAIN:     return "Resource temporarily unavailable";
  case ENOMEM:     return "Cannot allocate memory";
  case EACCES:     return "Permission denied";
  case EFAULT:     return "Bad address";
  case EBUSY:      return "Device or resource busy";
  case EEXIST:     return "File exists";
  case EXDEV:      return "Invalid cross-device link";
  case ENODEV:     return "No such device";
  case ENOTDIR:    return "Not a directory";
  case EISDIR:     return "Is a directory";
  case EINVAL:     return "Invalid argument";
  case ENFILE:     return "Too many open files in system";
  case EMFILE:     return "Too many open files";
  case ENOTTY:     return "Inappropriate ioctl for device";
  case EFBIG:      return "File too large";
  case ENOSPC:     return "No space left on device";
  case ESPIPE:     return "Illegal seek";
  case EROFS:      return "Read-only file system";
  case EPIPE:      return "Broken pipe";
  case EDOM:       return "Numerical argument out of domain";
  case ERANGE:     return "Numerical result out of range";
  case ENAMETOOLONG: return "File name too long";
  case ENOSYS:     return "Function not implemented";
  case ENOTEMPTY:  return "Directory not empty";
  default:         return "Unknown error";
  }
}

char *strdup(const char *s) {
  size_t len = strlen(s) + 1;
  char *d = malloc(len);
  if (d) memcpy(d, s, len);
  return d;
}
  `,
  "__strings.c": `
#include <stddef.h>

static int __tolower(int c) {
  if (c >= 'A' && c <= 'Z') return c + ('a' - 'A');
  return c;
}

int strcasecmp(const char *s1, const char *s2) {
  while (*s1 && *s2) {
    int c1 = __tolower((unsigned char)*s1);
    int c2 = __tolower((unsigned char)*s2);
    if (c1 != c2) return c1 - c2;
    s1++;
    s2++;
  }
  return __tolower((unsigned char)*s1) - __tolower((unsigned char)*s2);
}

int strncasecmp(const char *s1, const char *s2, size_t n) {
  for (size_t i = 0; i < n; i++) {
    int c1 = __tolower((unsigned char)*s1);
    int c2 = __tolower((unsigned char)*s2);
    if (c1 != c2) return c1 - c2;
    if (*s1 == '\\0') return 0;
    s1++;
    s2++;
  }
  return 0;
}

int ffs(int x) { return x ? __wasm(int, (x), op 0x68) + 1 : 0; }
int ffsl(long x) { return x ? __wasm(int, (x), op 0x68) + 1 : 0; }
int ffsll(long long x) { return x ? (int)__wasm(long long, (x), op 0x7A) + 1 : 0; }
int fls(int x) { return x ? 32 - __wasm(int, (x), op 0x67) : 0; }
int flsl(long x) { return x ? 32 - __wasm(int, (x), op 0x67) : 0; }
int flsll(long long x) { return x ? 64 - (int)__wasm(long long, (x), op 0x79) : 0; }
  `,
  "__time.c": `
#include <time.h>
#include <stdio.h>

__import long __time_now(void);
__import long __clock(void);
__import long __timezone_offset(long t);

time_t time(time_t *t) {
  time_t now = __time_now();
  if (t) *t = now;
  return now;
}

clock_t clock(void) {
  return __clock();
}

double difftime(time_t t1, time_t t0) {
  return (double)(t1 - t0);
}

static int __is_leap(int y) {
  return (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
}

static int __days_in_month(int m, int leap) {
  static int mdays[] = {31,28,31,30,31,30,31,31,30,31,30,31};
  if (m == 1 && leap) return 29;
  return mdays[m];
}

static int __days_in_year(int y) {
  return __is_leap(y) ? 366 : 365;
}

static struct tm __gmtime_buf;

static void __secs_to_tm(long t, struct tm *res) {
  long days = t / 86400;
  long rem = t % 86400;
  if (rem < 0) { rem += 86400; days--; }

  res->tm_hour = (int)(rem / 3600);
  rem %= 3600;
  res->tm_min = (int)(rem / 60);
  res->tm_sec = (int)(rem % 60);

  /* Jan 1, 1970 was a Thursday (wday=4) */
  int wday = (int)((days + 4) % 7);
  if (wday < 0) wday += 7;
  res->tm_wday = wday;

  int y = 1970;
  if (days >= 0) {
    while (days >= __days_in_year(y)) {
      days -= __days_in_year(y);
      y++;
    }
  } else {
    while (days < 0) {
      y--;
      days += __days_in_year(y);
    }
  }
  res->tm_year = y - 1900;
  res->tm_yday = (int)days;

  int leap = __is_leap(y);
  int m = 0;
  while (m < 11 && days >= __days_in_month(m, leap)) {
    days -= __days_in_month(m, leap);
    m++;
  }
  res->tm_mon = m;
  res->tm_mday = (int)days + 1;
}

struct tm *gmtime(const time_t *timep) {
  __secs_to_tm(*timep, &__gmtime_buf);
  __gmtime_buf.tm_isdst = 0;
  return &__gmtime_buf;
}

static struct tm __localtime_buf;

struct tm *localtime(const time_t *timep) {
  long offset = __timezone_offset(*timep);
  long local = *timep + offset;
  __secs_to_tm(local, &__localtime_buf);
  __localtime_buf.tm_isdst = -1;
  __localtime_buf.tm_gmtoff = offset;
  return &__localtime_buf;
}

struct tm *localtime_r(const time_t *timep, struct tm *result) {
  long offset = __timezone_offset(*timep);
  long local = *timep + offset;
  __secs_to_tm(local, result);
  result->tm_isdst = -1;
  result->tm_gmtoff = offset;
  return result;
}

time_t mktime(struct tm *tp) {
  /* Normalize mon */
  int m = tp->tm_mon;
  int y = tp->tm_year + 1900;
  while (m < 0)  { m += 12; y--; }
  while (m >= 12) { m -= 12; y++; }
  tp->tm_mon = m;
  tp->tm_year = y - 1900;

  /* Days from epoch to start of year */
  long days = 0;
  if (y >= 1970) {
    for (int i = 1970; i < y; i++) days += __days_in_year(i);
  } else {
    for (int i = y; i < 1970; i++) days -= __days_in_year(i);
  }

  /* Days in months */
  int leap = __is_leap(y);
  for (int i = 0; i < m; i++) days += __days_in_month(i, leap);
  days += tp->tm_mday - 1;

  long secs = days * 86400L + tp->tm_hour * 3600L + tp->tm_min * 60L + tp->tm_sec;

  /* Adjust for local timezone */
  long offset = __timezone_offset(secs);
  secs -= offset;

  /* Fill in derived fields by converting back */
  struct tm *tmp = localtime(&secs);
  *tp = *tmp;

  return secs;
}

static char __asctime_buf[32];

static const char *__wday_abbr[] = {
  "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
};
static const char *__mon_abbr[] = {
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
};

char *asctime(const struct tm *tp) {
  sprintf(__asctime_buf, "%s %s %2d %02d:%02d:%02d %d\\n",
      __wday_abbr[tp->tm_wday], __mon_abbr[tp->tm_mon],
      tp->tm_mday, tp->tm_hour, tp->tm_min, tp->tm_sec,
      tp->tm_year + 1900);
  return __asctime_buf;
}

char *ctime(const time_t *timep) {
  return asctime(localtime(timep));
}

static void __ap_str(char *s, size_t max, size_t *pos, const char *src) {
  while (*src && *pos + 1 < max) {
    s[*pos] = *src;
    (*pos)++;
    src++;
  }
}

static void __ap_int(char *s, size_t max, size_t *pos, int val, int width) {
  char buf[16];
  int len = 0;
  int neg = 0;
  int v = val;
  if (v < 0) { neg = 1; v = -v; }
  if (v == 0) { buf[len++] = '0'; }
  else { while (v > 0) { buf[len++] = '0' + v % 10; v /= 10; } }
  /* pad with zeros */
  int total = len + neg;
  while (total < width) { __ap_str(s, max, pos, "0"); total++; }
  if (neg) __ap_str(s, max, pos, "-");
  int i;
  for (i = len - 1; i >= 0; i--) {
    char c[2];
    c[0] = buf[i];
    c[1] = 0;
    __ap_str(s, max, pos, c);
  }
}

static const char *__wday_full[] = {
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday"
};
static const char *__mon_full[] = {
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
};

size_t strftime(char *s, size_t max, const char *fmt, const struct tm *tp) {
  if (max == 0) return 0;
  size_t pos = 0;

  while (*fmt && pos + 1 < max) {
    if (*fmt != '%') {
      s[pos++] = *fmt++;
      continue;
    }
    fmt++; /* skip % */
    switch (*fmt) {
    case 'Y': __ap_int(s, max, &pos, tp->tm_year + 1900, 4); break;
    case 'm': __ap_int(s, max, &pos, tp->tm_mon + 1, 2); break;
    case 'd': __ap_int(s, max, &pos, tp->tm_mday, 2); break;
    case 'H': __ap_int(s, max, &pos, tp->tm_hour, 2); break;
    case 'M': __ap_int(s, max, &pos, tp->tm_min, 2); break;
    case 'S': __ap_int(s, max, &pos, tp->tm_sec, 2); break;
    case 'a': __ap_str(s, max, &pos, __wday_abbr[tp->tm_wday]); break;
    case 'A': __ap_str(s, max, &pos, __wday_full[tp->tm_wday]); break;
    case 'b': __ap_str(s, max, &pos, __mon_abbr[tp->tm_mon]); break;
    case 'B': __ap_str(s, max, &pos, __mon_full[tp->tm_mon]); break;
    case 'c':
      __ap_str(s, max, &pos, __wday_abbr[tp->tm_wday]);
      __ap_str(s, max, &pos, " ");
      __ap_str(s, max, &pos, __mon_abbr[tp->tm_mon]);
      __ap_str(s, max, &pos, " ");
      __ap_int(s, max, &pos, tp->tm_mday, 2);
      __ap_str(s, max, &pos, " ");
      __ap_int(s, max, &pos, tp->tm_hour, 2);
      __ap_str(s, max, &pos, ":");
      __ap_int(s, max, &pos, tp->tm_min, 2);
      __ap_str(s, max, &pos, ":");
      __ap_int(s, max, &pos, tp->tm_sec, 2);
      __ap_str(s, max, &pos, " ");
      __ap_int(s, max, &pos, tp->tm_year + 1900, 4);
      break;
    case 'I': {
      int h12 = tp->tm_hour % 12;
      __ap_int(s, max, &pos, h12 == 0 ? 12 : h12, 2);
      break;
    }
    case 'p': __ap_str(s, max, &pos, tp->tm_hour < 12 ? "AM" : "PM"); break;
    case 'j': __ap_int(s, max, &pos, tp->tm_yday + 1, 3); break;
    case 'w': __ap_int(s, max, &pos, tp->tm_wday, 1); break;
    case 'u': __ap_int(s, max, &pos, tp->tm_wday == 0 ? 7 : tp->tm_wday, 1); break;
    case 'y': __ap_int(s, max, &pos, (tp->tm_year + 1900) % 100, 2); break;
    case 'U': __ap_int(s, max, &pos, (tp->tm_yday + 7 - tp->tm_wday) / 7, 2); break;
    case 'W': __ap_int(s, max, &pos, (tp->tm_yday + 7 - (tp->tm_wday ? tp->tm_wday - 1 : 6)) / 7, 2); break;
    case 'x':
      __ap_int(s, max, &pos, tp->tm_mon + 1, 2);
      __ap_str(s, max, &pos, "/");
      __ap_int(s, max, &pos, tp->tm_mday, 2);
      __ap_str(s, max, &pos, "/");
      __ap_int(s, max, &pos, (tp->tm_year + 1900) % 100, 2);
      break;
    case 'X':
      __ap_int(s, max, &pos, tp->tm_hour, 2);
      __ap_str(s, max, &pos, ":");
      __ap_int(s, max, &pos, tp->tm_min, 2);
      __ap_str(s, max, &pos, ":");
      __ap_int(s, max, &pos, tp->tm_sec, 2);
      break;
    case 'Z': break; /* no timezone name available in wasm */
    case '%': s[pos++] = '%'; break;
    case 'n': s[pos++] = '\\n'; break;
    case 't': s[pos++] = '\\t'; break;
    case '\\0': goto done;
    default:
      s[pos++] = '%';
      if (pos + 1 < max) s[pos++] = *fmt;
      break;
    }
    fmt++;
  }
done:
  s[pos] = '\\0';
  return pos;
}

__import long __clock_ns_hi(void);
__import long __clock_ns_lo(void);

int clock_gettime(clockid_t clk_id, struct timespec *tp) {
  (void)clk_id;
  long hi = __clock_ns_hi();
  long lo = __clock_ns_lo();
  /* hi = seconds, lo = nanoseconds remainder */
  tp->tv_sec = hi;
  tp->tv_nsec = lo;
  return 0;
}
  `,
};

function getStdlibHeaders() { return _stdlibHeaders; }
function getStdlibSources() { return _stdlibSources; }

function createDefaultPPRegistry() {
  const pp = new Lexer.PPRegistry();

  // Load standard library headers
  const headers = getStdlibHeaders();
  for (const [name, content] of Object.entries(headers)) {
    pp.standardHeaders.set(name, content);
  }

  // Predefined macros (matching C++ compiler)
  const defs = {
    "__MTOTS__": "1",
    "__STDC__": "1",
    "__STDC_VERSION__": "201112L",
    "__STDC_NO_ATOMICS__": "1",
    "__STDC_NO_COMPLEX__": "1",
    "__STDC_NO_THREADS__": "1",
    "__STDC_NO_VLA__": "1",
    "__wasm__": "1",
    "__wasm32__": "1",
    "__ILP32__": "1",
    "__ORDER_LITTLE_ENDIAN__": "1234",
    "__ORDER_BIG_ENDIAN__": "4321",
    "__BYTE_ORDER__": "__ORDER_LITTLE_ENDIAN__",
    "__LITTLE_ENDIAN__": "1",
    "__SIZEOF_SHORT__": "2",
    "__SIZEOF_INT__": "4",
    "__SIZEOF_LONG__": "4",
    "__SIZEOF_LONG_LONG__": "8",
    "__SIZEOF_FLOAT__": "4",
    "__SIZEOF_DOUBLE__": "8",
    "__SIZEOF_POINTER__": "4",
    "__SIZEOF_SIZE_T__": "4",
    "__SIZEOF_PTRDIFF_T__": "4",
  };
  for (const [k, v] of Object.entries(defs)) {
    pp.defines.set(k, v);
  }

  pp.prelude = [
    "#define __builtin_clz(x) __wasm(int, (x), op 0x67)",
    "#define __builtin_ctz(x) __wasm(int, (x), op 0x68)",
    "#define __builtin_clzl(x) __builtin_clz(x)",
    "#define __builtin_ctzl(x) __builtin_ctz(x)",
    "#define __builtin_clzll(x) ((int)__wasm(long long, (x), op 0x79))",
    "#define __builtin_ctzll(x) ((int)__wasm(long long, (x), op 0x7a))",
  ].join("\n") + "\n";

  return pp;
}

function parseAllUnits(fs, pp, inputFiles, options) {
  const units = [];
  const requiredSources = new Set();
  const pendingRequiredSources = [];
  const stdlibSources = getStdlibSources();
  const exceptionTagRegistry = new Map(); // global cross-TU exception tag unification
  let hasErrors = false;
  const writeErr = options && options.writeErr
    ? options.writeErr
    : (typeof process !== 'undefined' ? (s) => process.stderr.write(s) : () => {});
  const timing = options?.timing;
  const hrtime = timing
    ? (typeof process !== 'undefined' && process.hrtime
      ? () => { const [s, ns] = process.hrtime(); return s * 1000 + ns / 1e6; }
      : () => performance.now())
    : null;

  // Auto-require __alloca.c
  requiredSources.add("__alloca.c");
  pendingRequiredSources.push("__alloca.c");
  for (const src of (options.compilerOptions.requireSources || [])) {
    if (!requiredSources.has(src)) {
      requiredSources.add(src);
      pendingRequiredSources.push(src);
    }
  }

  const processSource = (filename, source) => {
    pp.onceGuards = new Set();
    const filenameInterned = Lexer.intern(filename);
    const tLex = hrtime ? hrtime() : 0;
    const result = Lexer.tokenize(filenameInterned, source, pp);
    if (timing) timing.lexMs += hrtime() - tLex;
    if (result.errors.length > 0) {
      writeErr(`Got ${result.errors.length} lex errors in ${filename}.\n`);
      for (const err of result.errors) {
        writeErr(`${err.filename}:${err.line}: error: ${err.message}\n`);
      }
      hasErrors = true;
      return;
    }
    const tParse = hrtime ? hrtime() : 0;
    const parseResult = Parser.parseTokens(result.tokens, { ...options, exceptionTagRegistry });
    const unit = parseResult.translationUnit;
    for (const req of unit.requiredSources) {
      if (!requiredSources.has(req)) {
        requiredSources.add(req);
        pendingRequiredSources.push(req);
      }
    }
    // Per-TU passes (before linking). Goto resolution lives in the codegen
    // now (out-of-scope diagnostics are emitted by Codegen.generateCode as
    // it walks the AST). Implicit-cast insertion happens inline at parse
    // time at each construction site.
    Parser.lowerSetjmpLongjmp(unit, exceptionTagRegistry);
    if (!options?.compilerOptions?.noFold) {
      INLINER.optimize(unit, { noUndefined: !!options?.compilerOptions?.noUndefined });
    }
    if (!options?.compilerOptions?.noGotoNormalize) {
      GOTO_NORMALIZER.optimize(unit);
    }
    // IRREDUCIBLE_LOWERING is invoked on-demand at codegen time, only for
    // functions whose structured emit failed (see the retry block in the
    // wasm emitter driver). The default path is structured codegen for
    // every function; we only pay the rewrite + retry cost for functions
    // that genuinely can't be expressed structurally.
    if (timing) timing.parseMs += hrtime() - tParse;
    if (parseResult.errors.length > 0) {
      hasErrors = true;
      writeErr(`Got ${parseResult.errors.length} parse errors in ${filename}.\n`);
      for (const err of parseResult.errors) {
        writeErr(`${err.filename}:${err.line}: error: ${err.message}\n`);
      }
    }
    for (const w of parseResult.warnings) {
      writeErr(`${w.filename}:${w.line}: warning: ${w.message}\n`);
    }
    units.push(unit);
  };

  for (const file of inputFiles) {
    const source = fs.readFileSync(file, "utf-8");
    pp.sourceBuffers.set(file, source);
    processSource(file, source);
  }

  while (pendingRequiredSources.length > 0) {
    const name = pendingRequiredSources.shift();
    const source = stdlibSources[name];
    if (!source) {
      writeErr(`Unknown stdlib source: ${name}\n`);
      hasErrors = true;
      continue;
    }
    pp.sourceBuffers.set(name, source);
    processSource(name, source);
  }

  if (hasErrors) {
    if (typeof process !== 'undefined' && process.exit) process.exit(1);
    throw new Error("Compilation failed");
  }
  return units;
}

return { getStdlibHeaders, getStdlibSources, createDefaultPPRegistry, parseAllUnits };
})();

// ====================
// HTML Output
// ====================

const HtmlOutput = (() => {

function generate({ wasmBinary, hostJsSource, opfsFiles, runArgs, programName, xtermSources }) {
  const strippedHostJs = hostJsSource.replace(/^#!.*\n/, '');
  const safeHostJs = strippedHostJs.replace(/<\/script>/gi, '<\\/script>');
  const wasmBase64 = Buffer.from(wasmBinary).toString('base64');
  const opfsEntries = opfsFiles.map(f => ({
    path: f.destPath,
    data: Buffer.from(f.bytes).toString('base64'),
  }));
  const hasXterm = !!xtermSources;
  const safeXtermJs = hasXterm ? xtermSources.xtermJs.replace(/<\/script>/gi, '<\\/script>') : '';
  const safeXtermFitJs = hasXterm ? xtermSources.xtermFitJs.replace(/<\/script>/gi, '<\\/script>') : '';

  const workerScript = `
${strippedHostJs}

var sdlRef = null;
var wasmInstance = null;
var decoder = new TextDecoder();
var stdinResolve = null;
var termSizeResolve = null;
var stdinReadyResolve = null;
var stdinNotifyResolvers = [];

self.onmessage = function(e) {
  var msg = e.data;
  if (msg.type === 'run') doRun(msg);
  else if (msg.type === 'keydown' || msg.type === 'keyup') {
    if (sdlRef) sdlRef.pushKeyEvent(msg.handle, msg.eventType, msg.scancode, msg.sym);
  } else if (msg.type === 'mousedown' || msg.type === 'mouseup') {
    if (sdlRef) sdlRef.pushMouseButtonEvent(msg.handle, msg.eventType, msg.button, msg.x, msg.y);
  } else if (msg.type === 'mousemove') {
    if (sdlRef) sdlRef.pushMouseMotionEvent(msg.handle, msg.x, msg.y);
  } else if (msg.type === 'wheel') {
    if (sdlRef) sdlRef.pushMouseWheelEvent(msg.handle, msg.x, msg.y);
  } else if (msg.type === 'quit') {
    if (sdlRef) sdlRef.pushQuitEvent(1);
  } else if (msg.type === 'stdin-response') {
    if (stdinResolve) { var r = stdinResolve; stdinResolve = null; r(msg.data ? new Uint8Array(msg.data) : null); }
  } else if (msg.type === 'terminal-size') {
    if (termSizeResolve) { var r = termSizeResolve; termSizeResolve = null; r({ rows: msg.rows, cols: msg.cols }); }
  } else if (msg.type === 'stdin-ready-response') {
    if (stdinReadyResolve) { var r = stdinReadyResolve; stdinReadyResolve = null; r(msg.ready); }
  } else if (msg.type === 'stdin-data-available') {
    var resolvers = stdinNotifyResolvers;
    stdinNotifyResolvers = [];
    for (var ri = 0; ri < resolvers.length; ri++) resolvers[ri]();
  }
};

async function doRun(msg) {
  var opts = {
    bytes: msg.bytes,
    args: msg.args && msg.args.length > 0 ? msg.args : undefined,
    useBrowserFS: true,
    writeOut: function(buf) {
      var text = (buf instanceof Uint8Array) ? decoder.decode(buf) : String(buf);
      self.postMessage({ type: 'stdout', text: text });
    },
    writeErr: function(buf) {
      var text = (buf instanceof Uint8Array) ? decoder.decode(buf) : String(buf);
      self.postMessage({ type: 'stderr', text: text });
    },
    onReady: function(info) { sdlRef = info.sdl; wasmInstance = info.instance; },
    requestStdin: function(maxBytes) {
      return new Promise(function(resolve) {
        stdinResolve = resolve;
        self.postMessage({ type: 'stdin-request', maxBytes: maxBytes });
      });
    },
    requestTerminalSize: function() {
      return new Promise(function(resolve) {
        termSizeResolve = resolve;
        self.postMessage({ type: 'terminal-size-request' });
      });
    },
    requestStdinReady: function() {
      return new Promise(function(resolve) {
        stdinReadyResolve = resolve;
        self.postMessage({ type: 'stdin-ready-request' });
      });
    },
    requestStdinNotify: function() {
      return new Promise(function(resolve) {
        stdinNotifyResolvers.push(resolve);
      });
    },
  };
  if (msg.canvas) {
    opts.getBrowserSDL = msg.canvas;
    opts.notifyWindow = function(m) { self.postMessage(m); };
  }
  if (msg.sharedAudioBuffer) {
    opts.sharedAudioBuffer = { sharedBuffer: msg.sharedAudioBuffer, bufferSize: msg.audioBufferSize };
    opts.notifyAudio = function(m) { self.postMessage(m); };
  }
  try {
    var exitCode = await runModule(opts);
    self.postMessage({ type: 'exit', exitCode: exitCode });
  } catch(err) {
    self.postMessage({ type: 'error', message: err.message });
  }
}
`;

  const xtermStyleTag = hasXterm ? `<style>${xtermSources.xtermCss}</style>` : '';
  const xtermScriptTags = hasXterm ? `<script>${safeXtermJs}<\/script>\n<script>${safeXtermFitJs}<\/script>` : '';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(programName)}</title>
${xtermStyleTag}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;color:#0f0;font-family:monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
#overlay{position:fixed;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;z-index:10;cursor:pointer}
#overlay span{font-size:28px;color:#fff}
#canvas-container{flex:1;display:none;align-items:center;justify-content:center;background:#000;min-height:0}
#canvas{image-rendering:pixelated;object-fit:contain;width:100%;height:100%}
#terminal{flex:1;display:none}
#output{flex:1;padding:8px;overflow-y:auto;white-space:pre-wrap;font-size:14px;display:none}
#log-panel{display:none;flex-direction:column;max-height:40vh;border-top:1px solid #333}
#log-toolbar{display:flex;gap:4px;padding:4px 8px;background:#111;flex-shrink:0}
#log-toolbar button{background:#222;color:#aaa;border:1px solid #444;padding:2px 8px;font-size:11px;font-family:monospace;cursor:pointer}
#log-toolbar button.active{color:#fff;border-color:#888}
#log-toolbar button:hover{background:#333}
#log-content{flex:1;overflow-y:auto;padding:4px 8px;font-size:12px;white-space:pre-wrap;background:#0a0a0a;min-height:0}
#log-content .log-out{color:#0f0}
#log-content .log-err{color:#f44}
#status{position:fixed;bottom:8px;right:8px;padding:4px 12px;font-size:12px;color:#aaa;background:rgba(0,0,0,0.7);border:1px solid #333;border-radius:4px;display:none;opacity:1;transition:opacity 0.5s ease;pointer-events:none;z-index:20}
</style>
</head>
<body>
<div id="overlay" tabindex="0"><span>Click to Start</span></div>
<div id="canvas-container"><canvas id="canvas"></canvas></div>
<div id="terminal"></div>
<pre id="output"></pre>
<div id="log-panel">
  <div id="log-toolbar">
    <button id="log-toggle">Console</button>
    <button id="log-stdout" class="active">stdout</button>
    <button id="log-stderr" class="active">stderr</button>
    <label id="volume-label" style="margin-left:auto;display:flex;align-items:center;gap:4px;color:#aaa;font-size:12px">Vol<input id="volume-slider" type="range" min="0" max="100" value="40" style="width:80px;vertical-align:middle"><span id="volume-pct">40%</span></label>
  </div>
  <div id="log-content"></div>
</div>
<div id="status"></div>
${xtermScriptTags}
<script>${safeHostJs}<\/script>
<script>
window.onerror = function(msg, url, line, col, err) {
  document.getElementById('status').style.display = 'block';
  document.getElementById('status').textContent = 'JS Error: ' + msg + ' (line ' + line + ')';
  console.error('[global error]', msg, url, line, col, err);
};
window.onunhandledrejection = function(e) {
  document.getElementById('status').style.display = 'block';
  document.getElementById('status').textContent = 'Unhandled rejection: ' + (e.reason && e.reason.message || e.reason);
  console.error('[unhandled rejection]', e.reason);
};
(function() {
  var WASM_BASE64 = ${JSON.stringify(wasmBase64)};
  var OPFS_FILES = ${JSON.stringify(opfsEntries)};
  var RUN_ARGS = ${JSON.stringify(runArgs)};
  var PROGRAM_NAME = ${JSON.stringify(programName)};
  var HAS_XTERM = ${hasXterm};

  var overlay = document.getElementById('overlay');
  var canvasContainer = document.getElementById('canvas-container');
  var canvas = document.getElementById('canvas');
  var terminalEl = document.getElementById('terminal');
  var output = document.getElementById('output');
  var logPanel = document.getElementById('log-panel');
  var logContent = document.getElementById('log-content');
  var logToggle = document.getElementById('log-toggle');
  var logStdoutBtn = document.getElementById('log-stdout');
  var logStderrBtn = document.getElementById('log-stderr');
  var volumeSlider = document.getElementById('volume-slider');
  var status = document.getElementById('status');
  var worker = null;
  var audioReceiver = null;
  var hasSDL = false;
  var sdlCanvasW = 0, sdlCanvasH = 0;
  var term = null;
  var stdinLine = '';
  var stdinResolve = null;
  var stdinRawMode = false;
  var stdinRawBuffer = [];
  var opostMode = true;
  var logExpanded = false;
  var showStdout = true;
  var showStderr = true;

  logToggle.addEventListener('click', function() {
    logExpanded = !logExpanded;
    logContent.style.display = logExpanded ? 'block' : 'none';
    logToggle.textContent = logExpanded ? 'Console \\u25BC' : 'Console \\u25B6';
  });
  logStdoutBtn.addEventListener('click', function() {
    showStdout = !showStdout;
    logStdoutBtn.classList.toggle('active', showStdout);
    updateLogVisibility();
  });
  logStderrBtn.addEventListener('click', function() {
    showStderr = !showStderr;
    logStderrBtn.classList.toggle('active', showStderr);
    updateLogVisibility();
  });
  var volumePct = document.getElementById('volume-pct');
  volumeSlider.addEventListener('input', function() {
    var v = volumeSlider.value / 100;
    volumePct.textContent = volumeSlider.value + '%';
    if (audioReceiver) audioReceiver.setVolume(v * v);
  });
  function updateLogVisibility() {
    var entries = logContent.children;
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i];
      if (el.classList.contains('log-out')) el.style.display = showStdout ? '' : 'none';
      else if (el.classList.contains('log-err')) el.style.display = showStderr ? '' : 'none';
    }
  }

  var ANSI_GREEN = '\\x1b[32m';
  var ANSI_RED = '\\x1b[31m';
  var ANSI_RESET = '\\x1b[0m';

  var fitAddon = null;
  if (HAS_XTERM && typeof Terminal === 'function') {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace",
      theme: { background: '#0d0d1a', foreground: '#b0f0b0', cursor: '#b0f0b0' },
    });
    if (typeof FitAddon === 'function') {
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalEl);
      window.addEventListener('resize', function() { fitAddon.fit(); });
    } else {
      term.open(terminalEl);
    }
    term.onData(function(data) {
      if (stdinRawMode) {
        var encoder = new TextEncoder();
        var bytes = encoder.encode(data);
        if (stdinResolve) {
          var resolve = stdinResolve;
          stdinResolve = null;
          resolve(bytes);
        } else {
          for (var b = 0; b < bytes.length; b++) stdinRawBuffer.push(bytes[b]);
        }
        if (worker) worker.postMessage({ type: 'stdin-data-available' });
        return;
      }
      if (!stdinResolve) return;
      for (var i = 0; i < data.length; i++) {
        var ch = data[i];
        if (ch === '\\r') {
          term.write('\\r\\n');
          var line = stdinLine + '\\n';
          stdinLine = '';
          var resolve = stdinResolve;
          stdinResolve = null;
          var encoder = new TextEncoder();
          resolve(encoder.encode(line));
        } else if (ch === '\\x7f' || ch === '\\b') {
          if (stdinLine.length > 0) {
            stdinLine = stdinLine.slice(0, -1);
            term.write('\\b \\b');
          }
        } else if (ch >= ' ') {
          stdinLine += ch;
          term.write(ch);
        }
      }
    });
  }

  var sdlNamedKeysyms = {
    'Enter':13,'Escape':27,'Backspace':8,'Tab':9,' ':32,'Delete':127
  };
  var sdlScancodeMap = {
    'ArrowUp':82,'ArrowDown':81,'ArrowLeft':80,'ArrowRight':79,
    'ShiftLeft':225,'ShiftRight':229,'ControlLeft':224,'ControlRight':228,
    'AltLeft':226,'AltRight':230,
    'F1':58,'F2':59,'F3':60,'F4':61,'F5':62,'F6':63,
    'F7':64,'F8':65,'F9':66,'F10':67,'F11':68,'F12':69
  };
  function sdlKeysym(e) {
    if (typeof e.key==='string'&&e.key.length===1) return e.key.charCodeAt(0);
    if (sdlNamedKeysyms[e.key]!==undefined) return sdlNamedKeysyms[e.key];
    return (sdlScancodeMap[e.code]||0)|0x40000000;
  }
  function sdlScancode(e) { return sdlScancodeMap[e.code]||0; }

  function onKeydown(e) {
    if (!worker||!hasSDL) return;
    e.preventDefault();
    worker.postMessage({type:'keydown',handle:1,eventType:0x300,scancode:sdlScancode(e),sym:sdlKeysym(e)});
  }
  function onKeyup(e) {
    if (!worker||!hasSDL) return;
    e.preventDefault();
    worker.postMessage({type:'keyup',handle:1,eventType:0x301,scancode:sdlScancode(e),sym:sdlKeysym(e)});
  }
  function canvasCoords(e) {
    var rect = canvas.getBoundingClientRect();
    var cw = sdlCanvasW || canvas.width || rect.width;
    var ch = sdlCanvasH || canvas.height || rect.height;
    var aspect = cw / ch;
    var rw, rh, ox, oy;
    if (rect.width / rect.height > aspect) {
      rh = rect.height; rw = rh * aspect; ox = (rect.width - rw) / 2; oy = 0;
    } else {
      rw = rect.width; rh = rw / aspect; ox = 0; oy = (rect.height - rh) / 2;
    }
    return {x:Math.round((e.offsetX-ox)*cw/rw), y:Math.round((e.offsetY-oy)*ch/rh)};
  }
  function onMousedown(e) {
    if (!worker||!hasSDL) return;
    var c=canvasCoords(e);
    worker.postMessage({type:'mousedown',handle:1,eventType:0x401,button:e.button+1,x:c.x,y:c.y});
  }
  function onMouseup(e) {
    if (!worker||!hasSDL) return;
    var c=canvasCoords(e);
    worker.postMessage({type:'mouseup',handle:1,eventType:0x402,button:e.button+1,x:c.x,y:c.y});
  }
  function onMousemove(e) {
    if (!worker||!hasSDL) return;
    var c=canvasCoords(e);
    worker.postMessage({type:'mousemove',handle:1,x:c.x,y:c.y});
  }
  function onWheel(e) {
    if (!worker||!hasSDL) return;
    e.preventDefault();
    var dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 20;
    else if (e.deltaMode === 2) dy *= 600;
    worker.postMessage({type:'wheel',handle:1,x:0,y:Math.round(dy)});
  }

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function writeOutput(text, isErr) {
    if (hasSDL) {
      var span = document.createElement('span');
      span.className = isErr ? 'log-err' : 'log-out';
      span.textContent = text;
      if (isErr && !showStderr) span.style.display = 'none';
      if (!isErr && !showStdout) span.style.display = 'none';
      logContent.appendChild(span);
      if (logExpanded) logContent.scrollTop = logContent.scrollHeight;
      return;
    }
    if (term) {
      if (!opostMode) {
        term.write(text);
      } else {
        var escaped = text.replace(/\\n/g, '\\r\\n');
        term.write((isErr ? ANSI_RED : ANSI_GREEN) + escaped + ANSI_RESET);
      }
    } else {
      output.style.display = 'block';
      var span = document.createElement('span');
      if (isErr) span.style.color = '#f44';
      span.textContent = text;
      output.appendChild(span);
      output.scrollTop = output.scrollHeight;
    }
  }

  var statusTimer = null;
  function setStatus(text) {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    if (!text) { status.style.display = 'none'; return; }
    status.textContent = text;
    status.style.display = 'block';
    status.style.opacity = '1';
    statusTimer = setTimeout(function() {
      status.style.opacity = '0';
      statusTimer = setTimeout(function() { status.style.display = 'none'; }, 500);
    }, 2000);
  }

  async function writeToOPFS(path, data) {
    var root = await navigator.storage.getDirectory();
    var parts = path.split('/').filter(Boolean);
    var dir = root;
    for (var i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    var fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    // Skip the write if the file is already present with the right
    // size. Two reasons: (1) avoid re-writing big assets like pak0.pak
    // on every page reload, and (2) avoid 'createWritable' lock
    // conflicts when a previous run's worker still has a sync access
    // handle open on this file (OPFS treats writable and sync handle
    // as mutually exclusive).
    try {
      var existing = await fh.getFile();
      if (existing.size === data.length) return;
    } catch (e) { /* fall through to write */ }
    var writable = await fh.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function start() {
    overlay.style.display = 'none';
    if (term) { term.clear(); terminalEl.style.display = 'block'; if (fitAddon) fitAddon.fit(); term.focus(); }
    setStatus('Writing files...');

    var wasmBytes = base64ToBytes(WASM_BASE64);

    for (var i = 0; i < OPFS_FILES.length; i++) {
      var fileData = base64ToBytes(OPFS_FILES[i].data);
      await writeToOPFS(OPFS_FILES[i].path, fileData);
    }

    setStatus('Starting...');
    var workerSource = ${JSON.stringify(workerScript)};
    var blob = new Blob([workerSource], { type: 'application/javascript' });
    var workerUrl = URL.createObjectURL(blob);
    worker = new Worker(workerUrl);

    var newCanvas = document.createElement('canvas');
    newCanvas.id = 'canvas';
    newCanvas.width = canvas.width;
    newCanvas.height = canvas.height;
    canvas.replaceWith(newCanvas);
    canvas = newCanvas;
    var offscreen = canvas.transferControlToOffscreen();

    var sharedAudio = null;
    audioReceiver = null;
    if (typeof SharedArrayBuffer !== 'undefined' && typeof createSharedAudioBuffer === 'function') {
      sharedAudio = createSharedAudioBuffer();
      audioReceiver = createAudioReceiver({
        sharedBuffer: sharedAudio.sharedBuffer,
        bufferSize: sharedAudio.bufferSize
      });
    }

    worker.onmessage = function(e) {
      var msg = e.data;
      if (msg.type === 'stdout') {
        writeOutput(msg.text, false);
      } else if (msg.type === 'stderr') {
        writeOutput(msg.text, true);
      } else if (msg.type === 'exit') {
        setStatus(msg.exitCode === 0 ? 'Exited.' : 'Exit code: ' + msg.exitCode);
        cleanup();
      } else if (msg.type === 'sdl-window') {
        hasSDL = true;
        sdlCanvasW = msg.width || 800;
        sdlCanvasH = msg.height || 600;
        if (term) terminalEl.style.display = 'none';
        canvasContainer.style.display = 'flex';
        logPanel.style.display = 'flex';
        logContent.style.display = 'none';
        logToggle.textContent = 'Console \\u25B6';
        setStatus('');
      } else if (msg.type === 'error') {
        writeOutput('Runtime error: ' + msg.message + '\\n', true);
        setStatus('');
        cleanup();
      } else if (msg.type === 'stdin-request') {
        if (term) {
          if (stdinRawMode) {
            if (stdinRawBuffer.length > 0) {
              var chunk = new Uint8Array(stdinRawBuffer);
              stdinRawBuffer = [];
              worker.postMessage({ type: 'stdin-response', data: Array.from(chunk) });
            } else {
              worker.postMessage({ type: 'stdin-response', data: null });
            }
          } else {
            stdinResolve = function(data) {
              worker.postMessage({ type: 'stdin-response', data: data ? Array.from(data) : null });
            };
          }
        }
      } else if (msg.type === 'termios-mode') {
        stdinRawMode = !msg.icanon;
        opostMode = msg.opost;
      } else if (msg.type === 'terminal-size-request') {
        var rows = 24, cols = 80;
        if (term) { rows = term.rows; cols = term.cols; }
        worker.postMessage({ type: 'terminal-size', rows: rows, cols: cols });
      } else if (msg.type === 'stdin-ready-request') {
        var ready = stdinRawMode ? stdinRawBuffer.length > 0 : stdinLine.length > 0;
        worker.postMessage({ type: 'stdin-ready-response', ready: ready });
      } else if (msg.type && msg.type.startsWith('audio-')) {
        if (audioReceiver) audioReceiver.handleMessage(msg);
      }
    };

    worker.onerror = function(e) {
      writeOutput('Worker error: ' + e.message + '\\n', true);
      setStatus('');
      cleanup();
    };

    function cleanup() {
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('keyup', onKeyup, true);
      canvas.removeEventListener('mousedown', onMousedown);
      canvas.removeEventListener('mouseup', onMouseup);
      canvas.removeEventListener('mousemove', onMousemove);
      canvas.removeEventListener('wheel', onWheel);
      if (audioReceiver) audioReceiver.close();
      worker = null;
      stdinRawMode = false;
      stdinRawBuffer = [];
      opostMode = true;
      stdinLine = '';
      hasSDL = false;
      overlay.style.display = 'flex';
      overlay.focus();
    }

    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('keyup', onKeyup, true);
    canvas.addEventListener('mousedown', onMousedown);
    canvas.addEventListener('mouseup', onMouseup);
    canvas.addEventListener('mousemove', onMousemove);
    canvas.addEventListener('wheel', onWheel, {passive:false});

    var transfer = [wasmBytes.buffer, offscreen];
    var msg = {
      type: 'run',
      bytes: wasmBytes,
      args: [PROGRAM_NAME].concat(RUN_ARGS),
      canvas: offscreen
    };
    if (sharedAudio) {
      msg.sharedAudioBuffer = sharedAudio.sharedBuffer;
      msg.audioBufferSize = sharedAudio.bufferSize;
    }
    worker.postMessage(msg, transfer);
    setStatus('Running...');
  }

  function safeStart() {
    start().catch(function(err) {
      console.error('[main] start() error:', err);
      setStatus('Error: ' + (err.message || err));
      document.getElementById('output').style.display = 'block';
      document.getElementById('output').textContent = 'Fatal: ' + (err.stack || err.message || err);
    });
  }
  overlay.addEventListener('click', safeStart);
  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') safeStart();
  });
  overlay.focus();
})();
</script>
</body>
</html>`;

  return Buffer.from(html, 'utf-8');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

return { generate };
})();

// ====================
// JS Output (Node.js)
// ====================

const JsOutput = (() => {

function generate({ wasmBinary, hostJsSource, opfsFiles, runArgs, programName }) {
  const strippedHostJs = hostJsSource.replace(/^#!.*\n/, '');
  const wasmBase64 = Buffer.from(wasmBinary).toString('base64');
  const opfsEntries = opfsFiles.map(f => ({
    path: f.destPath,
    data: Buffer.from(f.bytes).toString('base64'),
  }));

  const hostBody = strippedHostJs.replace(/\/\/\s*-+\s*\n\/\/\s*Dual-purpose logic[\s\S]*$/, '');

  let dataFileSetup = '';
  if (opfsEntries.length > 0) {
    dataFileSetup = `
// Write embedded data files to disk
var __opfsFiles = ${JSON.stringify(opfsEntries)};
var __tmpDir = __require("os").tmpdir();
var __dataDir = __require("path").join(__tmpDir, "cjs-" + process.pid);
__require("fs").mkdirSync(__dataDir, { recursive: true });
for (var __i = 0; __i < __opfsFiles.length; __i++) {
  var __dest = __require("path").join(__dataDir, __opfsFiles[__i].path);
  __require("fs").mkdirSync(__require("path").dirname(__dest), { recursive: true });
  __require("fs").writeFileSync(__dest, Buffer.from(__opfsFiles[__i].data, "base64"));
}
process.chdir(__dataDir);
`;
  }

  const js = `#!/usr/bin/env node
// Generated by c-compiler
var __require = require;
${hostBody}
var __wasmBase64 = ${JSON.stringify(wasmBase64)};
var __wasmBytes = Buffer.from(__wasmBase64, "base64");
${dataFileSetup}
var __args = [${JSON.stringify(programName)}].concat(process.argv.slice(2));
runModule({
  bytes: __wasmBytes,
  args: __args,
  fs: __require("fs"),
  getSDL: function () { return __require("@kmamal/sdl"); },
}).then(function (exitCode) {
  process.exit(exitCode);
}).catch(function (e) {
  process.stderr.write("Fatal: " + e.message + "\\n");
  if (e.stack) process.stderr.write(e.stack + "\\n");
  process.exit(1);
});
`;

  return Buffer.from(js, 'utf-8');
}

return { generate };
})();

function main() {
  const fs = require("fs");
  const path = require("path");
  function expandProjectJson(jsonPath, isInclude) {
    const proj = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const projDir = path.dirname(path.resolve(jsonPath));
    const projType = proj.type || "bin";
    if (projType !== "bin" && projType !== "lib") {
      process.stderr.write(`Error in ${jsonPath}: unknown type "${projType}" (expected "bin" or "lib")\n`);
      process.exit(1);
    }
    if (projType === "lib" && !isInclude) {
      process.stderr.write(`Error: ${jsonPath} is a library project and cannot be compiled directly. It can only be included as a dependency from another project.\n`);
      process.exit(1);
    }
    const result = [];
    if (proj.deps) {
      for (const dep of proj.deps) {
        result.push(...expandProjectJson(path.resolve(projDir, dep), true));
      }
    }
    if (proj.includes) {
      for (const inc of proj.includes) result.push("-I" + path.resolve(projDir, inc));
    }
    if (proj.compilerArgs) {
      for (const ca of proj.compilerArgs) {
        if (ca.startsWith("-I")) result.push("-I" + path.resolve(projDir, ca.substring(2)));
        else result.push(ca);
      }
    }
    if (proj.sources) {
      for (const src of proj.sources) result.push(path.resolve(projDir, src));
    }
    if (proj.dataFiles) {
      for (const [src, dest] of Object.entries(proj.dataFiles)) {
        const resolved = path.resolve(projDir, src);
        if (!fs.existsSync(resolved)) {
          process.stderr.write(`Error in ${jsonPath}:\n  Data file not found: ${resolved}\n`);
          process.exit(1);
        }
        result.push("--opfs-file", resolved + ":" + dest);
      }
    }
    if (proj.runArgs) {
      for (const ra of proj.runArgs) result.push("--run-arg", ra);
    }
    return result;
  }

  const rawArgs = process.argv.slice(2);
  const args = [];
  for (const arg of rawArgs) {
    if (!arg.startsWith("-") && arg.endsWith(".json")) {
      try {
        args.push(...expandProjectJson(arg, false));
      } catch (e) {
        process.stderr.write(`Error reading project file ${arg}: ${e.message}\n`);
        process.exit(1);
      }
    } else {
      args.push(arg);
    }
  }

  let action = "compile";
  let outputFile = "a.wasm";
  const inputFiles = [];
  const opfsFiles = [];
  const runArgs = [];
  const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: true };
  const compilerOptions = { debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false, allowKnRDefinitions: false, allowImplicitFunctionDecl: false, allowUndefined: false, gcSections: false, gcNoExportRoots: false, noUndefined: false, timeReport: false, requireSources: [], backend: "default" };
  let noXterm = false;
  const pp = Stdlib.createDefaultPPRegistry();

  // Set up file reader. Returns raw source — splicing happens at lex
  // time so the lexer can track per-token line-offset adjustments.
  pp.fileReader = (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a" || args[i] === "--action") {
      action = args[++i];
    } else if (args[i].startsWith("-D")) {
      const def = args[i].substring(2);
      const eqIdx = def.indexOf("=");
      if (eqIdx >= 0) {
        pp.defines.set(def.substring(0, eqIdx), def.substring(eqIdx + 1));
      } else {
        pp.defines.set(def, "1");
      }
    } else if (args[i].startsWith("-I")) {
      pp.includePaths.push(args[i].substring(2));
    } else if (args[i] === "-o") {
      outputFile = args[++i];
    } else if (args[i].startsWith("-W")) {
      const wflag = args[i].substring(2);
      if (wflag === "pointer-decay") warningFlags.pointerDecay = true;
      else if (wflag === "no-pointer-decay") warningFlags.pointerDecay = false;
      else if (wflag === "circular-dependency") warningFlags.circularDependency = true;
      else if (wflag === "no-circular-dependency") warningFlags.circularDependency = false;
      else if (wflag === "large-stack-frame") warningFlags.largeStackFrame = true;
      else if (wflag === "no-large-stack-frame") warningFlags.largeStackFrame = false;
    } else if (args[i] === "-g" || args[i] === "-g1") {
      compilerOptions.emitNames = true;
    } else if (args[i] === "-g2") {
      compilerOptions.emitNames = true;
      compilerOptions.embedSources = true;
    } else if (args[i] === "--no-reuse-locals") {
      compilerOptions.noReuseLocals = true;
    } else if (args[i] === "--compiler-debug-switch") {
      compilerOptions.debugSwitch = true;
    } else if (args[i] === "--allow-implicit-int") {
      compilerOptions.allowImplicitInt = true;
    } else if (args[i] === "--allow-empty-params") {
      compilerOptions.allowEmptyParams = true;
    } else if (args[i] === "--allow-knr-definitions") {
      compilerOptions.allowKnRDefinitions = true;
    } else if (args[i] === "--allow-implicit-function-decl") {
      compilerOptions.allowImplicitFunctionDecl = true;
    } else if (args[i] === "--allow-undefined") {
      compilerOptions.allowUndefined = true;
    } else if (args[i] === "--time-report") {
      compilerOptions.timeReport = true;
    } else if (args[i] === "--allow-old-c") {
      compilerOptions.allowImplicitInt = true;
      compilerOptions.allowEmptyParams = true;
      compilerOptions.allowKnRDefinitions = true;
      compilerOptions.allowImplicitFunctionDecl = true;
    } else if (args[i] === "--gc-sections") {
      compilerOptions.gcSections = true;
    } else if (args[i] === "--gc-no-export-roots") {
      compilerOptions.gcNoExportRoots = true;
    } else if (args[i] === "--no-fold") {
      compilerOptions.noFold = true;
    } else if (args[i] === "--no-goto-normalize") {
      compilerOptions.noGotoNormalize = true;
    } else if (args[i] === "--print-stdlib") {
      compilerOptions.printStdlib = true;
    } else if (args[i] === "--no-irreducible-lowering") {
      compilerOptions.noIrreducibleLowering = true;
    } else if (args[i] === "--trapping-float-conversions") {
      compilerOptions.trappingFloatConversions = true;
    } else if (args[i] === "-v" || args[i] === "--verbose") {
      compilerOptions.verbose = true;
    } else if (args[i] === "--dump-irred-segments") {
      compilerOptions.dumpIrredSegments = true;
    } else if (args[i] === "--no-undefined") {
      compilerOptions.noUndefined = true;
    } else if (args[i] === "--require-source") {
      if (i + 1 >= args.length) {
        process.stderr.write("Error: --require-source requires an argument\n");
        process.exit(1);
      }
      compilerOptions.requireSources.push(args[++i]);
    } else if (args[i] === "--opfs-file") {
      if (i + 1 >= args.length) {
        process.stderr.write("Error: --opfs-file requires src:dest argument\n");
        process.exit(1);
      }
      const arg = args[++i];
      const colonIdx = arg.indexOf(":");
      if (colonIdx < 0) {
        process.stderr.write("Error: --opfs-file requires src:dest format (e.g. data/file.dat:/file.dat)\n");
        process.exit(1);
      }
      opfsFiles.push({ srcPath: arg.substring(0, colonIdx), destPath: arg.substring(colonIdx + 1) });
    } else if (args[i] === "--run-arg") {
      if (i + 1 >= args.length) {
        process.stderr.write("Error: --run-arg requires an argument\n");
        process.exit(1);
      }
      runArgs.push(args[++i]);
    } else if (args[i] === "--no-xterm") {
      noXterm = true;
    } else if (args[i].startsWith("-")) {
      // Silently ignore unknown options
    } else {
      inputFiles.push(args[i]);
    }
  }

  if (!inputFiles.length && action === "compile") {
    process.stderr.write("Usage: node compiler.js [-a <lex|parse|link|cfg|print|compile>] [-o output.wasm|.html|.js] [-Dname[=val]] [-Ipath] <files...>\n");
    process.exit(1);
  }

  if (action === "lex") {
    for (const file of inputFiles) {
      const source = fs.readFileSync(file, "utf-8");
      const filename = Lexer.intern(file);
      const result = Lexer.tokenize(filename, source, pp);
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          process.stderr.write(`${err.filename}:${err.line}: error: ${err.message}\n`);
        }
        process.exit(1);
      }
      for (const t of result.tokens) {
        if (t.kind === Lexer.TokenKind.EOS) continue;
        process.stdout.write(Lexer.formatToken(t) + "\n");
      }
    }
  } else if (action === "parse" || action === "print" || action === "link" || action === "compile" || action === "cfg") {
    const hrtime = () => {
      const [s, ns] = process.hrtime();
      return s * 1000 + ns / 1e6;
    };
    const timing = compilerOptions.timeReport ? { lexMs: 0, parseMs: 0 } : null;
    const units = Stdlib.parseAllUnits(fs, pp, inputFiles, { warningFlags, compilerOptions, timing });

    if (action === "parse") {
      process.stdout.write(Parser.dumpAst(units));
    } else if (action === "print") {
      process.stdout.write(Parser.printC(units, { showStdlib: compilerOptions.printStdlib }).text);
    } else if (action === "cfg") {
      // Build per-function control-flow graphs (segments + terminators)
      // via the IRREDUCIBLE_LOWERING pass and dump them as JSON. Useful
      // for visualization in the disasm tool. Runs link first so that
      // function bodies are stitched together (so EIdent.decl refs are
      // resolved to canonical DFunc / DVar instances).
      const linkResult = Parser.linkTranslationUnits(units, compilerOptions);
      if (linkResult.errors.length > 0) {
        process.stderr.write(`Got ${linkResult.errors.length} link errors.\n`);
        for (const err of linkResult.errors) {
          process.stderr.write(`Link error: ${err.message}\n`);
          if (err.locations) for (const loc of err.locations) {
            if (loc?.filename) process.stderr.write(`  at ${loc.filename}:${loc.line}\n`);
          }
        }
        process.exit(1);
      }
      const fns = [];
      for (const unit of units) {
        for (const func of [...unit.definedFunctions, ...unit.staticFunctions]) {
          const fdef = func.definition || func;
          if (fdef !== func) continue;
          if (!fdef.body) continue;
          try {
            fns.push(IRREDUCIBLE_LOWERING.funcToCfgJson(fdef));
          } catch (e) {
            fns.push({ name: fdef.name, error: String(e && e.message || e) });
          }
        }
      }
      // BigInt isn't JSON-serializable by default; we already stringified
      // case values inside funcToCfgJson, but be defensive.
      process.stdout.write(JSON.stringify({ functions: fns }, (k, v) =>
        typeof v === 'bigint' ? String(v) : v, 2) + '\n');
    } else if (action === "link") {
      const linkResult = Parser.linkTranslationUnits(units, compilerOptions);
      if (linkResult.errors.length > 0) {
        process.stderr.write(`Got ${linkResult.errors.length} link errors.\n`);
        for (const err of linkResult.errors) {
          process.stderr.write(`Link error: ${err.message}\n`);
          if (err.locations) for (const loc of err.locations) {
            if (loc?.filename) process.stderr.write(`  at ${loc.filename}:${loc.line}\n`);
          }
        }
        process.exit(1);
      }
      process.stdout.write(Parser.dumpAst(units));
    } else if (action === "compile") {
      let t0 = hrtime();
      const linkResult = Parser.linkTranslationUnits(units, compilerOptions);
      const linkMs = hrtime() - t0;
      if (linkResult.errors.length > 0) {
        process.stderr.write(`Got ${linkResult.errors.length} link errors.\n`);
        for (const err of linkResult.errors) {
          process.stderr.write(`Link error: ${err.message}\n`);
          if (err.locations) for (const loc of err.locations) {
            if (loc?.filename) process.stderr.write(`  at ${loc.filename}:${loc.line}\n`);
          }
        }
        process.exit(1);
      }
      // After linking with --allow-undefined, move promoted extern functions
      // from declaredFunctions to importedFunctions so codegen emits wasm imports.
      if (compilerOptions.allowUndefined) {
        for (const unit of units) {
          const kept = [];
          for (const func of unit.declaredFunctions) {
            if (func.storageClass === Types.StorageClass.IMPORT) {
              unit.importedFunctions.push(func);
            } else {
              kept.push(func);
            }
          }
          unit.declaredFunctions = kept;
        }
      }
      if (compilerOptions.gcSections) Parser.gcSectionsPass(units, compilerOptions);
      t0 = hrtime();
      const codegenOpts = { compilerOptions, warningFlags };
      if (compilerOptions.embedSources) codegenOpts.sourceBuffers = pp.sourceBuffers;
      const wasmBinary = Codegen.generateCode(units, outputFile, codegenOpts);
      const codegenMs = hrtime() - t0;
      t0 = hrtime();
      if (outputFile.endsWith(".html") || outputFile.endsWith(".js")) {
        const hostJsPath = path.join(path.dirname(process.argv[1]), "host.js");
        const hostJsSource = fs.readFileSync(hostJsPath, "utf-8");
        const resolvedOpfsFiles = opfsFiles.map(f => ({
          destPath: f.destPath,
          bytes: fs.readFileSync(f.srcPath),
        }));
        if (outputFile.endsWith(".html")) {
          const programName = path.basename(outputFile, ".html");
          let xtermSources = null;
          if (!noXterm) {
            const xtermDir = path.join(path.dirname(process.argv[1]), "vendor", "xterm");
            try {
              xtermSources = {
                xtermJs: fs.readFileSync(path.join(xtermDir, "xterm.js"), "utf-8"),
                xtermFitJs: fs.readFileSync(path.join(xtermDir, "xterm-addon-fit.js"), "utf-8"),
                xtermCss: fs.readFileSync(path.join(xtermDir, "xterm.css"), "utf-8"),
              };
            } catch (e) {}
          }
          const htmlBinary = HtmlOutput.generate({ wasmBinary, hostJsSource, opfsFiles: resolvedOpfsFiles, runArgs, programName, xtermSources });
          fs.writeFileSync(outputFile, htmlBinary);
        } else {
          const programName = path.basename(outputFile, ".js");
          const jsBinary = JsOutput.generate({ wasmBinary, hostJsSource, opfsFiles: resolvedOpfsFiles, runArgs, programName });
          fs.writeFileSync(outputFile, jsBinary);
          fs.chmodSync(outputFile, 0o755);
        }
      } else {
        fs.writeFileSync(outputFile, wasmBinary);
      }
      const writeMs = hrtime() - t0;

      if (compilerOptions.timeReport) {
        const lexMs = timing.lexMs;
        const parseMs = timing.parseMs;
        const totalMs = lexMs + parseMs + linkMs + codegenMs + writeMs;
        const pct = (v) => (v / totalMs * 100).toFixed(1);
        const fmt = (v) => v.toFixed(1).padStart(8);
        process.stderr.write(
          `===== Time Report =====\n` +
          `  Lex:     ${fmt(lexMs)} ms (${pct(lexMs).padStart(5)}%)\n` +
          `  Parse:   ${fmt(parseMs)} ms (${pct(parseMs).padStart(5)}%)\n` +
          `  Link:    ${fmt(linkMs)} ms (${pct(linkMs).padStart(5)}%)\n` +
          `  Codegen: ${fmt(codegenMs)} ms (${pct(codegenMs).padStart(5)}%)\n` +
          `  Write:   ${fmt(writeMs)} ms (${pct(writeMs).padStart(5)}%)\n` +
          `  Total:   ${fmt(totalMs)} ms\n`
        );
      }
    }
  } else {
    process.stderr.write(`Unknown action: ${action}\n`);
    process.exit(1);
  }
}


// ====================
// Exports
// ====================

var _exports = {
  // Lexer
  intern: Lexer.intern,
  TokenKind: Lexer.TokenKind,
  Keyword: Lexer.Keyword,
  StringPrefix: Lexer.StringPrefix,
  TokenFlags: Lexer.TokenFlags,
  Token: Lexer.Token,
  LexError: Lexer.LexError,
  LexResult: Lexer.LexResult,
  lex: Lexer.lex,
  unescape: Lexer.unescape,
  decodeCodepoint: Lexer.decodeCodepoint,
  unescapeCodepoint: Lexer.unescapeCodepoint,
  encodeUtf16LE: Lexer.encodeUtf16LE,
  encodeUtf32LE: Lexer.encodeUtf32LE,
  parseHexFloat: Lexer.parseHexFloat,
  postProcess: Lexer.postProcess,
  spliceLines: Lexer.spliceLines,
  PPRegistry: Lexer.PPRegistry,
  preprocess: Lexer.preprocess,
  cloneToken: Lexer.cloneToken,
  tokenize: Lexer.tokenize,
  formatToken: Lexer.formatToken,
  encodeUtf8: Lexer.encodeUtf8,
  // Types
  TagKind: Types.TagKind,
  StorageClass: Types.StorageClass,
  TypeInfo: Types.TypeInfo,
  LabelKind: Types.LabelKind,
  usualArithmeticConversions: Types.usualArithmeticConversions,
  Types,
  // AST module — exposed so AST-level unit tests can build raw nodes
  // and exercise make-helpers, walkers, bubble-up, diag pool, etc.
  AST,
  // Diag pool primitives — used by make-helpers and tested directly.
  withDiag, reportError, reportWarning, fatalError, FatalDiag,
  // Optimizer — exposed so unit tests can fold a constructed AST and
  // assert specific transformations.
  INLINER,
  // Loop-switch lowering pass — exposed so the disasm tool can build a
  // CFG (basic-block decomposition) view of every function without
  // having to re-implement the segment walker.
  IRREDUCIBLE_LOWERING,
  // Parser
  parseTokens: Parser.parseTokens,
  parseSource: Parser.parseSource,
  dumpAst: Parser.dumpAst,
  printC: Parser.printC,
  linkTranslationUnits: Parser.linkTranslationUnits,
  lowerSetjmpLongjmp: Parser.lowerSetjmpLongjmp,
  gcSectionsPass: Parser.gcSectionsPass,
  // Pipeline
  createDefaultPPRegistry: Stdlib.createDefaultPPRegistry,
  parseAllUnits: Stdlib.parseAllUnits,
  generateCode: Codegen.generateCode,
  getStdlibHeaders: Stdlib.getStdlibHeaders,
  getStdlibSources: Stdlib.getStdlibSources,
};

if (typeof module !== 'undefined') {
  module.exports = _exports;
}
if (typeof self !== 'undefined' && typeof module === 'undefined') {
  self.CompilerJS = _exports;
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main();
}

})();
