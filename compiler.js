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
  X_NEW: "__new",
  X_REF_IS_NULL: "__ref_is_null",
  X_REF_EQ: "__ref_eq",
  X_REF_NULL: "__ref_null",
  X_REF_TEST: "__ref_test",
  X_REF_TEST_NULL: "__ref_test_null",
  X_ARRAY_LEN: "__array_len",
  X_NEW_ARRAY: "__new_array",
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

function lex(filename, source) {
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
    const tok = new Token(
      filename,
      savedLine,
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
  ["__new", Keyword.X_NEW],
  ["__ref_is_null", Keyword.X_REF_IS_NULL],
  ["__ref_eq", Keyword.X_REF_EQ],
  ["__ref_null", Keyword.X_REF_NULL],
  ["__ref_test", Keyword.X_REF_TEST],
  ["__ref_test_null", Keyword.X_REF_TEST_NULL],
  ["__array_len", Keyword.X_ARRAY_LEN],
  ["__new_array", Keyword.X_NEW_ARRAY],
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
function spliceLines(source) {
  if (source.indexOf("\\\n") === -1) return source;
  let result = "";
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\" && i + 1 < source.length && source[i + 1] === "\n") {
      i++; // skip both '\' and '\n'
    } else {
      result += source[i];
    }
  }
  return result;
}

// ====================
// Preprocessor
// ====================

class PPRegistry {
  constructor() {
    this.defines = new Map(); // Map<string, string|null> — name -> value (null = defined but no value)
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

    function parseBinary(minPrec) {
      const t = consume();
      if (!t) return 0n;

      let left = 0n;
      if (t.kind === TokenKind.PP_NUMBER) {
        try {
          left = BigInt(parseInt(t.text, 0));
        } catch {
          left = 0n;
        }
      } else if (t.atPunct(Punct.BANG)) {
        left = parseBinary(12) === 0n ? 1n : 0n;
      } else if (t.atPunct(Punct.MINUS)) {
        left = -parseBinary(12);
      } else if (t.atPunct(Punct.PLUS)) {
        left = parseBinary(12);
      } else if (t.atPunct(Punct.TILDE)) {
        left = ~parseBinary(12);
      } else if (t.atPunct(Punct.LPAREN)) {
        left = parseBinary(0);
        const next = peek();
        if (next && next.atPunct(Punct.RPAREN)) consume();
      } else if (t.kind === TokenKind.CHAR) {
        // Character constant in #if — parse value (C99 §6.10.1)
        let s = 0;
        if (t.text[s] === "L" || t.text[s] === "U" || t.text[s] === "u") s++;
        s++; // skip opening '
        const e = t.text.length - 1; // before closing '
        const pos = { i: s };
        left = s < e ? BigInt(unescape(t.text, pos, e)) : 0n;
      } else if (t.kind === TokenKind.IDENT) {
        left = 0n; // Standard: remaining idents after expansion are 0
      } else if (t.kind === TokenKind.INT) {
        left = t.integer;
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
          left = left !== 0n ? thenVal : elseVal;
          continue;
        }

        const right = parseBinary(prec);

        if (op.atPunct(Punct.PIPEPIPE)) left = (left !== 0n || right !== 0n) ? 1n : 0n;
        else if (op.atPunct(Punct.AMPAMP)) left = (left !== 0n && right !== 0n) ? 1n : 0n;
        else if (op.atPunct(Punct.PIPE)) left = left | right;
        else if (op.atPunct(Punct.CARET)) left = left ^ right;
        else if (op.atPunct(Punct.AMP)) left = left & right;
        else if (op.atPunct(Punct.EQEQ)) left = left === right ? 1n : 0n;
        else if (op.atPunct(Punct.NE)) left = left !== right ? 1n : 0n;
        else if (op.atPunct(Punct.LT)) left = left < right ? 1n : 0n;
        else if (op.atPunct(Punct.GT)) left = left > right ? 1n : 0n;
        else if (op.atPunct(Punct.LE)) left = left <= right ? 1n : 0n;
        else if (op.atPunct(Punct.GE)) left = left >= right ? 1n : 0n;
        else if (op.atPunct(Punct.LSHIFT)) left = left << right;
        else if (op.atPunct(Punct.RSHIFT)) left = left >> right;
        else if (op.atPunct(Punct.PLUS)) left = left + right;
        else if (op.atPunct(Punct.MINUS)) left = left - right;
        else if (op.atPunct(Punct.STAR)) left = left * right;
        else if (op.atPunct(Punct.SLASH)) left = right !== 0n ? left / right : 0n;
        else if (op.atPunct(Punct.PCT)) left = right !== 0n ? left % right : 0n;
      }
      return left;
    }

    return parseBinary(0);
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
        return { lexResult: lex(resolved, spliceLines(content)), resolvedFile: resolved };
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
  const spliced = spliceLines(source);
  const lexResult = lex(filename, spliced);
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
  intern, TokenKind, Keyword, Punct, StringPrefix, TokenFlags, Token, LexError, LexResult,
  lex, unescape, decodeCodepoint, unescapeCodepoint, encodeUtf16LE, encodeUtf32LE,
  parseHexFloat, postProcess, spliceLines, PPRegistry, preprocess, cloneToken,
  tokenize, formatToken, encodeUtf8,
};
})();

// ====================
// Parser — Type System
// ====================

const Types = (() => {

const TypeKind = Object.freeze({
  UNKNOWN: "unknown", VOID: "void", BOOL: "_Bool",
  CHAR: "char", SCHAR: "signed char", UCHAR: "unsigned char",
  SHORT: "short", USHORT: "unsigned short",
  INT: "int", UINT: "unsigned int",
  LONG: "long", ULONG: "unsigned long",
  LLONG: "long long", ULLONG: "unsigned long long",
  FLOAT: "float", DOUBLE: "double", LDOUBLE: "long double",
  POINTER: "pointer", ARRAY: "array", FUNCTION: "function",
  TAG: "tag", EXTERNREF: "externref", REFEXTERN: "refextern",
  GC_STRUCT: "gc_struct", GC_ARRAY: "gc_array",
  EQREF: "eqref",
  AUTO: "auto",  // C23 type-inference sentinel (set during parse, resolved at init)
});

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

const ExprKind = Object.freeze({
  INT: "INT", FLOAT: "FLOAT", STRING: "STRING", IDENT: "IDENT",
  BINARY: "BINARY", UNARY: "UNARY", TERNARY: "TERNARY", CALL: "CALL",
  SUBSCRIPT: "SUBSCRIPT", MEMBER: "MEMBER", ARROW: "ARROW", CAST: "CAST",
  SIZEOF_EXPR: "SIZEOF_EXPR", SIZEOF_TYPE: "SIZEOF_TYPE",
  ALIGNOF_EXPR: "ALIGNOF_EXPR", ALIGNOF_TYPE: "ALIGNOF_TYPE",
  COMMA: "COMMA", INIT_LIST: "INIT_LIST", INTRINSIC: "INTRINSIC",
  WASM: "WASM",
  COMPOUND_LITERAL: "COMPOUND_LITERAL",
  IMPLICIT_CAST: "IMPLICIT_CAST",
  GC_NEW: "GC_NEW",
});

const StmtKind = Object.freeze({
  EXPR: "expression-statement", DECL: "declaration-statement",
  COMPOUND: "compound-statement", IF: "if-statement",
  WHILE: "while-statement", DO_WHILE: "do-while-statement",
  FOR: "for-statement", BREAK: "break-statement",
  CONTINUE: "continue-statement", RETURN: "return-statement",
  SWITCH: "switch-statement", GOTO: "goto-statement",
  LABEL: "label-statement", EMPTY: "empty-statement",
  TRY_CATCH: "try-catch-statement", THROW: "throw-statement",
});

const DeclKind = Object.freeze({
  VAR: "variable", FUNC: "function", TAG: "tag", ENUM_CONST: "enum-constant",
});

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

// Type system with caching (identity comparison by reference)
class TypeInfo {
  constructor(kind, size, align, isComplete, extra) {
    this.kind = kind;
    this.size = size;
    this.align = align;
    this.isComplete = isComplete;
    this.isConst = false;
    this.isVolatile = false;
    // Kind-specific data
    this.baseType = extra?.baseType || null;       // POINTER, ARRAY
    this.arraySize = extra?.arraySize || 0;        // ARRAY
    this.returnType = extra?.returnType || null;    // FUNCTION
    this.paramTypes = extra?.paramTypes || null;    // FUNCTION
    this.isVarArg = extra?.isVarArg || false;      // FUNCTION
    this.hasUnspecifiedParams = extra?.hasUnspecifiedParams || false; // FUNCTION: f() vs f(void)
    this.tagName = extra?.tagName || null;          // TAG
    this.tagKind = extra?.tagKind || null;          // TAG
    this.tagDecl = extra?.tagDecl || null;          // TAG
    this.parentType = null;                          // GC_STRUCT inheritance
    // Derived type caches
    this._pointer = null;
    this._constVariant = null;
    this._volatileVariant = null;
    this._arrayCache = null;
    this._funcTypeCache = null;
    this._gcArrayCache = null;
    // Codegen-side caches: WASM type indices for GC types
    this._wasmGCTypeIdx = -1;
    Object.seal(this);
  }

  toString() {
    let out = "";
    if (this.isConst) out += "const ";
    if (this.isVolatile) out += "volatile ";
    if (this.kind === TypeKind.POINTER) {
      out += "*" + this.baseType.toString();
    } else if (this.kind === TypeKind.ARRAY) {
      out += "[" + this.arraySize + "]" + this.baseType.toString();
    } else if (this.kind === TypeKind.TAG) {
      out += this.tagKind + " " + this.tagName;
    } else if (this.kind === TypeKind.GC_STRUCT) {
      out += "__struct " + this.tagName;
    } else if (this.kind === TypeKind.GC_ARRAY) {
      out += "__array(" + this.baseType.toString() + ")";
    } else if (this.kind === TypeKind.EQREF) {
      out += "__eqref";
    } else if (this.kind === TypeKind.FUNCTION) {
      out += "(";
      if (this.paramTypes) {
        out += this.paramTypes.map(p => p.toString()).join(", ");
        if (this.isVarArg) out += ", ...";
      }
      out += ")" + this.returnType.toString();
    } else {
      out += this.kind; // primitive kinds are their own string
    }
    return out;
  }

  pointer() {
    // GC ref types are already "one level of indirection" semantically — the
    // value IS a reference to a heap object. Allowing `__struct Foo *` (and
    // `**`, etc.) to collapse to `__struct Foo` lets users write the C-pointer
    // form for IDE friendliness (clang accepts `struct Foo *`) without
    // changing the underlying WASM type.
    if (this.kind === TypeKind.GC_STRUCT || this.kind === TypeKind.GC_ARRAY ||
        this.kind === TypeKind.EQREF) {
      return this;
    }
    if (this._pointer) return this._pointer;
    const p = new TypeInfo(TypeKind.POINTER, 4, 4, true, { baseType: this });
    this._pointer = p;
    return p;
  }

  toggleConst() {
    if (this._constVariant) return this._constVariant;
    const c = new TypeInfo(this.kind, this.size, this.align, this.isComplete, {
      baseType: this.baseType, arraySize: this.arraySize,
      returnType: this.returnType, paramTypes: this.paramTypes, isVarArg: this.isVarArg,
      hasUnspecifiedParams: this.hasUnspecifiedParams,
      tagName: this.tagName, tagKind: this.tagKind, tagDecl: this.tagDecl,
    });
    c.isConst = !this.isConst;
    c.isVolatile = this.isVolatile;
    c._constVariant = this;
    this._constVariant = c;
    // Cross-link volatile variants
    c._volatileVariant = this._volatileVariant?._constVariant || null;
    return c;
  }

  addConst() { return this.isConst ? this : this.toggleConst(); }
  removeConst() { return this.isConst ? this.toggleConst() : this; }

  toggleVolatile() {
    if (this._volatileVariant) return this._volatileVariant;
    const v = new TypeInfo(this.kind, this.size, this.align, this.isComplete, {
      baseType: this.baseType, arraySize: this.arraySize,
      returnType: this.returnType, paramTypes: this.paramTypes, isVarArg: this.isVarArg,
      hasUnspecifiedParams: this.hasUnspecifiedParams,
      tagName: this.tagName, tagKind: this.tagKind, tagDecl: this.tagDecl,
    });
    v.isVolatile = !this.isVolatile;
    v.isConst = this.isConst;
    v._volatileVariant = this;
    this._volatileVariant = v;
    return v;
  }

  addVolatile() { return this.isVolatile ? this : this.toggleVolatile(); }

  decay() {
    if (this.kind === TypeKind.ARRAY) return this.baseType.pointer();
    if (this.kind === TypeKind.FUNCTION) return this.pointer();
    return this;
  }

  isInteger() {
    switch (this.kind) {
      case TypeKind.BOOL: case TypeKind.CHAR: case TypeKind.SCHAR: case TypeKind.UCHAR:
      case TypeKind.SHORT: case TypeKind.USHORT: case TypeKind.INT: case TypeKind.UINT:
      case TypeKind.LONG: case TypeKind.ULONG: case TypeKind.LLONG: case TypeKind.ULLONG:
        return true;
      default: return false;
    }
  }

  isUnsigned() {
    return this.kind === TypeKind.BOOL || this.kind === TypeKind.UCHAR ||
        this.kind === TypeKind.USHORT || this.kind === TypeKind.UINT ||
        this.kind === TypeKind.ULONG || this.kind === TypeKind.ULLONG;
  }

  isFloatingPoint() {
    return this.kind === TypeKind.FLOAT || this.kind === TypeKind.DOUBLE || this.kind === TypeKind.LDOUBLE;
  }

  isArithmetic() { return this.isInteger() || this.isFloatingPoint(); }
  isScalar() { return this.isArithmetic() || this.kind === TypeKind.POINTER; }
  isPointer() { return this.kind === TypeKind.POINTER; }
  isRef() {
    return this.kind === TypeKind.EXTERNREF || this.kind === TypeKind.REFEXTERN ||
        this.kind === TypeKind.GC_STRUCT || this.kind === TypeKind.GC_ARRAY ||
        this.kind === TypeKind.EQREF;
  }
  isGCRef() {
    // GC universe — eqref + concrete GC types. Excludes externref/refextern.
    return this.kind === TypeKind.GC_STRUCT || this.kind === TypeKind.GC_ARRAY ||
        this.kind === TypeKind.EQREF;
  }
  isGCStruct() { return this.kind === TypeKind.GC_STRUCT; }
  isGCArray() { return this.kind === TypeKind.GC_ARRAY; }
  isArray() { return this.kind === TypeKind.ARRAY; }
  isFunction() { return this.kind === TypeKind.FUNCTION; }
  isVoid() { return this.kind === TypeKind.VOID; }
  isTag() { return this.kind === TypeKind.TAG; }
  isStruct() { return this.kind === TypeKind.TAG && this.tagKind === TagKind.STRUCT; }
  isUnion() { return this.kind === TypeKind.TAG && this.tagKind === TagKind.UNION; }
  isEnum() { return this.kind === TypeKind.TAG && this.tagKind === TagKind.ENUM; }
  isAggregate() {
    return this.kind === TypeKind.ARRAY ||
      (this.kind === TypeKind.TAG && (this.tagKind === TagKind.STRUCT || this.tagKind === TagKind.UNION));
  }

  removeQualifiers() {
    let t = this;
    if (t.isConst) t = t.toggleConst();
    if (t.isVolatile) t = t.toggleVolatile();
    return t;
  }

  getBaseType() { return this.baseType; }
  getReturnType() { return this.returnType; }
  getParamTypes() { return this.paramTypes || []; }

  isCompatibleWith(other, _seen) {
    if (this === other) return true;
    if (this.kind !== other.kind) return false;
    if (this.isConst !== other.isConst || this.isVolatile !== other.isVolatile) return false;
    switch (this.kind) {
      case TypeKind.ARRAY:
        if (!this.baseType.isCompatibleWith(other.baseType, _seen)) return false;
        return this.arraySize === 0 || other.arraySize === 0 || this.arraySize === other.arraySize;
      case TypeKind.POINTER:
        return this.baseType.isCompatibleWith(other.baseType, _seen);
      case TypeKind.GC_ARRAY:
        // GC types are structural — element compatibility is enough.
        return this.baseType.isCompatibleWith(other.baseType, _seen);
      case TypeKind.GC_STRUCT: {
        // GC structs are structural: same number of fields, each pairwise compatible.
        if (!this.isComplete || !other.isComplete) return false;
        // Cycle detection for recursive types (Node.next of type Node).
        // If we're already comparing this pair, optimistically return true —
        // any difference will surface at a non-recursive field.
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
      case TypeKind.TAG:
        if (this.tagKind !== other.tagKind) return false;
        // Compare by tagName (always set) rather than tagDecl.name (null if incomplete)
        if (this.tagName === other.tagName) return true;
        // Anonymous tags get different names across TUs
        return this.tagName?.startsWith("__anon_") && other.tagName?.startsWith("__anon_");
      case TypeKind.FUNCTION: {
        if (!this.returnType.isCompatibleWith(other.returnType)) return false;
        const params = this.paramTypes || [];
        const otherParams = other.paramTypes || [];
        // f() has unspecified params, compatible with any signature
        if (this.hasUnspecifiedParams || other.hasUnspecifiedParams) return true;
        if (this.isVarArg !== other.isVarArg) return false;
        if (params.length !== otherParams.length) return false;
        for (let i = 0; i < params.length; i++) {
          if (!params[i].isCompatibleWith(otherParams[i])) return false;
        }
        return true;
      }
      default:
        return false; // primitives would have matched with === above
    }
  }
}

// Primitive type singletons
const TUNKNOWN = new TypeInfo(TypeKind.UNKNOWN, 0, 0, false);
const TVOID = new TypeInfo(TypeKind.VOID, 0, 0, false);
const TBOOL = new TypeInfo(TypeKind.BOOL, 1, 1, true);
const TCHAR = new TypeInfo(TypeKind.CHAR, 1, 1, true);
const TSCHAR = new TypeInfo(TypeKind.SCHAR, 1, 1, true);
const TUCHAR = new TypeInfo(TypeKind.UCHAR, 1, 1, true);
const TSHORT = new TypeInfo(TypeKind.SHORT, 2, 2, true);
const TUSHORT = new TypeInfo(TypeKind.USHORT, 2, 2, true);
const TINT = new TypeInfo(TypeKind.INT, 4, 4, true);
const TUINT = new TypeInfo(TypeKind.UINT, 4, 4, true);
const TLONG = new TypeInfo(TypeKind.LONG, 4, 4, true);
const TULONG = new TypeInfo(TypeKind.ULONG, 4, 4, true);
const TLLONG = new TypeInfo(TypeKind.LLONG, 8, 8, true);
const TULLONG = new TypeInfo(TypeKind.ULLONG, 8, 8, true);
const TFLOAT = new TypeInfo(TypeKind.FLOAT, 4, 4, true);
const TDOUBLE = new TypeInfo(TypeKind.DOUBLE, 8, 8, true);
const TLDOUBLE = new TypeInfo(TypeKind.LDOUBLE, 8, 8, true);
const TEXTERNREF = new TypeInfo(TypeKind.EXTERNREF, 0, 0, false);
const TREFEXTERN = new TypeInfo(TypeKind.REFEXTERN, 0, 0, false);
const TEQREF = new TypeInfo(TypeKind.EQREF, 0, 0, true);
const TAUTO = new TypeInfo(TypeKind.AUTO, 0, 0, false);

// Type construction caches
function arrayOf(elemType, size) {
  const key = `${elemType.kind}:${size}`;
  // Simple key isn't sufficient for complex types, use a different approach
  // We use a two-level map: elemType -> (size -> TypeInfo)
  if (!elemType._arrayCache) elemType._arrayCache = new Map();
  if (elemType._arrayCache.has(size)) return elemType._arrayCache.get(size);
  const elemSize = elemType.size;
  const t = new TypeInfo(TypeKind.ARRAY, elemSize * size, elemType.align, size > 0, {
    baseType: elemType, arraySize: size,
  });
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
  const t = new TypeInfo(TypeKind.FUNCTION, 0, 0, true, {
    returnType: retType, paramTypes, isVarArg, hasUnspecifiedParams,
  });
  map.set(key, t);
  return t;
}

// Tag type cache: tagKind+name -> TypeInfo
function getOrCreateTagType(tagTypeCache, tagKind, name) {
  const key = tagKind + ":" + name;
  if (tagTypeCache.has(key)) return tagTypeCache.get(key);
  const isEnum = tagKind === TagKind.ENUM;
  const size = isEnum ? 4 : 0;
  const align = isEnum ? 4 : 0;
  const t = new TypeInfo(TypeKind.TAG, size, align, false, { tagKind, tagName: name });
  tagTypeCache.set(key, t);
  return t;
}

// GC struct type cache: name -> TypeInfo (TypeKind.GC_STRUCT)
function getOrCreateGCStructType(gcStructTypeCache, name) {
  if (gcStructTypeCache.has(name)) return gcStructTypeCache.get(name);
  const t = new TypeInfo(TypeKind.GC_STRUCT, 0, 0, false, { tagKind: TagKind.GC_STRUCT, tagName: name });
  gcStructTypeCache.set(name, t);
  return t;
}

// GC array type cache: keyed by element type identity (stored on element's _gcArrayCache)
function gcArrayOf(elementType) {
  if (elementType._gcArrayCache) return elementType._gcArrayCache;
  const t = new TypeInfo(TypeKind.GC_ARRAY, 0, 0, true, { baseType: elementType });
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

      if (inBitField && m.type.kind === bfUnitType.kind && m.type.size === bfUnitType.size &&
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
  if (type === TBOOL) return v !== 0n ? 1n : 0n;
  return v;  // long long, pointer: no truncation needed
}

function usualArithmeticConversions(a, b) {
  // C99 6.3.1.8: strip qualifiers so 'const double' matches TDOUBLE etc.
  a = a.removeQualifiers();
  b = b.removeQualifiers();
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
  TypeKind, TagKind, StorageClass, AllocClass, LabelKind,
  ExprKind, StmtKind, DeclKind, IntrinsicKind, BopStr, UopStr,
  TypeInfo,
  TUNKNOWN, TVOID, TBOOL, TCHAR, TSCHAR, TUCHAR, TSHORT, TUSHORT,
  TINT, TUINT, TLONG, TULONG, TLLONG, TULLONG, TFLOAT, TDOUBLE, TLDOUBLE, TEXTERNREF, TREFEXTERN, TEQREF, TAUTO,
  arrayOf, functionType, getOrCreateTagType,
  getOrCreateGCStructType, gcArrayOf,
  computeStructLayout, computeUnionLayout, computeUnaryType,
  usualArithmeticConversions, truncateConstInt,
};
})();

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
}

// ====================
// AST Node Classes
// ====================

let nextDeclId = 1;

// --- Base classes ---
class Expr {
    constructor(kind, type) {
      this.kind = kind;
      this.type = type;
    }
  }
  class Stmt {
    constructor(kind) {
      this.kind = kind;
      this.loc = null;
    }
  }
  class Decl {
    constructor(declKind) {
      this.declKind = declKind;
      this.id = nextDeclId++;
    }
  }

  // --- Decl subclasses ---
  class DVar extends Decl {
    constructor(loc, name, type, storageClass, initExpr) {
      super(Types.DeclKind.VAR);
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
      super(Types.DeclKind.FUNC);
      this.loc = loc; this.name = name; this.type = type;
      this.parameters = params || [];
      this.storageClass = storageClass || Types.StorageClass.NONE;
      this.isInline = isInline || false;
      this.body = body || null;
      this.staticLocals = []; this.externLocals = []; this.externLocalFuncs = [];
      this.usedSymbols = new Set(); this.compoundLiterals = [];
      this.definition = null;
      this.importModule = null; this.importName = null;
      Object.seal(this);
    }
  }
  class DTag extends Decl {
    constructor(loc, tagKind, name, isComplete, members) {
      super(Types.DeclKind.TAG);
      this.loc = loc; this.tagKind = tagKind; this.name = name;
      this.isComplete = isComplete || false;
      this.isPacked = false;
      this.members = members || [];
      Object.seal(this);
    }
  }
  class DEnumConst extends Decl {
    constructor(loc, name, value) {
      super(Types.DeclKind.ENUM_CONST);
      this.loc = loc; this.name = name; this.value = value;
      Object.seal(this);
    }
  }

  // --- Expr subclasses ---
  class EInt extends Expr {
    constructor(type, value) { super(Types.ExprKind.INT, type); this.value = value; Object.seal(this); }
  }
  class EFloat extends Expr {
    constructor(type, value) { super(Types.ExprKind.FLOAT, type); this.value = value; Object.seal(this); }
  }
  class EString extends Expr {
    constructor(type, value) { super(Types.ExprKind.STRING, type); this.value = value; Object.seal(this); }
  }
  class EIdent extends Expr {
    constructor(type, name, decl) { super(Types.ExprKind.IDENT, type); this.name = name; this.decl = decl; Object.seal(this); }
  }
  class EBinary extends Expr {
    constructor(type, op, left, right) { super(Types.ExprKind.BINARY, type); this.op = op; this.left = left; this.right = right; Object.seal(this); }
  }
  class EUnary extends Expr {
    constructor(type, op, operand) { super(Types.ExprKind.UNARY, type); this.op = op; this.operand = operand; Object.seal(this); }
  }
  class ETernary extends Expr {
    constructor(type, condition, thenExpr, elseExpr) { super(Types.ExprKind.TERNARY, type); this.condition = condition; this.thenExpr = thenExpr; this.elseExpr = elseExpr; Object.seal(this); }
  }
  class ECall extends Expr {
    constructor(type, callee, args, funcDecl) { super(Types.ExprKind.CALL, type); this.callee = callee; this.arguments = args; this.funcDecl = funcDecl || null; Object.seal(this); }
  }
  class ESubscript extends Expr {
    constructor(type, array, index) { super(Types.ExprKind.SUBSCRIPT, type); this.array = array; this.index = index; Object.seal(this); }
  }
  class EMember extends Expr {
    constructor(type, base, memberName, memberDecl) { super(Types.ExprKind.MEMBER, type); this.base = base; this.memberName = memberName; this.memberDecl = memberDecl || null; Object.seal(this); }
  }
  class EArrow extends Expr {
    constructor(type, base, memberName, memberDecl) { super(Types.ExprKind.ARROW, type); this.base = base; this.memberName = memberName; this.memberDecl = memberDecl || null; Object.seal(this); }
  }
  class ECast extends Expr {
    constructor(type, targetType, expr) { super(Types.ExprKind.CAST, type); this.targetType = targetType; this.expr = expr; Object.seal(this); }
  }
  class ESizeofExpr extends Expr {
    constructor(type, expr) { super(Types.ExprKind.SIZEOF_EXPR, type); this.expr = expr; Object.seal(this); }
  }
  class ESizeofType extends Expr {
    constructor(type, operandType) { super(Types.ExprKind.SIZEOF_TYPE, type); this.operandType = operandType; Object.seal(this); }
  }
  class EAlignofExpr extends Expr {
    constructor(type, expr) { super(Types.ExprKind.ALIGNOF_EXPR, type); this.expr = expr; Object.seal(this); }
  }
  class EAlignofType extends Expr {
    constructor(type, operandType) { super(Types.ExprKind.ALIGNOF_TYPE, type); this.operandType = operandType; Object.seal(this); }
  }
  class EComma extends Expr {
    constructor(type, expressions) { super(Types.ExprKind.COMMA, type); this.expressions = expressions; Object.seal(this); }
  }
  class EInitList extends Expr {
    constructor(type, elements, designators, unionMemberIndex) {
      super(Types.ExprKind.INIT_LIST, type);
      this.elements = elements; this.designators = designators || [];
      this.unionMemberIndex = unionMemberIndex ?? -1;
      Object.seal(this);
    }
  }
  class EIntrinsic extends Expr {
    constructor(type, ikind, args, argType) { super(Types.ExprKind.INTRINSIC, type); this.intrinsicKind = ikind; this.args = args; this.argType = argType || null; Object.seal(this); }
  }
  class EWasm extends Expr {
    constructor(type, args, bytes) { super(Types.ExprKind.WASM, type); this.args = args; this.bytes = bytes; Object.seal(this); }
  }
  class ECompoundLiteral extends Expr {
    constructor(type, initList) { super(Types.ExprKind.COMPOUND_LITERAL, type); this.initList = initList; Object.seal(this); }
  }
  class EImplicitCast extends Expr {
    constructor(type, expr) { super(Types.ExprKind.IMPLICIT_CAST, type); this.expr = expr; Object.seal(this); }
  }
  class EGCNew extends Expr {
    constructor(type, args) { super(Types.ExprKind.GC_NEW, type); this.args = args; Object.seal(this); }
  }

  // --- Stmt subclasses ---
  class SExpr extends Stmt {
    constructor(expr) { super(Types.StmtKind.EXPR); this.expr = expr; Object.seal(this); }
  }
  class SDecl extends Stmt {
    constructor(declarations) { super(Types.StmtKind.DECL); this.declarations = declarations; Object.seal(this); }
  }
  class SCompound extends Stmt {
    constructor(statements, labels) { super(Types.StmtKind.COMPOUND); this.statements = statements; this.labels = labels || []; Object.seal(this); }
  }
  class SIf extends Stmt {
    constructor(condition, thenBranch, elseBranch) { super(Types.StmtKind.IF); this.condition = condition; this.thenBranch = thenBranch; this.elseBranch = elseBranch || null; Object.seal(this); }
  }
  class SWhile extends Stmt {
    constructor(condition, body) { super(Types.StmtKind.WHILE); this.condition = condition; this.body = body; Object.seal(this); }
  }
  class SDoWhile extends Stmt {
    constructor(body, condition) { super(Types.StmtKind.DO_WHILE); this.body = body; this.condition = condition; Object.seal(this); }
  }
  class SFor extends Stmt {
    constructor(init, condition, increment, body) { super(Types.StmtKind.FOR); this.init = init; this.condition = condition; this.increment = increment; this.body = body; Object.seal(this); }
  }
  class SBreak extends Stmt {
    constructor() { super(Types.StmtKind.BREAK); Object.seal(this); }
  }
  class SContinue extends Stmt {
    constructor() { super(Types.StmtKind.CONTINUE); Object.seal(this); }
  }
  class SReturn extends Stmt {
    constructor(expr) { super(Types.StmtKind.RETURN); this.expr = expr || null; Object.seal(this); }
  }
  class SSwitch extends Stmt {
    constructor(expr, cases, body, loc) { super(Types.StmtKind.SWITCH); this.expr = expr; this.cases = cases; this.body = body; this.loc = loc || null; Object.seal(this); }
  }
  class SGoto extends Stmt {
    constructor(label) { super(Types.StmtKind.GOTO); this.label = label; this.target = null; this.loc = null; Object.seal(this); }
  }
  class SLabel extends Stmt {
    constructor(name, enclosingBlock) { super(Types.StmtKind.LABEL); this.name = name; this.enclosingBlock = enclosingBlock || null; this.labelKind = Types.LabelKind.FORWARD; this.hasGotos = false; Object.seal(this); }
  }
  class SEmpty extends Stmt {
    constructor() { super(Types.StmtKind.EMPTY); Object.seal(this); }
  }
  class STryCatch extends Stmt {
    constructor(tryBody, catches) { super(Types.StmtKind.TRY_CATCH); this.tryBody = tryBody; this.catches = catches; Object.seal(this); }
  }
  class SThrow extends Stmt {
    constructor(tag, args) { super(Types.StmtKind.THROW); this.tag = tag; this.args = args; Object.seal(this); }
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
    this.globalUsedSymbols = new Set();
    this.fileScopeCompoundLiterals = [];
    Object.seal(this);
  }
}
function makeTUnit(filename) { return new TUnit(filename); }

return {
  Scope,
  Expr, Stmt, Decl,
  DVar, DFunc, DTag, DEnumConst,
  EInt, EFloat, EString, EIdent, EBinary, EUnary, ETernary, ECall,
  ESubscript, EMember, EArrow, ECast, ESizeofExpr, ESizeofType,
  EAlignofExpr, EAlignofType, EComma, EInitList, EIntrinsic, EWasm,
  ECompoundLiteral, EImplicitCast, EGCNew,
  SExpr, SDecl, SCompound, SIf, SWhile, SDoWhile, SFor,
  SBreak, SContinue, SReturn, SSwitch, SGoto, SLabel, SEmpty,
  STryCatch, SThrow,
  makeTUnit,
};
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
  if (value > 0x7FFFFFFFFFFFFFFFn) value = value - 0x10000000000000000n;
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
    if (decl.declKind === Types.DeclKind.FUNC || decl.declKind === Types.DeclKind.VAR) {
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
  switch (expr.kind) {
    case Types.ExprKind.INT:
      ret += "INT " + expr.value;
      break;
    case Types.ExprKind.FLOAT:
      ret += "FLOAT " + formatFloatForDump(expr.value);
      break;
    case Types.ExprKind.STRING:
      ret += "STRING len=" + expr.value.length;
      break;
    case Types.ExprKind.IDENT: {
      ret += "IDENT " + expr.name;
      if (expr.decl) {
        const id = ctx.formatDeclId(expr.decl);
        const defnId = ctx.formatDeclIdOfDefinition(expr.decl);
        if (id === defnId) ret += " (decl=" + id + ")";
        else ret += " (decl=" + id + ", defn=" + defnId + ")";
      }
      break;
    }
    case Types.ExprKind.BINARY:
      ret += "BINARY " + Types.BopStr[expr.op];
      ret += dumpExpr(expr.left, ctx, indent + 1);
      ret += dumpExpr(expr.right, ctx, indent + 1);
      break;
    case Types.ExprKind.UNARY:
      ret += "UNARY " + Types.UopStr[expr.op];
      ret += dumpExpr(expr.operand, ctx, indent + 1);
      break;
    case Types.ExprKind.TERNARY:
      ret += "TERNARY";
      ret += dumpExpr(expr.condition, ctx, indent + 1);
      ret += dumpExpr(expr.thenExpr, ctx, indent + 1);
      ret += dumpExpr(expr.elseExpr, ctx, indent + 1);
      break;
    case Types.ExprKind.CALL:
      ret += "CALL " + expr.arguments.length + " args";
      ret += dumpExpr(expr.callee, ctx, indent + 1);
      for (const arg of expr.arguments) ret += dumpExpr(arg, ctx, indent + 1);
      break;
    case Types.ExprKind.SUBSCRIPT:
      ret += "SUBSCRIPT";
      ret += dumpExpr(expr.array, ctx, indent + 1);
      ret += dumpExpr(expr.index, ctx, indent + 1);
      break;
    case Types.ExprKind.MEMBER:
      ret += "MEMBER ." + (expr.memberName ?? "(anon)");
      ret += dumpExpr(expr.base, ctx, indent + 1);
      break;
    case Types.ExprKind.ARROW:
      ret += "ARROW ->" + (expr.memberName ?? "(anon)");
      ret += dumpExpr(expr.base, ctx, indent + 1);
      break;
    case Types.ExprKind.CAST:
      ret += "CAST " + expr.targetType.toString();
      ret += dumpExpr(expr.expr, ctx, indent + 1);
      break;
    case Types.ExprKind.IMPLICIT_CAST:
      ret += "IMPLICIT_CAST " + expr.type.toString();
      ret += dumpExpr(expr.expr, ctx, indent + 1);
      break;
    case Types.ExprKind.SIZEOF_EXPR:
      ret += "SIZEOF_EXPR";
      ret += dumpExpr(expr.expr, ctx, indent + 1);
      break;
    case Types.ExprKind.SIZEOF_TYPE:
      ret += "SIZEOF_TYPE " + expr.operandType.toString();
      break;
    case Types.ExprKind.ALIGNOF_EXPR:
      ret += "ALIGNOF_EXPR";
      ret += dumpExpr(expr.expr, ctx, indent + 1);
      break;
    case Types.ExprKind.ALIGNOF_TYPE:
      ret += "ALIGNOF_TYPE " + expr.operandType.toString();
      break;
    case Types.ExprKind.COMMA:
      ret += "COMMA " + expr.expressions.length;
      for (const e of expr.expressions) ret += dumpExpr(e, ctx, indent + 1);
      break;
    case Types.ExprKind.INIT_LIST:
      ret += "INIT_LIST " + expr.elements.length;
      for (const e of expr.elements) ret += dumpExpr(e, ctx, indent + 1);
      break;
    case Types.ExprKind.INTRINSIC:
      ret += "INTRINSIC " + expr.intrinsicKind;
      for (const arg of expr.args) ret += dumpExpr(arg, ctx, indent + 1);
      break;
    case Types.ExprKind.WASM:
      ret += "WASM " + expr.bytes.length + " bytes " + expr.args.length + " args";
      for (const arg of expr.args) ret += dumpExpr(arg, ctx, indent + 1);
      break;
    case Types.ExprKind.COMPOUND_LITERAL:
      ret += "COMPOUND_LITERAL";
      ret += dumpExpr(expr.initList, ctx, indent + 1);
      break;
  }
  return ret;
}

function dumpStmt(stmt, ctx, indent) {
  let ret = ind(indent);
  ret += "Stmt " + stmt.kind + ":";
  switch (stmt.kind) {
    case Types.StmtKind.EXPR:
      ret += dumpExpr(stmt.expr, ctx, indent + 1);
      break;
    case Types.StmtKind.RETURN:
      if (stmt.expr) ret += dumpExpr(stmt.expr, ctx, indent + 1);
      else ret += " (no expression)";
      break;
    case Types.StmtKind.DECL:
      for (const d of stmt.declarations) ret += dumpDecl(d, ctx, indent + 1);
      break;
    case Types.StmtKind.COMPOUND:
      ret += " " + stmt.statements.length + " statements";
      for (const s of stmt.statements) ret += dumpStmt(s, ctx, indent + 1);
      break;
    case Types.StmtKind.GOTO:
      ret += " " + stmt.label;
      break;
    case Types.StmtKind.LABEL:
      ret += " " + stmt.name;
      break;
    case Types.StmtKind.IF:
      ret += dumpExpr(stmt.condition, ctx, indent + 1);
      ret += dumpStmt(stmt.thenBranch, ctx, indent + 1);
      if (stmt.elseBranch) ret += dumpStmt(stmt.elseBranch, ctx, indent + 1);
      break;
    case Types.StmtKind.WHILE:
      ret += dumpExpr(stmt.condition, ctx, indent + 1);
      ret += dumpStmt(stmt.body, ctx, indent + 1);
      break;
    case Types.StmtKind.DO_WHILE:
      ret += dumpStmt(stmt.body, ctx, indent + 1);
      ret += dumpExpr(stmt.condition, ctx, indent + 1);
      break;
    case Types.StmtKind.FOR:
      if (stmt.init) ret += dumpStmt(stmt.init, ctx, indent + 1);
      else ret += ind(indent + 1) + "(no init)";
      if (stmt.condition) ret += dumpExpr(stmt.condition, ctx, indent + 1);
      else ret += ind(indent + 1) + "(no condition)";
      if (stmt.increment) ret += dumpExpr(stmt.increment, ctx, indent + 1);
      else ret += ind(indent + 1) + "(no increment)";
      ret += dumpStmt(stmt.body, ctx, indent + 1);
      break;
    case Types.StmtKind.SWITCH:
      ret += dumpExpr(stmt.expr, ctx, indent + 1);
      ret += ind(indent + 1) + stmt.cases.length + " cases";
      for (const c of stmt.cases) {
        ret += ind(indent + 2);
        if (c.isDefault) ret += "default: @" + c.stmtIndex;
        else ret += "case " + c.value + ": @" + c.stmtIndex;
      }
      ret += dumpStmt(stmt.body, ctx, indent + 1);
      break;
    case Types.StmtKind.TRY_CATCH:
      ret += dumpStmt(stmt.tryBody, ctx, indent + 1);
      for (const cc of stmt.catches) {
        ret += ind(indent + 1);
        if (cc.tag) ret += "catch " + cc.tag.name;
        else ret += "catch_all";
        ret += dumpStmt(cc.body, ctx, indent + 2);
      }
      break;
    case Types.StmtKind.THROW:
      ret += " " + stmt.tag.name;
      for (const arg of stmt.args) ret += dumpExpr(arg, ctx, indent + 1);
      break;
    case Types.StmtKind.EMPTY:
    case Types.StmtKind.BREAK:
    case Types.StmtKind.CONTINUE:
      break;
  }
  return ret;
}

function dumpDecl(decl, ctx, indent) {
  let ret = ind(indent);
  ret += "Decl " + decl.declKind + " " + ctx.formatDeclId(decl);
  const defnStr = ctx.formatDeclIdOfDefinition(decl);
  if (defnStr !== ctx.formatDeclId(decl)) {
    ret += " (def=" + defnStr + ")";
  }
  ret += ":";
  if (decl.declKind === Types.DeclKind.VAR) {
    ret += " " + decl.name + " " + decl.type.toString();
    if (decl.storageClass !== Types.StorageClass.NONE) ret += " (" + decl.storageClass + ")";
    if (decl.initExpr) ret += dumpExpr(decl.initExpr, ctx, indent + 1);
  } else if (decl.declKind === Types.DeclKind.FUNC) {
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
// Parser — filterUnusedDeclarations
// ====================

function filterUnusedDeclarations(unit) {
  const active = new Set();
  const worklist = [];
  const activate = (d) => { if (d && !active.has(d)) { active.add(d); worklist.push(d); } };

  // Seed non-static definitions
  for (const f of unit.definedFunctions) {
    if (f.storageClass !== Types.StorageClass.STATIC) activate(f);
  }
  for (const v of unit.definedVariables) {
    if (v.storageClass !== Types.StorageClass.STATIC) activate(v);
  }
  // Seed global-scope usages
  for (const d of unit.globalUsedSymbols) activate(d);
  // Seed export directives
  for (const [, func] of unit.exportDirectives) activate(func);

  // Fixed-point walk
  while (worklist.length > 0) {
    const d = worklist.pop();
    if (d.declKind === Types.DeclKind.FUNC) {
      if (d.definition && d.definition !== d) activate(d.definition);
      for (const used of d.usedSymbols) activate(used);
    } else if (d.declKind === Types.DeclKind.VAR) {
      if (d.definition && d.definition !== d) activate(d.definition);
    }
  }

  // Filter all lists
  const filter = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!active.has(arr[i])) arr.splice(i, 1);
    }
  };
  filter(unit.importedFunctions);
  filter(unit.definedFunctions);
  filter(unit.staticFunctions);
  filter(unit.declaredFunctions);
  filter(unit.definedVariables);
  filter(unit.externVariables);
  filter(unit.localExternVariables);
  filter(unit.localDeclaredFunctions);
}

function gcSectionsPass(units, options) {
  const active = new Set();
  const worklist = [];
  const activate = (d) => { if (d && !active.has(d)) { active.add(d); worklist.push(d); } };

  for (const unit of units) {
    for (const f of unit.definedFunctions) {
      if (f.name === "main" || f.name === "alloca") activate(f);
    }
    if (!(options && options.gcNoExportRoots)) {
      for (const [, func] of unit.exportDirectives) activate(func);
    }
    for (const d of unit.globalUsedSymbols) activate(d);
  }

  while (worklist.length > 0) {
    const d = worklist.pop();
    if (d.declKind === Types.DeclKind.FUNC) {
      if (d.definition && d.definition !== d) activate(d.definition);
      for (const used of d.usedSymbols) activate(used);
    } else if (d.declKind === Types.DeclKind.VAR) {
      if (d.definition && d.definition !== d) activate(d.definition);
    }
  }

  const filter = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!active.has(arr[i])) arr.splice(i, 1);
    }
  };
  for (const unit of units) {
    filter(unit.importedFunctions);
    filter(unit.definedFunctions);
    filter(unit.staticFunctions);
    filter(unit.declaredFunctions);
    filter(unit.definedVariables);
    filter(unit.externVariables);
    filter(unit.localExternVariables);
    filter(unit.localDeclaredFunctions);
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
    if (decl.declKind === Types.DeclKind.VAR) {
      return decl.storageClass !== Types.StorageClass.EXTERN || decl.initExpr != null;
    } else if (decl.declKind === Types.DeclKind.FUNC) {
      return decl.body != null;
    }
    return false;
  }

  function isImportFunction(decl) {
    return decl.declKind === Types.DeclKind.FUNC && decl.storageClass === Types.StorageClass.IMPORT;
  }

  function getDeclType(decl) { return decl.type; }
  function getName(decl) { return decl.name; }

  function checkCompatibility(a, b) {
    const locs = [a.loc, b.loc].filter(l => l?.filename);
    if (a.declKind !== b.declKind) {
      addError(`declaration and definition kinds do not match for symbol '${getName(a)}'`, locs);
      return;
    }
    const ta = getDeclType(a), tb = getDeclType(b);
    if (ta && tb && !ta.isCompatibleWith(tb)) {
      addError(`conflicting types for '${getName(a)}' ('${ta.toString()}' vs '${tb.toString()}')`, locs);
    }
  }

  function setDefinition(decl, definition) {
    if (decl.declKind !== definition.declKind) return;
    if (decl.declKind === Types.DeclKind.VAR) {
      decl.definition = definition;
      // Propagate allocClass
      if (decl.allocClass === Types.AllocClass.MEMORY) {
        definition.allocClass = Types.AllocClass.MEMORY;
      }
    } else if (decl.declKind === Types.DeclKind.FUNC) {
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
      if (decl.declKind === Types.DeclKind.FUNC && decl.isInline &&
          existing.declKind === Types.DeclKind.FUNC && existing.isInline) {
        return;
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
        if (compilerOptions.allowUndefined && it.declKind === Types.DeclKind.FUNC) {
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
// Parser — ConstEval (simplified for parse-time)
// ====================

function constEvalInt(expr) {
  if (!expr) return null;
  switch (expr.kind) {
    case Types.ExprKind.INT: return expr.value;  // already BigInt
    case Types.ExprKind.IDENT:
      if (expr.decl && expr.decl.declKind === Types.DeclKind.ENUM_CONST) return expr.decl.value;
      return null;
    case Types.ExprKind.BINARY: {
      const l = constEvalInt(expr.left), r = constEvalInt(expr.right);
      if (l === null || r === null) return null;
      switch (expr.op) {
        case "ADD": return l + r; case "SUB": return l - r;
        case "MUL": return l * r; case "DIV": return r === 0n ? null : l / r;
        case "MOD": return r === 0n ? null : l % r;
        case "BAND": return l & r; case "BOR": return l | r; case "BXOR": return l ^ r;
        case "SHL": return l << r; case "SHR": return l >> r;
        case "EQ": return l === r ? 1n : 0n; case "NE": return l !== r ? 1n : 0n;
        case "LT": return l < r ? 1n : 0n; case "GT": return l > r ? 1n : 0n;
        case "LE": return l <= r ? 1n : 0n; case "GE": return l >= r ? 1n : 0n;
        case "LAND": return (l && r) ? 1n : 0n; case "LOR": return (l || r) ? 1n : 0n;
        default: return null;
      }
    }
    case Types.ExprKind.UNARY: {
      if (expr.op === "OP_ADDR") {
        // Support offsetof pattern: &((type*)0)->member
        const inner = expr.operand;
        if ((inner.kind === Types.ExprKind.ARROW || inner.kind === Types.ExprKind.MEMBER) && inner.memberDecl) {
          const base = constEvalInt(inner.base);
          if (base !== null) return base + BigInt(inner.memberDecl.byteOffset);
        }
        return null;
      }
      const v = constEvalInt(expr.operand);
      if (v === null) return null;
      switch (expr.op) {
        case "OP_POS": return v; case "OP_NEG": return -v;
        case "OP_LNOT": return v === 0n ? 1n : 0n; case "OP_BNOT": return ~v;
        default: return null;
      }
    }
    case Types.ExprKind.IMPLICIT_CAST: {
      return constEvalInt(expr.expr);
    }
    case Types.ExprKind.TERNARY: {
      const c = constEvalInt(expr.condition);
      if (c === null) return null;
      return constEvalInt(c !== 0n ? expr.thenExpr : expr.elseExpr);
    }
    case Types.ExprKind.CAST: {
      const v = constEvalInt(expr.expr);
      return v;
    }
    case Types.ExprKind.SIZEOF_EXPR: return BigInt(expr.expr.type.size);
    case Types.ExprKind.SIZEOF_TYPE: return BigInt(expr.operandType.size);
    case Types.ExprKind.ALIGNOF_EXPR: return BigInt(expr.expr.type.align);
    case Types.ExprKind.ALIGNOF_TYPE: return BigInt(expr.operandType.align);
    default: return null;
  }
}

// ====================
// Init list normalization helpers
// ====================

// Get VAR members of a tag, filtering out unnamed bitfields
function getVarMembers(tag) {
  const result = [];
  for (const m of tag.members) {
    if (m.declKind !== Types.DeclKind.VAR) continue;
    if (m.bitWidth >= 0 && !m.name) continue; // skip unnamed bitfields
    result.push(m);
  }
  return result;
}

// Recursively search for a named member in a tag, descending into
// anonymous struct/union members. Returns array of DVar* path, or null.
function findMemberChain(tag, name) {
  for (const m of tag.members) {
    if (m.declKind !== Types.DeclKind.VAR) continue;
    if (m.name === name) return [m];
    // Recurse into anonymous struct/union members
    if (!m.name && m.type.isTag() && m.type.tagDecl) {
      const sub = findMemberChain(m.type.tagDecl, name);
      if (sub) return [m, ...sub];
    }
  }
  return null;
}

// Normalize an init list: resolve designators, brace elision, zero-fill
function normalizeInitList(initList, containerType) {
  initList.type = containerType;

  // Save source elements and designators, then clear for output
  const src = initList.elements;
  const desigs = initList.designators;
  initList.elements = [];
  initList.designators = [];

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
    if (t.isFloatingPoint()) return new AST.EFloat(t, 0.0);
    return new AST.EInt(Types.TINT, 0n);
  }

  // Ensure output has a slot at index
  function ensureSlot(list, index) {
    while (list.elements.length <= index) list.elements.push(null);
  }

  // Ensure output[index] is a sub-EInitList for an aggregate child
  function ensureSubList(list, index, subType) {
    ensureSlot(list, index);
    if (!list.elements[index] || list.elements[index].kind !== Types.ExprKind.INIT_LIST) {
      const cc = childCount(subType);
      const elems = [];
      if (cc !== 0x7FFFFFFF && cc > 0) {
        for (let i = 0; i < cc; i++) elems.push(null);
      }
      list.elements[index] = new AST.EInitList(subType, elems);
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

  // Initialize root level
  const rootCount = childCount(containerType);
  if (rootCount !== 0x7FFFFFFF && rootCount > 0) {
    initList.elements = [];
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

      if (src[srcIdx].kind === Types.ExprKind.INIT_LIST) {
        // Braced sub-init-list: place and recurse
        top.output.elements[top.index] = src[srcIdx];
        normalizeInitList(top.output.elements[top.index], slotType);
        srcIdx++;
        if (top.index + 1 > maxExtent) maxExtent = top.index + 1;
        advanceCursor();
        break;
      } else if (src[srcIdx].kind === Types.ExprKind.STRING && slotType.isArray()) {
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

  // For unsized arrays, finalize type based on actual extent
  if (containerType.isArray() && (containerType.arraySize || 0) === 0) {
    const finalSize = Math.max(maxExtent, initList.elements.length);
    const elemType = containerType.baseType;
    initList.type = Types.arrayOf(elemType, finalSize);
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
            const sub = new AST.EInitList(elemType, []);
            list.elements[i] = sub;
            fillZeros(sub, elemType);
          } else {
            list.elements[i] = makeZero(elemType);
          }
        } else if (list.elements[i].kind === Types.ExprKind.INIT_LIST) {
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
              const sub = new AST.EInitList(mt, []);
              list.elements[i] = sub;
              fillZeros(sub, mt);
            } else {
              list.elements[i] = makeZero(mt);
            }
          } else if (list.elements[i].kind === Types.ExprKind.INIT_LIST) {
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
              const sub = new AST.EInitList(mt, []);
              list.elements[0] = sub;
              fillZeros(sub, mt);
            } else {
              list.elements[0] = makeZero(mt);
            }
          }
        } else if (list.elements[0].kind === Types.ExprKind.INIT_LIST) {
          const members = getVarMembers(tag);
          const umi = list.unionMemberIndex;
          if (umi >= 0 && umi < members.length) {
            fillZeros(list.elements[0], members[umi].type);
          }
        }
      }
    }
  }
  fillZeros(initList, initList.type);
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
    this.globalUsedSymbols = new Set();
    this.fileScopeCompoundLiterals = [];
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
  error(tok, msg) {
    const err = new Lexer.LexError(msg, tok.filename, tok.line);
    throw err;
  }
  recoverableError(tok, msg) {
    this.errors.push(new Lexer.LexError(msg, tok.filename, tok.line));
  }
  warning(tok, msg) {
    this.warnings.push(new Lexer.LexError(msg, tok.filename, tok.line));
  }

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
    if (t.kind === Lexer.TokenKind.IDENT && this.typeScope.has(t.text)) return true;
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
            this.error(this.peek(), `${mType.removeQualifiers().kind} cannot be used as a struct/union member`);
          }

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
            if (mType.size > 4) {
              this.error(this.peek(-1), "Bit-fields wider than 32 bits are not supported (use int or unsigned int)");
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
        const varMembers = members.filter(m => m.declKind === Types.DeclKind.VAR);
        for (let i = 0; i < varMembers.length; i++) {
          const mv = varMembers[i];
          if (mv.type.kind === Types.TypeKind.ARRAY && mv.type.arraySize === 0) {
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
        // Allow trailing `*` (collapses for GC ref types) for IDE-friendly
        // consistency with the preferred __struct Foo * spelling everywhere.
        while (this.matchText("*")) { /* collapse */ }
        this.expect(")");
        this.expect(";");
        if (!parentType.isGCStruct() || !parentType.isComplete) {
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
          if (mType.kind === Types.TypeKind.ARRAY) {
            this.error(this.peek(), "C arrays are not allowed as GC struct members; use __array(T) instead");
          }
          if (mType.kind === Types.TypeKind.FUNCTION) {
            this.error(this.peek(), "function types are not allowed as GC struct members");
          }
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
      this.tagScope.set(name, gcType);
      return gcType;
    }

    // Forward reference
    if (!name) this.error(this.peek(), "Expected GC struct name or '{'");
    let gcType = this.tagScope.get(name);
    if (!gcType || gcType.kind !== Types.TypeKind.GC_STRUCT) {
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
    if (elemType.kind === Types.TypeKind.ARRAY) {
      this.error(this.peek(), "C arrays are not allowed as __array element type");
    }
    if (elemType.kind === Types.TypeKind.FUNCTION) {
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
    if (innerType.kind === Types.TypeKind.POINTER) {
      const newBase = this.combineDeclaratorTypes(innerType.baseType, outerBase, outerResult);
      const result = newBase.pointer();
      if (innerType.isConst) return result.addConst();
      if (innerType.isVolatile) return result.addVolatile();
      return result;
    }
    if (innerType.kind === Types.TypeKind.ARRAY) {
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
      return new AST.EInt(type, val);
    }

    // Float literal
    if (t.kind === Lexer.TokenKind.FLOAT) {
      this.advance();
      let type = Types.TDOUBLE;
      if (t.flags.isFloat) type = Types.TFLOAT;
      else if (t.flags.isLong) type = Types.TLDOUBLE;
      return new AST.EFloat(type, t.floating);
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
      // Check __func__ / __FUNCTION__
      if ((name === "__func__" || name === "__FUNCTION__") && this.currentParsingFunc) {
        const funcName = this.currentParsingFunc.name;
        const bytes = [];
        for (let i = 0; i < funcName.length; i++) bytes.push(funcName.charCodeAt(i));
        bytes.push(0);
        return new AST.EString(Types.arrayOf(Types.TCHAR, bytes.length), bytes);
      }
      const decl = this.varScope.get(name);
      if (!decl) {
        // Implicit function declaration: C89 allowed calling undeclared functions.
        // Gated behind --allow-implicit-function-decl / --allow-old-c.
        if (this._allowImplicitFunctionDecl && this.atText("(")) {
          const ftype = Types.functionType(Types.TINT, [], false);
          const fdecl = new AST.DFunc({ filename: t.filename, line: t.line }, name, ftype, [], Types.StorageClass.EXTERN, false, null);
          this.varScope.set(name, fdecl);
          if (this.currentParsingFunc) this.currentParsingFunc.usedSymbols.add(fdecl);
          else this.globalUsedSymbols.add(fdecl);
          return new AST.EIdent(ftype, name, fdecl);
        }
        this.recoverableError(t, `Undeclared identifier '${name}'`);
        return new AST.EIdent(Types.TINT, name, null);
      }
      if (this.currentParsingFunc) this.currentParsingFunc.usedSymbols.add(decl);
      else this.globalUsedSymbols.add(decl);

      if (decl.declKind === Types.DeclKind.VAR) return new AST.EIdent(decl.type, name, decl);
      if (decl.declKind === Types.DeclKind.FUNC) return new AST.EIdent(decl.type, name, decl);
      if (decl.declKind === Types.DeclKind.ENUM_CONST) return new AST.EIdent(Types.TINT, name, decl);
      return new AST.EIdent(Types.TINT, name, decl);
    }

    // Parenthesized expression or compound literal
    if (t.kind === Lexer.TokenKind.PUNCT && t.text === "(") {
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
          const initList = this.parseInitList(castType);
          // Handle string-initialized char array
          if (castType.kind === Types.TypeKind.ARRAY && castType.arraySize === 0 &&
              initList.elements.length === 1 && initList.elements[0]?.kind === Types.ExprKind.STRING) {
            castType = initList.elements[0].type;
            initList.type = castType;
          } else if (castType.kind === Types.TypeKind.ARRAY && castType.arraySize === 0) {
            normalizeInitList(initList, castType);
            castType = initList.type;
          } else if (castType.isAggregate()) {
            normalizeInitList(initList, castType);
          }
          const cl = new AST.ECompoundLiteral(castType, initList);
          if (!this.currentParsingFunc) this.fileScopeCompoundLiterals.push(cl);
          else this.currentParsingFunc.compoundLiterals.push(cl);
          return cl;
        }
        // Cast expression
        const expr = this.parseCastExpression();
        // GCC extension: cast-to-union — (union_type) expr → compound literal
        if (castType.isUnion()) {
          const initList = new AST.EInitList(castType, [expr], []);
          normalizeInitList(initList, castType);
          const cl = new AST.ECompoundLiteral(castType, initList);
          if (!this.currentParsingFunc) this.fileScopeCompoundLiterals.push(cl);
          else this.currentParsingFunc.compoundLiterals.push(cl);
          return cl;
        }
        return new AST.ECast(castType, castType, expr);
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
          if (sType.removeQualifiers().isRef()) this.error(this.peek(-1), `sizeof(${sType.removeQualifiers().kind}) is not allowed`);
          return new AST.ESizeofType(Types.TULONG, sType);
        }
        const expr = this.parseExpression();
        this.expect(")");
        return new AST.ESizeofExpr(Types.TULONG, expr);
      }
      const expr = this.parseUnaryExpression();
      return new AST.ESizeofExpr(Types.TULONG, expr);
    }

    // _Alignof
    if (this.atKW(Lexer.Keyword.ALIGNOF)) {
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
        if (aType.kind === Types.TypeKind.FUNCTION) {
          this.error(this.peek(-1), "_Alignof cannot be applied to a function type");
        }
        if (!aType.isComplete) {
          this.error(this.peek(-1), "_Alignof cannot be applied to incomplete type '" + aType.toString() + "'");
        }
        return new AST.EAlignofType(Types.TULONG, aType);
      }
      const expr = this.parseExpression();
      this.expect(")");
      return new AST.EAlignofExpr(Types.TULONG, expr);
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

    // __new(type, args...)
    if (this.matchKW(Lexer.Keyword.X_NEW)) {
      const newTok = this.peek(-1);
      this.expect("(");
      if (!this.isTypeName()) this.error(this.peek(), "__new requires a type as the first argument");
      const specs = this.parseDeclSpecifiers();
      let nType = specs.type;
      if (this.atText("*") || this.atText("[") || this.atText("(")) {
        const decl = this.parseDeclarator(nType);
        nType = decl.type;
      }
      const nq = nType.removeQualifiers();
      if (!nq.isGCRef()) {
        this.error(newTok, `__new requires a GC type (__struct or __array), got '${nType.toString()}'`);
      }
      const args = [];
      while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      this.expect(")");
      // Validate arg count
      if (nq.isGCStruct()) {
        if (!nq.isComplete) this.error(newTok, `__new of incomplete GC struct '${nq.tagName}'`);
        const fields = nq.tagDecl.members;
        if (args.length !== 0 && args.length !== fields.length) {
          this.error(newTok, `__new(__struct ${nq.tagName}, ...): expected ${fields.length} field args, got ${args.length}`);
        }
        // Reject implicit non-zero int → non-eqref ref field (silent-null bug).
        for (let i = 0; i < args.length; i++) {
          this._rejectNonZeroToRef(fields[i].type, args[i], newTok);
        }
      } else {
        // GC_ARRAY: __new(__array(T), length) or __new(__array(T), length, init)
        if (args.length < 1 || args.length > 2) {
          this.error(newTok, `__new(__array(...), ...): expected length [, init], got ${args.length} args`);
        }
        // Reject non-zero int as fill value when element type is a non-eqref ref.
        if (args.length === 2) this._rejectNonZeroToRef(nq.baseType, args[1], newTok);
      }
      return new AST.EGCNew(nq, args);
    }

    // __memory_size, __memory_grow
    if (this.matchKW(Lexer.Keyword.X_MEMORY_SIZE)) {
      this.expect("(");
      this.expect(")");
      return new AST.EIntrinsic(Types.TULONG, Types.IntrinsicKind.MEMORY_SIZE, []);
    }
    if (this.matchKW(Lexer.Keyword.X_MEMORY_GROW)) {
      this.expect("(");
      const arg = this.parseAssignmentExpression();
      this.expect(")");
      return new AST.EIntrinsic(Types.TULONG, Types.IntrinsicKind.MEMORY_GROW, [arg]);
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
      return new AST.EIntrinsic(Types.TINT, Types.IntrinsicKind.REF_IS_NULL, [arg]);
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
      return new AST.EIntrinsic(Types.TINT, Types.IntrinsicKind.REF_EQ, [a, b]);
    }

    // __ref_null(type) — produces a null of the given reference type
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
      if (!nq.isRef()) {
        this.error(tok, `__ref_null requires a reference type, got '${nType.toString()}'`);
      }
      if (nq === Types.TREFEXTERN) {
        this.error(tok, `__ref_null(__refextern) is not allowed — non-nullable refs cannot be null; use __externref instead`);
      }
      return new AST.EIntrinsic(nq, Types.IntrinsicKind.REF_NULL, [], nq);
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
        if (!this.isTypeName()) this.error(tok, `${opName} requires a target reference type`);
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
        if (tq === Types.TEQREF || !tq.isGCRef()) {
          this.error(tok, `${opName} target must be a concrete __struct or __array type, got '${tType.toString()}'`);
        }
        if (!refExpr.type.removeQualifiers().isGCRef()) {
          this.error(tok, `${opName} second argument must be a GC-universe ref, got '${refExpr.type.toString()}'`);
        }
        const kind = isNullable ? Types.IntrinsicKind.REF_TEST_NULL : Types.IntrinsicKind.REF_TEST;
        return new AST.EIntrinsic(Types.TINT, kind, [refExpr], tq);
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
        if (!this.isTypeName()) this.error(tok, `${opName} requires a target reference type`);
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
        if (tq === Types.TEQREF || !tq.isGCRef()) {
          this.error(tok, `${opName} target must be a concrete __struct or __array type, got '${tType.toString()}'`);
        }
        if (!refExpr.type.removeQualifiers().isGCRef()) {
          this.error(tok, `${opName} second argument must be a GC-universe ref, got '${refExpr.type.toString()}'`);
        }
        const kind = isNullable ? Types.IntrinsicKind.REF_CAST_NULL : Types.IntrinsicKind.REF_CAST;
        return new AST.EIntrinsic(tq, kind, [refExpr], tq);
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
      return new AST.EIntrinsic(Types.TINT, Types.IntrinsicKind.ARRAY_LEN, [arg]);
    }

    // __new_array(elemType, v1, v2, ...) — array.new_fixed
    if (this.matchKW(Lexer.Keyword.X_NEW_ARRAY)) {
      const tok = this.peek(-1);
      this.expect("(");
      if (!this.isTypeName()) this.error(tok, "__new_array first argument must be the element type");
      const specs = this.parseDeclSpecifiers();
      let elemType = specs.type;
      if (this.atText("*") || this.atText("[") || this.atText("(")) {
        const decl = this.parseDeclarator(elemType);
        elemType = decl.type;
      }
      const args = [];
      while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      this.expect(")");
      if (elemType.kind === Types.TypeKind.ARRAY || elemType.kind === Types.TypeKind.FUNCTION) {
        this.error(tok, `__new_array element type must not be a C array or function`);
      }
      // Reject implicit non-zero int → non-eqref ref element (silent-null bug).
      for (let i = 0; i < args.length; i++) {
        this._rejectNonZeroToRef(elemType, args[i], tok);
      }
      const arrType = Types.gcArrayOf(elemType);
      return new AST.EIntrinsic(arrType, Types.IntrinsicKind.GC_NEW_ARRAY, args, elemType);
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
      this._rejectNonZeroToRef(elemType, val, tok);
      return new AST.EIntrinsic(Types.TVOID, Types.IntrinsicKind.ARRAY_FILL, [arr, off, val, count]);
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
      return new AST.EIntrinsic(Types.TEXTERNREF, Types.IntrinsicKind.REF_AS_EXTERN, [arg]);
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
      return new AST.EIntrinsic(Types.TEQREF, Types.IntrinsicKind.REF_AS_EQ, [arg]);
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
      const sq = expr.type.removeQualifiers();
      // Validate combinations at parse time. The codegen path handles the
      // mechanics; here we just reject combos that don't have a defined
      // conversion (e.g. prim ↔ extern, prim → GC struct, etc.).
      const isPrim = (t) => t.isArithmetic();
      const isEqref = (t) => t === Types.TEQREF;
      const isExternref = (t) => t === Types.TEXTERNREF || t === Types.TREFEXTERN;
      const ok = (sq === tq) ||
        (isPrim(sq) && isPrim(tq)) ||
        (isPrim(sq) && isEqref(tq)) ||                        // box
        (isEqref(sq) && isPrim(tq)) ||                        // unbox
        (sq.isGCRef() && isEqref(tq)) ||                      // upcast
        (isEqref(sq) && tq.isGCRef()) ||                      // downcast
        (sq.isGCRef() && tq.isGCRef()) ||                      // GC sidecast/downcast
        (sq.isGCRef() && isExternref(tq)) ||                   // GC → extern bridge
        (isExternref(sq) && tq === Types.TEQREF);             // extern → any bridge
      if (!ok) {
        this.error(tok,
          `__cast: no conversion defined from '${expr.type.toString()}' to '${tType.toString()}'`);
      }
      return new AST.EIntrinsic(tq, Types.IntrinsicKind.CAST, [expr], tq);
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
      return new AST.EIntrinsic(Types.TVOID, Types.IntrinsicKind.ARRAY_COPY, [dst, dstOff, src, srcOff, count]);
    }

    // __builtin(kind, args...)
    if (this.matchKW(Lexer.Keyword.X_BUILTIN)) {
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
      return new AST.EIntrinsic(retType, ik, args);
    }

    // __wasm(type, (args...), instruction, ...)
    if (this.matchKW(Lexer.Keyword.X_WASM)) {
      this.expect("(");
      const retSpecs = this.parseDeclSpecifiers();
      let retType = retSpecs.type;
      while (this.matchText("*")) retType = retType.pointer();
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
      return new AST.EWasm(retType, args, bytes);
    }

    // _Generic
    if (this.matchKW(Lexer.Keyword.GENERIC)) {
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
      return result || defaultExpr || new AST.EInt(Types.TINT, 0n);
    }

    this.error(t, `Unexpected token in expression: ${t.kind} '${t.text}'`);
  }

  parseStringLiteral() {
    // Determine string prefix from first token
    let prefix = this.peek().flags.stringPrefix || Lexer.StringPrefix.NONE;
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
      return new AST.EString(Types.arrayOf(Types.TUSHORT, elemCount), bytes);
    }
    if (prefix === Lexer.StringPrefix.PREFIX_L) {
      // UTF-32 string: element type is int (wchar_t)
      const bytes = [];
      for (const cp of codepoints) Lexer.encodeUtf32LE(cp, bytes);
      bytes.push(0); bytes.push(0); bytes.push(0); bytes.push(0); // null terminator (4 bytes)
      const elemCount = bytes.length / 4;
      return new AST.EString(Types.arrayOf(Types.TINT, elemCount), bytes);
    }
    if (prefix === Lexer.StringPrefix.PREFIX_U) {
      // UTF-32 string: element type is unsigned int (char32_t)
      const bytes = [];
      for (const cp of codepoints) Lexer.encodeUtf32LE(cp, bytes);
      bytes.push(0); bytes.push(0); bytes.push(0); bytes.push(0); // null terminator (4 bytes)
      const elemCount = bytes.length / 4;
      return new AST.EString(Types.arrayOf(Types.TUINT, elemCount), bytes);
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
    return new AST.EString(Types.arrayOf(Types.TCHAR, bytes.length), bytes);
  }

  parseIntrinsic(ikind) {
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
    return new AST.EIntrinsic(retType, ikind, args);
  }

  parseVaArg() {
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
    return new AST.EIntrinsic(argType, Types.IntrinsicKind.VA_ARG, [ap], argType);
  }

  // Matches CC's parsePostfixExpression (compiler.cc ~line 10495)
  parsePostfixExpression() {
    const expr = this.parsePrimaryExpression();
    return this.parsePostfixTail(expr);
  }

  _rejectRefAsCondition(expr, tok, ctxName) {
    // Refs in boolean context are now allowed as sugar for !__ref_is_null.
    // Helper retained as a no-op so existing call sites need no edits.
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
    if (initExpr.kind === Types.ExprKind.INIT_LIST) {
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

  // Allow null pointer constants (literal 0 / NULL) as the only non-ref
  // value implicitly convertible to a ref. Anything else errors with a
  // helpful pointer to __ref_null.
  _isNullPointerConstant(expr) {
    if (!expr) return false;
    if (expr.kind === Types.ExprKind.INT && expr.value === 0n) return true;
    // Strip implicit casts and re-check (handles things like ((void*)0) which
    // our preprocessor may surface as a CAST expression around 0).
    if (expr.kind === Types.ExprKind.IMPLICIT_CAST || expr.kind === Types.ExprKind.CAST) {
      return this._isNullPointerConstant(expr.expr);
    }
    return false;
  }
  _rejectNonZeroToRef(targetType, expr, tok) {
    if (!expr || !targetType) return;
    const t = targetType.removeQualifiers();
    const s = expr.type.removeQualifiers();
    if (!t.isRef() || s.isRef()) return;
    if (this._isNullPointerConstant(expr)) return;
    // Implicit prim → __eqref boxing is allowed (codegen auto-allocates a
    // box struct). For other ref types (struct/array/extern), boxing is
    // ambiguous and the user must use __cast or __ref_null explicitly.
    if (t === Types.TEQREF && s.isArithmetic()) return;
    this.error(tok, `cannot convert '${expr.type.toString()}' to reference type '${targetType.toString()}' (use __cast(${targetType.toString()}, x) for an explicit conversion, or __ref_null for null)`);
  }
  // Backward-compat alias used elsewhere in parser.
  _rejectIntToRef(targetType, expr, tok) { this._rejectNonZeroToRef(targetType, expr, tok); }

  lookupMemberChain(type, name) {
    const ut = type.removeQualifiers();
    if (ut.tagDecl && ut.tagDecl.members) {
      for (const m of ut.tagDecl.members) {
        if (m.declKind !== Types.DeclKind.VAR) continue;
        if (m.name === name) return [m];
        // Recurse into anonymous struct/union members
        if (!m.name && m.type && m.type.tagDecl && m.type.tagDecl.members) {
          const sub = this.lookupMemberChain(m.type, name);
          if (sub) return [m, ...sub];
        }
      }
    }
    return null;
  }

  lookupMember(type, name) {
    const chain = this.lookupMemberChain(type, name);
    if (chain && chain.length > 0) {
      const last = chain[chain.length - 1];
      return { type: last.type, decl: last, chain };
    }
    return { type: Types.TINT, decl: null, chain: null };
  }

  markAddressTaken(expr) {
    if (!expr) return;
    if (expr.kind === Types.ExprKind.IDENT) {
      if (expr.decl && expr.decl.declKind === Types.DeclKind.VAR) {
        expr.decl.allocClass = Types.AllocClass.MEMORY;
      }
    } else if (expr.kind === Types.ExprKind.MEMBER) {
      this.markAddressTaken(expr.base);
    } else if (expr.kind === Types.ExprKind.SUBSCRIPT) {
      if (expr.array.type && expr.array.type.isArray()) {
        this.markAddressTaken(expr.array);
      }
    }
  }

  // Matches CC's parseUnaryExpression (compiler.cc ~line 10538)
  parseUnaryExpression() {
    if (this.matchText("++")) {
      const tok = this.peek(-1);
      const e = this.parseUnaryExpression();
      if (e.type && e.type.removeQualifiers().isRef()) this.error(tok, `'++' on reference type is not allowed`);
      return new AST.EUnary(Types.computeUnaryType("OP_PRE_INC", e.type), "OP_PRE_INC", e);
    }
    if (this.matchText("--")) {
      const tok = this.peek(-1);
      const e = this.parseUnaryExpression();
      if (e.type && e.type.removeQualifiers().isRef()) this.error(tok, `'--' on reference type is not allowed`);
      return new AST.EUnary(Types.computeUnaryType("OP_PRE_DEC", e.type), "OP_PRE_DEC", e);
    }
    if (this.matchText("&")) {
      const e = this.parseCastExpression();
      if ((e.kind === Types.ExprKind.MEMBER || e.kind === Types.ExprKind.ARROW) && e.memberDecl && e.memberDecl.bitWidth >= 0) {
        this.error(this.peek(-1), `Cannot take address of bit-field member '${e.memberDecl.name}'`);
      }
      if (e.type && e.type.removeQualifiers().isRef()) {
        this.error(this.peek(-1), `Cannot take address of ${e.type.removeQualifiers().kind} variable`);
      }
      if (e.kind === Types.ExprKind.MEMBER && e.base && e.base.type && e.base.type.removeQualifiers().isGCStruct()) {
        this.error(this.peek(-1), `cannot take address of GC struct field`);
      }
      if (e.kind === Types.ExprKind.SUBSCRIPT && e.array && e.array.type && e.array.type.removeQualifiers().isGCArray()) {
        this.error(this.peek(-1), `cannot take address of GC array element`);
      }
      this.markAddressTaken(e); return new AST.EUnary(Types.computeUnaryType("OP_ADDR", e.type), "OP_ADDR", e);
    }
    if (this.matchText("*")) {
      const tok = this.peek(-1);
      const e = this.parseCastExpression();
      if (e.type && e.type.removeQualifiers().isRef()) {
        this.error(tok, `unary '*' on reference type '${e.type.toString()}' is not allowed (use '->' for fields, or just access the ref directly)`);
      }
      return new AST.EUnary(Types.computeUnaryType("OP_DEREF", e.type), "OP_DEREF", e);
    }
    if (this.matchText("+")) {
      const tok = this.peek(-1);
      const e = this.parseCastExpression();
      if (e.type && e.type.removeQualifiers().isRef()) this.error(tok, `unary '+' on reference type is not allowed`);
      return new AST.EUnary(Types.computeUnaryType("OP_POS", e.type), "OP_POS", e);
    }
    if (this.matchText("-")) {
      const tok = this.peek(-1);
      const e = this.parseCastExpression();
      if (e.type && e.type.removeQualifiers().isRef()) this.error(tok, `unary '-' on reference type is not allowed`);
      return new AST.EUnary(Types.computeUnaryType("OP_NEG", e.type), "OP_NEG", e);
    }
    if (this.matchText("~")) {
      const tok = this.peek(-1);
      const e = this.parseCastExpression();
      if (e.type && e.type.removeQualifiers().isRef()) this.error(tok, `unary '~' on reference type is not allowed`);
      return new AST.EUnary(Types.computeUnaryType("OP_BNOT", e.type), "OP_BNOT", e);
    }
    if (this.matchText("!")) {
      const e = this.parseCastExpression();
      // `!ref` is equivalent to __ref_is_null(ref). Allowed as sugar.
      return new AST.EUnary(Types.computeUnaryType("OP_LNOT", e.type), "OP_LNOT", e);
    }

    if (this.atKW(Lexer.Keyword.SIZEOF)) return this.parsePrimaryExpression(); // handled there
    if (this.atKW(Lexer.Keyword.ALIGNOF)) return this.parsePrimaryExpression();

    return this.parsePostfixExpression();
  }

  parseCastExpression() {
    if (this.atText("(")) {
      // Look ahead: is this a cast or a parenthesized expression?
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
          if (this.atText("{")) {
            // Compound literal: (type){...}
            const initList = this.parseInitList(castType);
            // Handle string-initialized char array
            if (castType.kind === Types.TypeKind.ARRAY && castType.arraySize === 0 &&
                initList.elements.length === 1 && initList.elements[0]?.kind === Types.ExprKind.STRING) {
              castType = initList.elements[0].type;
              initList.type = castType;
            } else if (castType.kind === Types.TypeKind.ARRAY && castType.arraySize === 0) {
              normalizeInitList(initList, castType);
              castType = initList.type;
            } else if (castType.isAggregate()) {
              normalizeInitList(initList, castType);
            }
            const cl = new AST.ECompoundLiteral(castType, initList);
            if (!this.currentParsingFunc) this.fileScopeCompoundLiterals.push(cl);
            else this.currentParsingFunc.compoundLiterals.push(cl);
            return this.parsePostfixTail(cl);
          }
          const expr = this.parseCastExpression();
          // GCC extension: cast-to-union — (union_type) expr → compound literal
          if (castType.isUnion()) {
            const initList = new AST.EInitList(castType, [expr], []);
            normalizeInitList(initList, castType);
            const cl = new AST.ECompoundLiteral(castType, initList);
            if (!this.currentParsingFunc) this.fileScopeCompoundLiterals.push(cl);
            else this.currentParsingFunc.compoundLiterals.push(cl);
            return this.parsePostfixTail(cl);
          }
          if (castType.removeQualifiers().isRef() || (expr.type && expr.type.removeQualifiers().isRef())) {
            // Allow `(refT)0` / `(refT)NULL` — typed null pointer constant
            // is a long-standing C idiom and unambiguous.
            if (castType.removeQualifiers().isRef() &&
                !(expr.type && expr.type.removeQualifiers().isRef()) &&
                this._isNullPointerConstant(expr)) {
              return new AST.ECast(castType, castType, expr);
            }
            this.error(this.peek(-1), "Cannot cast to or from a reference type; use __cast(T, x) (or __ref_cast for GC ref downcast)");
          }
          return new AST.ECast(castType, castType, expr);
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

        let resultType = Types.TINT;
        let calleeType = expr.type;
        if (calleeType.kind === Types.TypeKind.ARRAY || calleeType.kind === Types.TypeKind.FUNCTION) calleeType = calleeType.decay();
        let calleeFuncType = null;
        if (calleeType.kind === Types.TypeKind.FUNCTION) {
          resultType = calleeType.returnType;
          calleeFuncType = calleeType;
        } else if (calleeType.kind === Types.TypeKind.POINTER && calleeType.baseType.kind === Types.TypeKind.FUNCTION) {
          resultType = calleeType.baseType.returnType;
          calleeFuncType = calleeType.baseType;
        }
        // Forbid implicit int→ref on call arguments. Only check declared
        // params (variadic / unspecified-params functions have no arg types).
        if (calleeFuncType && !calleeFuncType.hasUnspecifiedParams) {
          const params = calleeFuncType.getParamTypes();
          const n = Math.min(args.length, params.length);
          for (let i = 0; i < n; i++) this._rejectIntToRef(params[i], args[i], callTok);
          // Reject ref-typed vararg arguments — vararg storage uses linear
          // memory which can't hold GC references.
          if (calleeFuncType.isVarArg) {
            for (let i = params.length; i < args.length; i++) {
              if (args[i].type.removeQualifiers().isRef()) {
                this.error(callTok,
                  `cannot pass reference type '${args[i].type.toString()}' as a variadic argument — vararg storage uses linear memory which can't hold GC references`);
              }
            }
          }
        }

        let funcDecl = null;
        if (expr.kind === Types.ExprKind.IDENT && expr.decl && expr.decl.declKind === Types.DeclKind.FUNC) {
          funcDecl = expr.decl;
        }

        expr = new AST.ECall(resultType, expr, args, funcDecl);
        continue;
      }
      if (this.matchText("[")) {
        const index = this.parseExpression();
        this.expect("]");
        const baseUt = expr.type.removeQualifiers();
        const idxUt = index.type.removeQualifiers();
        if (baseUt.isInteger() && (idxUt.kind === Types.TypeKind.POINTER || idxUt.kind === Types.TypeKind.ARRAY)) {
          this.error(this.peek(-1), "Commutative subscript (e.g. 0[arr]) is not supported; write arr[0] instead");
        }
        let elemType = Types.TINT;
        if (baseUt.kind === Types.TypeKind.ARRAY) elemType = baseUt.baseType;
        else if (baseUt.kind === Types.TypeKind.POINTER) elemType = baseUt.baseType;
        else if (baseUt.kind === Types.TypeKind.GC_ARRAY) elemType = baseUt.baseType;
        else if (baseUt.isRef()) {
          this.error(this.peek(-1), `subscript '[]' on reference type '${expr.type.toString()}' is not allowed (use __array(T) for indexable GC storage)`);
        }
        expr = new AST.ESubscript(elemType, expr, index);
        continue;
      }
      if (this.matchText(".")) {
        const name = this.expectKind(Lexer.TokenKind.IDENT).text;
        const { chain } = this.lookupMember(expr.type, name);
        if (chain) {
          for (const mVar of chain) {
            expr = new AST.EMember(mVar.type, expr, mVar.name, mVar);
          }
        } else {
          expr = new AST.EMember(Types.TINT, expr, name, null);
        }
        continue;
      }
      if (this.matchText("->")) {
        const name = this.expectKind(Lexer.TokenKind.IDENT).text;
        let bt = expr.type.removeQualifiers();
        // GC ref types are already "one indirection" semantically — `p->x` on
        // a __struct ref is equivalent to `p.x`. Build EMember instead of
        // EArrow so codegen takes the GC-struct member path.
        if (bt.kind === Types.TypeKind.GC_STRUCT) {
          const { chain } = this.lookupMember(bt, name);
          if (chain) {
            for (const m of chain) expr = new AST.EMember(m.type, expr, m.name, m);
          } else {
            expr = new AST.EMember(Types.TINT, expr, name, null);
          }
          continue;
        }
        if (bt.kind === Types.TypeKind.ARRAY) bt = bt.baseType;
        else if (bt.kind === Types.TypeKind.POINTER) bt = bt.baseType;
        const { chain } = this.lookupMember(bt, name);
        if (chain) {
          // First element: arrow (dereference pointer)
          const first = chain[0];
          expr = new AST.EArrow(first.type, expr, first.name, first);
          // Remaining: member access (traverse anonymous structs)
          for (let i = 1; i < chain.length; i++) {
            expr = new AST.EMember(chain[i].type, expr, chain[i].name, chain[i]);
          }
        } else {
          expr = new AST.EArrow(Types.TINT, expr, name, null);
        }
        continue;
      }
      if (this.matchText("++")) {
        if (expr.type && expr.type.removeQualifiers().isRef()) this.error(this.peek(-1), `'++' on reference type is not allowed`);
        expr = new AST.EUnary(expr.type, "OP_POST_INC", expr);
        continue;
      }
      if (this.matchText("--")) {
        if (expr.type && expr.type.removeQualifiers().isRef()) this.error(this.peek(-1), `'--' on reference type is not allowed`);
        expr = new AST.EUnary(expr.type, "OP_POST_DEC", expr);
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
  promoteExprType(e) {
    const t = e.type;
    let bf = null;
    if (e.kind === Types.ExprKind.MEMBER && e.memberDecl && e.memberDecl.bitWidth >= 0) {
      bf = e.memberDecl;
    } else if (e.kind === Types.ExprKind.ARROW && e.memberDecl && e.memberDecl.bitWidth >= 0) {
      bf = e.memberDecl;
    }
    if (bf) {
      const bw = bf.bitWidth;
      const uq = t.removeQualifiers();
      const isSigned = uq === Types.TINT || uq === Types.TLONG || uq === Types.TSHORT || uq === Types.TSCHAR || uq === Types.TCHAR;
      // If the bitfield fits in a signed int (32-bit), promote to int
      if (isSigned || bw < 32) return Types.TINT;
      return Types.TUINT;
    }
    return t;
  }

  computeBinaryType(op, leftType, rightType) {
    // Comparison and logical operators return int
    if (["EQ","NE","LT","GT","LE","GE","LAND","LOR"].includes(op)) return Types.TINT;
    // Assignment operators return left type
    if (op.endsWith("ASSIGN") || op === "ASSIGN") return leftType;
    // Shift operators: result type is the promoted left operand type
    // (C99 6.5.7). Must strip qualifiers before checking for small types.
    if (op === "SHL" || op === "SHR") {
      const uq = leftType.removeQualifiers();
      if (uq === Types.TCHAR || uq === Types.TSCHAR || uq === Types.TUCHAR ||
          uq === Types.TSHORT || uq === Types.TUSHORT || uq === Types.TBOOL) {
        return Types.TINT;
      }
      return uq;
    }
    // Pointer arithmetic
    if (leftType.isPointer() && rightType.isInteger()) return leftType;
    if (rightType.isPointer() && leftType.isInteger() && op === "ADD") return rightType;
    if (leftType.isPointer() && rightType.isPointer() && op === "SUB") return Types.TLONG;
    // Array arithmetic (array decays to pointer)
    if (leftType.isArray() && rightType.isInteger()) return leftType.decay();
    if (rightType.isArray() && leftType.isInteger() && op === "ADD") return rightType.decay();
    if (op === "SUB" && ((leftType.isPointer() && rightType.isArray()) ||
        (leftType.isArray() && rightType.isPointer()))) return Types.TLONG;
    return Types.usualArithmeticConversions(leftType, rightType);
  }

  inferArraySizeFromInit(arrayType, initExpr) {
    const elemSize = arrayType.baseType.size || 1;
    if (initExpr.kind === Types.ExprKind.STRING) {
      return Types.arrayOf(arrayType.baseType, initExpr.value.length / elemSize);
    }
    if (initExpr.kind === Types.ExprKind.INIT_LIST) {
      // For char/short/int arrays initialized with a single string literal
      const bt = arrayType.baseType.removeQualifiers();
      if ((bt === Types.TCHAR || bt === Types.TSCHAR || bt === Types.TUCHAR ||
           bt === Types.TSHORT || bt === Types.TUSHORT || bt === Types.TINT || bt === Types.TUINT) &&
          initExpr.elements.length === 1 &&
          initExpr.elements[0].kind === Types.ExprKind.STRING) {
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
    if (thenType.isPointer() && elseType.isPointer()) return thenType;
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
        this._rejectRefAsCondition(left, opTok, "ternary");
        const thenExpr = this.parseExpression();
        this.expect(":");
        const elseExpr = this.parseBinaryExpression(3);
        let resType = this.computeTernaryType(thenExpr.type, elseExpr.type);
        left = new AST.ETernary(resType, left, thenExpr, elseExpr);
        continue;
      }

      // Comma operator
      if (op === ",") {
        const exprs = [left];
        exprs.push(this.parseBinaryExpression(2)); // above comma precedence
        while (this.matchText(",")) {
          exprs.push(this.parseBinaryExpression(2));
        }
        left = new AST.EComma(exprs[exprs.length - 1].type, exprs);
        continue;
      }

      const nextMinPrec = this.isRightAssociative(op) ? prec : prec + 1;
      const right = this.parseBinaryExpression(nextMinPrec);
      const bop = this.textToBop(op);
      if (this.warningFlags.pointerDecay && (bop === "ADD" || bop === "SUB")) {
        if ((left.type.isArray() && right.type.isInteger()) ||
            (right.type.isArray() && left.type.isInteger())) {
          this.warning(this.peek(-1), "array used in arithmetic expression; decaying to pointer");
        }
      }
      // Refs are allowed in == / != (null compare against literal 0, or
      // identity between two refs) and in &&/|| (boolean coercion via
      // ref.is_null). Relational operators have no meaning on refs.
      const lIsRef = left.type.removeQualifiers().isRef();
      const rIsRef = right.type.removeQualifiers().isRef();
      if (lIsRef || rIsRef) {
        if (bop === "LT" || bop === "GT" || bop === "LE" || bop === "GE") {
          this.error(opTok, `'${op}' on reference type is not allowed (only ==, != for identity/null)`);
        }
        // Arithmetic/bitwise/shift/logical-bit ops have no meaning on refs.
        // Allow only: ASSIGN (the rejection rules below catch bad RHS), ==/!=
        // (identity/null), and &&/|| (boolean coercion sugar).
        if (bop === "ADD" || bop === "SUB" || bop === "MUL" || bop === "DIV" ||
            bop === "MOD" || bop === "SHL" || bop === "SHR" ||
            bop === "BAND" || bop === "BOR" || bop === "BXOR") {
          this.error(opTok, `'${op}' on reference type is not allowed`);
        }
        // For ==/!= involving refs: must be ref-vs-ref OR ref-vs-(null pointer constant).
        if (bop === "EQ" || bop === "NE") {
          if (lIsRef !== rIsRef && !this._isNullPointerConstant(lIsRef ? right : left)) {
            this.error(opTok,
              `'${op}' between reference and non-reference requires the non-ref operand to be the literal 0 / NULL`);
          }
        }
      }
      // Assignment to ref: only literal 0 (or null pointer constant) is
      // allowed as a non-ref source. _rejectIntToRefAssign handles this.
      if (bop === "ASSIGN" && lIsRef && !rIsRef) {
        this._rejectNonZeroToRef(left.type, right, opTok);
      }
      // Compound assignment (+=, -=, *=, etc.) has no meaning on ref types.
      if (lIsRef &&
          (bop === "ADD_ASSIGN" || bop === "SUB_ASSIGN" || bop === "MUL_ASSIGN" ||
           bop === "DIV_ASSIGN" || bop === "MOD_ASSIGN" || bop === "SHL_ASSIGN" ||
           bop === "SHR_ASSIGN" || bop === "BAND_ASSIGN" || bop === "BXOR_ASSIGN" ||
           bop === "BOR_ASSIGN")) {
        this.error(opTok, `'${op}' on reference type is not allowed`);
      }
      // Apply C99 6.3.1.1 integer promotions for bitfield operands
      const resType = this.computeBinaryType(bop, this.promoteExprType(left), this.promoteExprType(right));
      left = new AST.EBinary(resType, bop, left, right);
    }
    return left;
  }

  parseAssignmentExpression() { return this.parseBinaryExpression(2); }
  parseExpression() { return this.parseBinaryExpression(1); }

  // --- Init list parsing ---
  parseInitList(type) {
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
          if (type.kind === Types.TypeKind.ARRAY) elemType = type.baseType;
          else if (type.kind === Types.TypeKind.TAG && type.tagDecl && type.tagDecl.members) {
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
    return new AST.EInitList(type, elements, hasDesignators ? designators : null);
  }

  // --- Statement parsing ---

  parseStatement() {
    const tok = this.peek();
    const stmt = this._parseStatement();
    if (stmt && !stmt.loc && tok) stmt.loc = { filename: tok.filename, line: tok.line };
    return stmt;
  }

  _parseStatement() {
    // Empty statement
    if (this.matchText(";")) return new AST.SEmpty();

    // Compound statement
    if (this.atText("{")) return this.parseCompoundStatement();

    // if
    if (this.matchKW(Lexer.Keyword.IF)) {
      const kwTok = this.peek(-1);
      this.expect("(");
      const cond = this.parseExpression();
      this._rejectRefAsCondition(cond, kwTok, "if");
      this.expect(")");
      const thenBranch = this.parseStatement();
      let elseBranch = null;
      if (this.matchKW(Lexer.Keyword.ELSE)) elseBranch = this.parseStatement();
      return new AST.SIf(cond, thenBranch, elseBranch);
    }

    // while
    if (this.matchKW(Lexer.Keyword.WHILE)) {
      const kwTok = this.peek(-1);
      this.expect("(");
      const cond = this.parseExpression();
      this._rejectRefAsCondition(cond, kwTok, "while");
      this.expect(")");
      return new AST.SWhile(cond, this.parseStatement());
    }

    // do-while
    if (this.matchKW(Lexer.Keyword.DO)) {
      const kwTok = this.peek(-1);
      const body = this.parseStatement();
      this.expectKW(Lexer.Keyword.WHILE);
      this.expect("(");
      const cond = this.parseExpression();
      this._rejectRefAsCondition(cond, kwTok, "do-while");
      this.expect(")");
      this.expect(";");
      return new AST.SDoWhile(body, cond);
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
          const e = this.parseExpression();
          this.expect(";");
          init = new AST.SExpr(e);
        }
      }
      if (!this.matchText(";")) {
        cond = this.parseExpression();
        this._rejectRefAsCondition(cond, kwTok, "for");
        this.expect(";");
      }
      if (!this.atText(")")) incr = this.parseExpression();
      this.expect(")");
      const body = this.parseStatement();
      this.typeScope.pop(); this.tagScope.pop(); this.varScope.pop();
      return new AST.SFor(init, cond, incr, body);
    }

    // switch
    if (this.matchKW(Lexer.Keyword.SWITCH)) {
      const switchTok = this.peek(-1);
      this.expect("(");
      const expr = this.parseExpression();
      if (expr.type.removeQualifiers().isRef()) {
        this.error(switchTok, `cannot switch on reference type '${expr.type.toString()}'`);
      }
      this.expect(")");
      // Parse the body collecting case labels
      const cases = [];
      const savedCases = this._currentCases;
      this._currentCases = cases;
      const body = this.parseStatement();
      this._currentCases = savedCases;
      return new AST.SSwitch(expr, cases, body, { filename: switchTok.filename, line: switchTok.line });
    }

    // case
    if (this.matchKW(Lexer.Keyword.CASE)) {
      const caseExpr = this.parseAssignmentExpression();
      let lo = constEvalInt(caseExpr) ?? 0n;
      let hi = lo;
      // GNU case range extension: case low ... high:
      if (this.atText("...")) {
        this.advance();
        const highExpr = this.parseAssignmentExpression();
        hi = constEvalInt(highExpr) ?? 0n;
      }
      this.expect(":");
      if (this._currentCases) {
        const idx = this._currentCompoundStmtCount || 0;
        for (let v = lo; v <= hi; v++) {
          this._currentCases.push({ value: v, stmtIndex: idx, isDefault: false });
        }
      }
      return this.parseStatement();
    }

    // default
    if (this.matchKW(Lexer.Keyword.DEFAULT)) {
      this.expect(":");
      if (this._currentCases) {
        const idx = this._currentCompoundStmtCount || 0;
        this._currentCases.push({ value: 0, stmtIndex: idx, isDefault: true });
      }
      return this.parseStatement();
    }

    // break
    if (this.matchKW(Lexer.Keyword.BREAK)) { this.expect(";"); return new AST.SBreak(); }

    // continue
    if (this.matchKW(Lexer.Keyword.CONTINUE)) { this.expect(";"); return new AST.SContinue(); }

    // return
    if (this.matchKW(Lexer.Keyword.RETURN)) {
      const retTok = this.peek(-1);
      if (this.matchText(";")) return new AST.SReturn(null);
      const expr = this.parseExpression();
      this.expect(";");
      // Forbid implicit int→ref on return (use __ref_null(T) instead).
      if (this.currentParsingFunc) {
        const retType = this.currentParsingFunc.type.getReturnType();
        this._rejectIntToRef(retType, expr, retTok);
      }
      return new AST.SReturn(expr);
    }

    // goto
    if (this.matchKW(Lexer.Keyword.GOTO)) {
      const tok = this.expectKind(Lexer.TokenKind.IDENT);
      const label = tok.text;
      this.expect(";");
      const sg = new AST.SGoto(label);
      sg.loc = { filename: tok.filename, line: tok.line };
      if (this.parsedLabels.has(label)) {
        // Backward goto — label already defined, must be a loop label
        const target = this.parsedLabels.get(label);
        if (target.hasGotos && target.labelKind === Types.LabelKind.FORWARD) {
          target.labelKind = Types.LabelKind.BOTH;
        } else {
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
      const name = this.advance().text;
      this.advance(); // skip :
      if (this.parsedLabels.has(name)) {
        this.error(this.peek(-2), `Duplicate label '${name}'`);
      }
      const sl = new AST.SLabel(name, this.currentCompound);
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
      return new AST.STryCatch(tryBody, catches);
    }

    // __throw
    if (this.matchKW(Lexer.Keyword.X_THROW)) {
      const tagName = this.expectKind(Lexer.TokenKind.IDENT).text;
      this.expect("(");
      const args = [];
      if (!this.atText(")")) {
        args.push(this.parseAssignmentExpression());
        while (this.matchText(",")) args.push(this.parseAssignmentExpression());
      }
      this.expect(")");
      this.expect(";");
      const tag = this.findExceptionTag(tagName);
      return new AST.SThrow(tag || { name: tagName }, args);
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
      return new AST.SCompound([]);
    }

    // Declaration statement
    if (this.isTypeName()) {
      return this.parseDeclarationStatement();
    }

    // Expression statement
    const expr = this.parseExpression();
    this.expect(";");
    return new AST.SExpr(expr);
  }

  findExceptionTag(name) {
    for (const tag of this.parsedExceptionTags) {
      if (tag.name === name) return tag;
    }
    return null;
  }

  parseCompoundStatement() {
    this.expect("{");
    this.typeScope.push(); this.tagScope.push(); this.varScope.push();
    const statements = [];
    const savedCount = this._currentCompoundStmtCount;
    this._currentCompoundStmtCount = 0;
    const compound = new AST.SCompound(statements);
    const savedCompound = this.currentCompound;
    this.currentCompound = compound;

    while (!this.atEnd() && !this.atText("}")) {
      // Handle case/default labels at compound level for switch tracking
      this._currentCompoundStmtCount = statements.length;
      const stmt = this.parseStatement();
      statements.push(stmt);
    }

    this._currentCompoundStmtCount = savedCount;
    this.currentCompound = savedCompound;
    this.expect("}");
    this.typeScope.pop(); this.tagScope.pop(); this.varScope.pop();
    return compound;
  }

  parseDeclarationStatement() {
    const declarations = [];
    const specs = this.parseDeclSpecifiers();
    let baseType = specs.type;

    if (this.matchText(";")) {
      // Anonymous struct/union/enum declaration
      return new AST.SDecl(declarations);
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
        const prevType = this.typeScope.get(name);
        if (prevType && prevType.removeQualifiers() !== type.removeQualifiers()) {
          this.error(this.peek(), `redefinition of typedef '${name}'`);
        }
        this.typeScope.set(name, type);
        if (this.matchText(";")) return new AST.SDecl(declarations);
        continue;
      }

      // Local extern function declaration (e.g. extern int f(void);)
      if (type.kind === Types.TypeKind.FUNCTION) {
        if (specs.requestedAlignment > 0) {
          this.error(this.peek(-1), "_Alignas cannot be applied to a function declaration");
        }
        const funcDecl = new AST.DFunc({ filename: this.peek().filename, line: this.peek().line },
          name, type, [], specs.storageClass, false, null);
        funcDecl.importModule = specs.importModule;
        funcDecl.importName = specs.importName;
        this.varScope.set(name, funcDecl);
        if (this.currentParsingFunc) {
          this.currentParsingFunc.usedSymbols.add(funcDecl);
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
          this._rejectIntToRef(type, dvar.initExpr, eqTok);
        }
        // Handle string-initialized char array
        if (type.kind === Types.TypeKind.ARRAY && type.arraySize === 0 && dvar.initExpr &&
            dvar.initExpr.kind === Types.ExprKind.STRING) {
          type = dvar.initExpr.type;
          dvar.type = type;
        }
        // Normalize init list
        if (dvar.initExpr && dvar.initExpr.kind === Types.ExprKind.INIT_LIST) {
          if (type.kind === Types.TypeKind.ARRAY && type.arraySize === 0) {
            normalizeInitList(dvar.initExpr, type);
            type = dvar.initExpr.type;
            dvar.type = type;
          } else if (type.isAggregate()) {
            normalizeInitList(dvar.initExpr, type);
          }
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
    return new AST.SDecl(declarations);
  }

  // --- External declaration parsing ---

  parseExternalDeclaration(unit) {
    const loc = { filename: this.peek().filename, line: this.peek().line };
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

      // K&R parameter declarations: parse type declarations between ')' and '{'
      if (decl._isKnR && type.kind === Types.TypeKind.FUNCTION &&
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
      if (type.kind === Types.TypeKind.FUNCTION) {
        const seen = new Set();
        const checkComplete = (t) => {
          if (!t || seen.has(t)) return;
          seen.add(t);
          const u = t.removeQualifiers();
          if (u.kind === Types.TypeKind.GC_STRUCT && !u.isComplete) {
            this.error(this.peek(), `function '${name}' references incomplete GC struct '${u.tagName}' in its signature; define '${u.tagName}' first`);
          }
          if (u.kind === Types.TypeKind.POINTER || u.kind === Types.TypeKind.ARRAY) checkComplete(u.baseType);
          else if (u.kind === Types.TypeKind.GC_ARRAY) checkComplete(u.baseType);
          else if (u.kind === Types.TypeKind.FUNCTION) {
            checkComplete(u.returnType);
            for (const pt of (u.paramTypes || [])) checkComplete(pt);
          }
        };
        checkComplete(type.returnType);
        for (const pt of (type.paramTypes || [])) checkComplete(pt);
      }

      // Check if this is a function definition
      if (type.kind === Types.TypeKind.FUNCTION && this.atText("{")) {
        if (specs.requestedAlignment > 0) {
          this.error(this.peek(-1), "_Alignas cannot be applied to a function declaration");
        }
        const funcDecl = new AST.DFunc(loc, name, type,
          [], specs.storageClass, specs.isInline, null);
        funcDecl.importModule = specs.importModule;
        funcDecl.importName = specs.importName;

        // Update previous declaration's definition pointer
        const prev = this.varScope.get(name);
        if (prev && prev.declKind === Types.DeclKind.FUNC) {
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
      if (type.kind === Types.TypeKind.FUNCTION) {
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
        if (prevFunc && prevFunc.declKind === Types.DeclKind.FUNC && !prevFunc.type.isCompatibleWith(funcDecl.type)) {
          this.error(this.peek(), `conflicting types for '${name}' (previously declared as '${prevFunc.type.toString()}', now declared as '${funcDecl.type.toString()}')`);
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
      if (prevVar && prevVar.declKind === Types.DeclKind.VAR && !prevVar.type.isCompatibleWith(type)) {
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
          this._rejectIntToRef(type, dvar.initExpr, eqTok);
          // File-scope ref-typed globals: WASM constant init expressions
          // can only emit ref.null. Allocation (e.g. boxing a primitive)
          // is not allowed at module-init time.
          if (type.removeQualifiers().isRef() && !this._isNullPointerConstant(dvar.initExpr) &&
              !dvar.initExpr.type.removeQualifiers().isRef()) {
            this.error(eqTok,
              `global '${name}': reference-typed globals can only be initialized to null/0 ` +
              `(WASM constant init expressions can't allocate); set the value in main() or a startup function`);
          }
        }
        // Handle string-initialized char array
        if (type.kind === Types.TypeKind.ARRAY && type.arraySize === 0 && dvar.initExpr &&
            dvar.initExpr.kind === Types.ExprKind.STRING) {
          type = Types.arrayOf(type.baseType, dvar.initExpr.type.arraySize);
          dvar.type = type;
        }
        // Normalize init list
        if (dvar.initExpr && dvar.initExpr.kind === Types.ExprKind.INIT_LIST) {
          if (type.kind === Types.TypeKind.ARRAY && type.arraySize === 0) {
            normalizeInitList(dvar.initExpr, type);
            type = dvar.initExpr.type;
            dvar.type = type;
          } else if (type.isAggregate()) {
            normalizeInitList(dvar.initExpr, type);
          }
        }
      }

      // Check for previous declaration and update scope
      const prevDecl = this.varScope.get(name);
      if (prevDecl && prevDecl.declKind === Types.DeclKind.VAR && specs.storageClass !== Types.StorageClass.EXTERN) {
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
      if (type.kind === Types.TypeKind.GC_ARRAY) {
        this.error(starTok, `'__array(...)' types do not take a '*' — write '__array(T) name' (the array is already a reference)`);
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
              // Handle pointer prefix
              while (this.matchText("*")) {
                pType = pType.pointer();
                while (this.matchKW(Lexer.Keyword.CONST) || this.matchKW(Lexer.Keyword.VOLATILE) || this.matchKW(Lexer.Keyword.RESTRICT)) {}
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
  const errors = [];
  const warnings = [];

  if (tokens.length === 0) {
    errors.push(new Lexer.LexError("No tokens to parse", null, 0));
    return { translationUnit: AST.makeTUnit(null), errors, warnings };
  }

  const unit = AST.makeTUnit(tokens[0].filename);
  const parser = new Parser(tokens, errors, warnings);
  if (options?.warningFlags) parser.warningFlags = options.warningFlags;
  if (options?.compilerOptions?.allowImplicitInt) parser._allowImplicitInt = true;
  if (options?.compilerOptions?.allowKnRDefinitions) parser._allowKnRDefinitions = true;
  if (options?.compilerOptions?.allowImplicitFunctionDecl) parser._allowImplicitFunctionDecl = true;
  if (options?.exceptionTagRegistry) parser._exceptionTagRegistry = options.exceptionTagRegistry;

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
        if (decl && decl.declKind === Types.DeclKind.FUNC) {
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
            while (parser.matchText("*")) pType = pType.pointer();
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
          tag = { name: tagName, paramTypes, definition: null };
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
    if (e instanceof Lexer.LexError) {
      errors.push(e);
    } else {
      errors.push(new Lexer.LexError(e.message, null, 0));
    }
  }

  unit.requiredSources = parser.requiredSources;
  unit.exportDirectives = parser.exportDirectives;
  unit.globalUsedSymbols = parser.globalUsedSymbols;
  unit.fileScopeCompoundLiterals = parser.fileScopeCompoundLiterals;

  return { translationUnit: unit, errors, warnings };
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

// ====================
// Implicit Cast Annotation
// ====================

function wrapImplicitCast(expr, targetType, setter) {
  targetType = targetType.removeQualifiers();
  const srcType = expr.type.removeQualifiers();
  if (srcType === targetType) return;
  if (targetType.isVoid() || srcType.isVoid()) return;
  setter(new AST.EImplicitCast(targetType, expr));
}

function annotateExpr(expr) {
  if (!expr) return;
  switch (expr.kind) {
    case Types.ExprKind.BINARY: {
      annotateExpr(expr.left);
      annotateExpr(expr.right);
      // Skip assignment ops
      if (expr.op === "ASSIGN" || expr.op.endsWith("_ASSIGN")) break;
      // Skip logical ops
      if (expr.op === "LAND" || expr.op === "LOR") break;
      const leftType = expr.left.type;
      const rightType = expr.right.type;
      // Skip pointer/array arithmetic
      if ((expr.op === "ADD" || expr.op === "SUB") &&
          (leftType.isPointer() || rightType.isPointer() ||
           leftType.isArray() || rightType.isArray())) break;
      if (leftType.removeQualifiers().isRef() || rightType.removeQualifiers().isRef()) break;
      const isComparison = ["EQ","NE","LT","GT","LE","GE"].includes(expr.op);
      const opType = isComparison ? Types.usualArithmeticConversions(leftType, rightType) : expr.type;
      wrapImplicitCast(expr.left, opType, (e) => { expr.left = e; });
      wrapImplicitCast(expr.right, opType, (e) => { expr.right = e; });
      break;
    }
    case Types.ExprKind.CALL: {
      annotateExpr(expr.callee);
      for (const arg of expr.arguments) annotateExpr(arg);
      // Resolve function type
      let calleeType = expr.callee.type;
      if (calleeType.isArray() || calleeType.isFunction()) calleeType = calleeType.decay();
      if (calleeType.isPointer()) calleeType = calleeType.baseType;
      if (!calleeType || !calleeType.isFunction()) break;
      const paramTypes = calleeType.getParamTypes();
      if (calleeType.isVarArg) {
        // Fixed params
        for (let i = 0; i < paramTypes.length && i < expr.arguments.length; i++) {
          const idx = i;
          wrapImplicitCast(expr.arguments[idx], paramTypes[idx], (e) => { expr.arguments[idx] = e; });
        }
        // Varargs: default argument promotion (float→double)
        for (let i = paramTypes.length; i < expr.arguments.length; i++) {
          const idx = i;
          if (expr.arguments[idx].type.removeQualifiers() === Types.TFLOAT) {
            wrapImplicitCast(expr.arguments[idx], Types.TDOUBLE, (e) => { expr.arguments[idx] = e; });
          }
        }
      } else {
        for (let i = 0; i < expr.arguments.length && i < paramTypes.length; i++) {
          const idx = i;
          wrapImplicitCast(expr.arguments[idx], paramTypes[idx], (e) => { expr.arguments[idx] = e; });
        }
      }
      break;
    }
    case Types.ExprKind.TERNARY:
      annotateExpr(expr.condition);
      annotateExpr(expr.thenExpr);
      annotateExpr(expr.elseExpr);
      wrapImplicitCast(expr.thenExpr, expr.type, (e) => { expr.thenExpr = e; });
      wrapImplicitCast(expr.elseExpr, expr.type, (e) => { expr.elseExpr = e; });
      break;
    case Types.ExprKind.UNARY:
      annotateExpr(expr.operand);
      break;
    case Types.ExprKind.SUBSCRIPT:
      annotateExpr(expr.array);
      annotateExpr(expr.index);
      break;
    case Types.ExprKind.MEMBER:
    case Types.ExprKind.ARROW:
      annotateExpr(expr.base);
      break;
    case Types.ExprKind.CAST:
      annotateExpr(expr.expr);
      break;
    case Types.ExprKind.COMMA:
      for (const e of expr.expressions) annotateExpr(e);
      break;
    case Types.ExprKind.INIT_LIST:
      for (const e of expr.elements) annotateExpr(e);
      break;
    case Types.ExprKind.INTRINSIC:
      for (const arg of expr.args) annotateExpr(arg);
      break;
    case Types.ExprKind.WASM:
      for (const arg of expr.args) annotateExpr(arg);
      break;
    case Types.ExprKind.COMPOUND_LITERAL:
      if (expr.initList) for (const e of expr.initList.elements) annotateExpr(e);
      break;
    case Types.ExprKind.SIZEOF_EXPR:
    case Types.ExprKind.ALIGNOF_EXPR:
      annotateExpr(expr.expr);
      break;
    case Types.ExprKind.IMPLICIT_CAST:
      annotateExpr(expr.expr);
      break;
    default:
      break; // INT, FLOAT, STRING, IDENT, SIZEOF_TYPE, ALIGNOF_TYPE — leaf nodes
  }
}

function annotateStmt(stmt, returnType) {
  if (!stmt) return;
  switch (stmt.kind) {
    case Types.StmtKind.EXPR:
      annotateExpr(stmt.expr);
      break;
    case Types.StmtKind.RETURN:
      if (stmt.expr) {
        annotateExpr(stmt.expr);
        wrapImplicitCast(stmt.expr, returnType, (e) => { stmt.expr = e; });
      }
      break;
    case Types.StmtKind.DECL:
      for (const decl of stmt.declarations) {
        if (decl.declKind === Types.DeclKind.VAR && decl.initExpr) {
          annotateExpr(decl.initExpr);
          if (!decl.type.isAggregate() && decl.initExpr.kind !== Types.ExprKind.INIT_LIST) {
            wrapImplicitCast(decl.initExpr, decl.type, (e) => { decl.initExpr = e; });
          }
        }
      }
      break;
    case Types.StmtKind.COMPOUND:
      for (const s of stmt.statements) annotateStmt(s, returnType);
      break;
    case Types.StmtKind.IF:
      annotateExpr(stmt.condition);
      annotateStmt(stmt.thenBranch, returnType);
      if (stmt.elseBranch) annotateStmt(stmt.elseBranch, returnType);
      break;
    case Types.StmtKind.WHILE:
      annotateExpr(stmt.condition);
      annotateStmt(stmt.body, returnType);
      break;
    case Types.StmtKind.DO_WHILE:
      annotateStmt(stmt.body, returnType);
      annotateExpr(stmt.condition);
      break;
    case Types.StmtKind.FOR:
      if (stmt.init) annotateStmt(stmt.init, returnType);
      if (stmt.condition) annotateExpr(stmt.condition);
      if (stmt.increment) annotateExpr(stmt.increment);
      annotateStmt(stmt.body, returnType);
      break;
    case Types.StmtKind.SWITCH:
      annotateExpr(stmt.expr);
      if (stmt.body) annotateStmt(stmt.body, returnType);
      break;
    case Types.StmtKind.TRY_CATCH:
      annotateStmt(stmt.tryBody, returnType);
      for (const cc of stmt.catches) annotateStmt(cc.body, returnType);
      break;
    case Types.StmtKind.THROW:
      for (let i = 0; i < stmt.args.length; i++) {
        annotateExpr(stmt.args[i]);
        if (stmt.tag && stmt.tag.paramTypes && i < stmt.tag.paramTypes.length) {
          const idx = i;
          wrapImplicitCast(stmt.args[idx], stmt.tag.paramTypes[idx], (e) => { stmt.args[idx] = e; });
        }
      }
      break;
    default:
      break;
  }
}

// ========== setjmp/longjmp lowering ==========

// Check if an expression is a call to a named function, return the ECall or null
function getNamedCall(expr, name) {
  if (expr.kind !== Types.ExprKind.CALL) return null;
  const callee = expr.callee;
  if (callee.kind !== Types.ExprKind.IDENT) return null;
  if (callee.name !== name) return null;
  return expr;
}

// Detect setjmp patterns in an if-condition.
// Returns {call, zeroIsTrue} or {call: null}
function extractSetjmpCall(cond) {
  if (cond.kind === Types.ExprKind.BINARY) {
    if (cond.op === "EQ") {
      let call = getNamedCall(cond.left, "setjmp");
      if (call && cond.right.kind === Types.ExprKind.INT && cond.right.value === 0n)
        return { call, zeroIsTrue: true };
      call = getNamedCall(cond.right, "setjmp");
      if (call && cond.left.kind === Types.ExprKind.INT && cond.left.value === 0n)
        return { call, zeroIsTrue: true };
    }
    if (cond.op === "NE") {
      let call = getNamedCall(cond.left, "setjmp");
      if (call && cond.right.kind === Types.ExprKind.INT && cond.right.value === 0n)
        return { call, zeroIsTrue: false };
      call = getNamedCall(cond.right, "setjmp");
      if (call && cond.left.kind === Types.ExprKind.INT && cond.left.value === 0n)
        return { call, zeroIsTrue: false };
    }
  }
  // Pattern: setjmp(buf) used directly as condition (truthy = longjmp fired)
  const directCall = getNamedCall(cond, "setjmp");
  if (directCall) return { call: directCall, zeroIsTrue: false };
  // Pattern: !setjmp(buf)
  if (cond.kind === Types.ExprKind.UNARY && cond.op === "OP_LNOT") {
    const negCall = getNamedCall(cond.operand, "setjmp");
    if (negCall) return { call: negCall, zeroIsTrue: true };
  }
  return { call: null, zeroIsTrue: false };
}

// Build expression: buf[0]
function makeBufIdExpr(bufExpr) {
  return new AST.ESubscript(Types.TINT, bufExpr, new AST.EInt(Types.TINT, 0n));
}

// Build: buf[0] = ++counterVar
function makeSetBufIdStmt(bufExpr, counterVar) {
  const lhs = makeBufIdExpr(bufExpr);
  const counterRef = new AST.EIdent(Types.TINT, counterVar.name, counterVar);
  const rhs = new AST.EUnary(Types.TINT, "OP_PRE_INC", counterRef);
  const assign = new AST.EBinary(Types.TINT, "ASSIGN", lhs, rhs);
  return new AST.SExpr(assign);
}

// Build: __throw tag(idExpr, valExpr)
function makeThrowLongJump(tag, idExpr, valExpr) {
  return new AST.SThrow(tag, [idExpr, valExpr]);
}

// Build catch body: { if (id != buf[0]) rethrow; <userBody> }
function makeCatchBody(tag, idVar, valVar, bufExpr, userBody) {
  const idRef = new AST.EIdent(Types.TINT, idVar.name, idVar);
  const myIdExpr = makeBufIdExpr(bufExpr);
  const cond = new AST.EBinary(Types.TINT, "NE", idRef, myIdExpr);

  const idRef2 = new AST.EIdent(Types.TINT, idVar.name, idVar);
  const valRef = new AST.EIdent(Types.TINT, valVar.name, valVar);
  const rethrow = makeThrowLongJump(tag, idRef2, valRef);

  const rethrowIf = new AST.SIf(cond, rethrow, null);
  return new AST.SCompound([rethrowIf, userBody]);
}

// Transform longjmp calls in a statement tree into __throw __LongJump(buf[0], val)
// Returns a replacement statement if changed, or the same statement if not.
function lowerLongjmpInStmt(stmt, tag) {
  switch (stmt.kind) {
    case Types.StmtKind.EXPR: {
      const call = getNamedCall(stmt.expr, "longjmp");
      if (call && call.arguments.length === 2) {
        const idExpr = makeBufIdExpr(call.arguments[0]);
        const valExpr = call.arguments[1];
        return makeThrowLongJump(tag, idExpr, valExpr);
      }
      return stmt;
    }
    case Types.StmtKind.COMPOUND:
      for (let i = 0; i < stmt.statements.length; i++) {
        stmt.statements[i] = lowerLongjmpInStmt(stmt.statements[i], tag);
      }
      return stmt;
    case Types.StmtKind.IF:
      stmt.thenBranch = lowerLongjmpInStmt(stmt.thenBranch, tag);
      if (stmt.elseBranch) stmt.elseBranch = lowerLongjmpInStmt(stmt.elseBranch, tag);
      return stmt;
    case Types.StmtKind.WHILE:
      stmt.body = lowerLongjmpInStmt(stmt.body, tag);
      return stmt;
    case Types.StmtKind.DO_WHILE:
      stmt.body = lowerLongjmpInStmt(stmt.body, tag);
      return stmt;
    case Types.StmtKind.FOR:
      if (stmt.init) stmt.init = lowerLongjmpInStmt(stmt.init, tag);
      stmt.body = lowerLongjmpInStmt(stmt.body, tag);
      return stmt;
    case Types.StmtKind.SWITCH:
      stmt.body = lowerLongjmpInStmt(stmt.body, tag);
      return stmt;
    case Types.StmtKind.TRY_CATCH:
      stmt.tryBody = lowerLongjmpInStmt(stmt.tryBody, tag);
      for (const cc of stmt.catches) cc.body = lowerLongjmpInStmt(cc.body, tag);
      return stmt;
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
    switch (stmt.kind) {
      case Types.StmtKind.COMPOUND:
        lowerSetjmpInCompound(stmt, tag, counterVar);
        break;
      case Types.StmtKind.IF:
        // Don't recurse into the if we're about to transform — check first
        break;
      case Types.StmtKind.WHILE:
        if (stmt.body.kind === Types.StmtKind.COMPOUND)
          lowerSetjmpInCompound(stmt.body, tag, counterVar);
        break;
      case Types.StmtKind.DO_WHILE:
        if (stmt.body.kind === Types.StmtKind.COMPOUND)
          lowerSetjmpInCompound(stmt.body, tag, counterVar);
        break;
      case Types.StmtKind.FOR:
        if (stmt.body.kind === Types.StmtKind.COMPOUND)
          lowerSetjmpInCompound(stmt.body, tag, counterVar);
        break;
      case Types.StmtKind.SWITCH:
        if (stmt.body.kind === Types.StmtKind.COMPOUND)
          lowerSetjmpInCompound(stmt.body, tag, counterVar);
        break;
      case Types.StmtKind.LABEL:
        break;
      case Types.StmtKind.TRY_CATCH:
        if (stmt.tryBody.kind === Types.StmtKind.COMPOUND)
          lowerSetjmpInCompound(stmt.tryBody, tag, counterVar);
        for (const cc of stmt.catches)
          if (cc.body.kind === Types.StmtKind.COMPOUND)
            lowerSetjmpInCompound(cc.body, tag, counterVar);
        break;
      default:
        break;
    }

    // Now check if this is an if-statement with setjmp in the condition
    if (stmt.kind !== Types.StmtKind.IF) continue;

    const { call: setjmpCall, zeroIsTrue } = extractSetjmpCall(stmt.condition);
    if (!setjmpCall) {
      // Not a setjmp if — but still recurse into its branches
      if (stmt.thenBranch.kind === Types.StmtKind.COMPOUND)
        lowerSetjmpInCompound(stmt.thenBranch, tag, counterVar);
      if (stmt.elseBranch && stmt.elseBranch.kind === Types.StmtKind.COMPOUND)
        lowerSetjmpInCompound(stmt.elseBranch, tag, counterVar);
      continue;
    }

    // Found a setjmp pattern! Transform it.
    const bufExpr = setjmpCall.arguments[0];

    // Create catch binding variables
    const idName = Lexer.intern("__setjmp_caught_id");
    const valName = Lexer.intern("__setjmp_caught_val");
    const loc = { filename: "", line: 0 };
    const idVar = new AST.DVar(loc, idName, Types.TINT, Types.StorageClass.NONE, null);
    idVar.definition = idVar;
    const valVar = new AST.DVar(loc, valName, Types.TINT, Types.StorageClass.NONE, null);
    valVar.definition = valVar;

    // Determine try-body and catch-body based on pattern
    let tryBody, catchUserBody;

    if (zeroIsTrue) {
      // Pattern A: if (setjmp(buf) == 0) { Y } else { X }
      tryBody = stmt.thenBranch;
      catchUserBody = stmt.elseBranch || new AST.SEmpty();
    } else {
      // Pattern B: if (setjmp(buf)) { X }  <remaining stmts>
      catchUserBody = stmt.thenBranch;

      if (stmt.elseBranch) {
        tryBody = stmt.elseBranch;
      } else {
        // Gather remaining statements from the compound as the try body
        const remaining = stmts.splice(i + 1);
        if (remaining.length === 0) {
          tryBody = new AST.SEmpty();
        } else {
          tryBody = new AST.SCompound(remaining);
        }
      }
    }

    // Recurse into the try body and catch body
    if (tryBody.kind === Types.StmtKind.COMPOUND)
      lowerSetjmpInCompound(tryBody, tag, counterVar);
    if (catchUserBody.kind === Types.StmtKind.COMPOUND)
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
    const tryCatch = new AST.STryCatch(tryBody, [cc]);

    // Build: buf[0] = ++__setjmp_id_counter; try { ... } catch { ... }
    const setBufStmt = makeSetBufIdStmt(bufExpr, counterVar);

    // Replace the if-statement with setBuf + tryCatch
    stmts[i] = setBufStmt;
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

  // Mark counterVar as used so filterUnusedDeclarations doesn't remove it
  unit.globalUsedSymbols.add(counterVar);

  // Lower all function bodies
  const lowerFunc = (func) => {
    if (!func.body) return;
    if (func.body.kind === Types.StmtKind.COMPOUND) {
      lowerSetjmpInCompound(func.body, tag, counterVar);
    }
    func.body = lowerLongjmpInStmt(func.body, tag);
  };
  for (const f of unit.definedFunctions) lowerFunc(f);
  for (const f of unit.staticFunctions) lowerFunc(f);
}

function annotateImplicitCasts(unit) {
  const annotateFunc = (func) => {
    if (!func.body) return;
    const retType = func.type.returnType || Types.TINT;
    annotateStmt(func.body, retType);
  };
  for (const f of unit.definedFunctions) annotateFunc(f);
  for (const f of unit.staticFunctions) annotateFunc(f);
}

return {
  dumpAst, parseTokens, parseSource,
  filterUnusedDeclarations, gcSectionsPass,
  linkTranslationUnits,
  lowerSetjmpLongjmp,
  annotateImplicitCasts, annotateExpr, annotateStmt,
};
})();

// ====================
// WASM
// ====================

const Codegen = (() => {

function alwaysReturns(stmt) {
  switch (stmt.kind) {
    case Types.StmtKind.RETURN:
    case Types.StmtKind.THROW:
      return true;
    case Types.StmtKind.COMPOUND:
      if (stmt.labels && stmt.labels.length > 0) return false;
      return stmt.statements.some(alwaysReturns);
    case Types.StmtKind.IF:
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
  br(labelIdx) { this.push(0x0C); lebU(this.bytes, labelIdx); }
  brIf(labelIdx) { this.push(0x0D); lebU(this.bytes, labelIdx); }
  brTable(labels, defaultLabel) {
    this.push(0x0E);
    lebU(this.bytes, labels.length);
    for (const l of labels) lebU(this.bytes, l);
    lebU(this.bytes, defaultLabel);
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
  if (type.kind === Types.TypeKind.GC_STRUCT || type.kind === Types.TypeKind.GC_ARRAY) {
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
  if (type._wasmGCTypeIdx >= 0) return type._wasmGCTypeIdx;

  if (!wmod._gcInProgress) wmod._gcInProgress = new Set();
  if (!wmod._gcPendingIdx) wmod._gcPendingIdx = new Map();

  if (wmod._gcInProgress.has(type)) {
    // Cycle — must reserve a placeholder so the recursive ref resolves.
    let pending = wmod._gcPendingIdx.get(type);
    if (pending === undefined) {
      pending = (type.kind === Types.TypeKind.GC_STRUCT)
        ? wmod.reserveGCStructTypeId()
        : wmod.reserveGCArrayTypeId();
      wmod._gcPendingIdx.set(type, pending);
    }
    return pending;
  }

  wmod._gcInProgress.add(type);

  let idx;
  if (type.kind === Types.TypeKind.GC_STRUCT) {
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
      type._wasmGCTypeIdx = idx;
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
      type._wasmGCTypeIdx = idx;
    } else {
      idx = wmod.reserveGCStructTypeId();
      type._wasmGCTypeIdx = idx;
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
  } else if (type.kind === Types.TypeKind.GC_ARRAY) {
    const elem = gcStorageTypeOf(wmod, type.baseType);
    const key = 'A(' + gcStorageKey(elem) + ')';
    const pending = wmod._gcPendingIdx.get(type);
    if (pending !== undefined) {
      idx = pending;
      wmod._gcPendingIdx.delete(type);
      type._wasmGCTypeIdx = idx;
      wmod.setGCArrayElem(idx, elem);
      if (!wmod.gcArrayTypeIndices.has(key)) wmod.gcArrayTypeIndices.set(key, idx);
    } else if (wmod.gcArrayTypeIndices.has(key)) {
      idx = wmod.gcArrayTypeIndices.get(key);
      type._wasmGCTypeIdx = idx;
    } else {
      idx = wmod.reserveGCArrayTypeId();
      type._wasmGCTypeIdx = idx;
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
    this.gotoLabelDepths = new Map();
    this.switchLevelLabels = new Set();
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
    if (!type.isTag() || !initExpr || initExpr.kind !== Types.ExprKind.INIT_LIST) return 0;
    const tag = type.tagDecl;
    if (!tag || tag.tagKind !== Types.TagKind.STRUCT) return 0;
    const members = tag.members.filter(m => m.declKind === Types.DeclKind.VAR);
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
    if (famElem.kind === Types.ExprKind.STRING) return famElem.value.length * elemSize;
    if (famElem.kind === Types.ExprKind.INIT_LIST) return famElem.elements.length * elemSize;
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

  // Evaluate an expression as an address (returns a number or null)
  _constEvalAddr(expr) {
    if (!expr) return null;
    // Cast from integer to pointer: (type*)intval
    if (expr.kind === Types.ExprKind.CAST || expr.kind === Types.ExprKind.IMPLICIT_CAST) {
      const inner = this._constEvalExpr(expr.expr);
      if (inner && inner.kind === "int") return Number(inner.intVal);
      if (inner && inner.kind === "addr") return inner.addrVal;
      return null;
    }
    // Arrow: base->member → addr(base) + offset, where base is pointer
    if (expr.kind === Types.ExprKind.ARROW && expr.memberDecl) {
      const baseVal = this._constEvalExpr(expr.base);
      if (baseVal && (baseVal.kind === "addr" || baseVal.kind === "int")) {
        const baseAddr = baseVal.kind === "addr" ? baseVal.addrVal : Number(baseVal.intVal);
        return baseAddr + expr.memberDecl.byteOffset;
      }
      return null;
    }
    // General: try _constEvalExpr and extract address
    const v = this._constEvalExpr(expr);
    if (v && v.kind === "addr") return v.addrVal;
    if (v && v.kind === "int") return Number(v.intVal);
    return null;
  }

  // --- ConstEval for codegen ---
  makeConstEval() {
    return {
      evaluate: (expr) => this._constEvalExpr(expr),
    };
  }

  _constEvalExpr(expr) {
    if (!expr) return null;
    switch (expr.kind) {
      case Types.ExprKind.INT: return { kind: "int", intVal: expr.value };
      case Types.ExprKind.FLOAT: return { kind: "float", floatVal: expr.value };
      case Types.ExprKind.STRING: {
        const addr = this.getStringAddress(expr.value);
        return { kind: "addr", addrVal: addr };
      }
      case Types.ExprKind.IDENT: {
        if (expr.decl && expr.decl.declKind === Types.DeclKind.ENUM_CONST) {
          return { kind: "int", intVal: BigInt(expr.decl.value) };
        }
        if (expr.decl && expr.decl.declKind === Types.DeclKind.FUNC) {
          const func = expr.decl.definition || expr.decl;
          const tIdx = this.funcDefToTableIdx.get(func);
          if (tIdx !== undefined) return { kind: "addr", addrVal: tIdx };
        }
        if (expr.decl && expr.decl.declKind === Types.DeclKind.VAR) {
          const varDecl = expr.decl.definition || expr.decl;
          const addr = this.globalArrayAddrs.get(varDecl);
          if (addr !== undefined) return { kind: "addr", addrVal: addr };
        }
        return null;
      }
      case Types.ExprKind.UNARY: {
        if (expr.op === "OP_ADDR") {
          const inner = expr.operand;
          // &var → address
          if (inner.kind === Types.ExprKind.IDENT && inner.decl) {
            if (inner.decl.declKind === Types.DeclKind.VAR) {
              const varDecl = inner.decl.definition || inner.decl;
              const addr = this.globalArrayAddrs.get(varDecl);
              if (addr !== undefined) return { kind: "addr", addrVal: addr };
            }
            if (inner.decl.declKind === Types.DeclKind.FUNC) {
              const func = inner.decl.definition || inner.decl;
              const tIdx = this.funcDefToTableIdx.get(func);
              if (tIdx !== undefined) return { kind: "addr", addrVal: tIdx };
            }
          }
          // &(base->member) or &(base.member) → base_addr + member offset
          if ((inner.kind === Types.ExprKind.ARROW || inner.kind === Types.ExprKind.MEMBER) && inner.memberDecl) {
            const baseAddr = this._constEvalAddr(inner.base);
            if (baseAddr !== null) {
              return { kind: "addr", addrVal: baseAddr + inner.memberDecl.byteOffset };
            }
          }
          // &(base[index]) → base_addr + index * elemSize
          if (inner.kind === Types.ExprKind.SUBSCRIPT) {
            const baseAddr = this._constEvalAddr(inner.array);
            const idx = this._constEvalExpr(inner.index);
            if (baseAddr !== null && idx && idx.kind === "int") {
              const elemSize = this.sizeOf(inner.type);
              return { kind: "addr", addrVal: baseAddr + Number(idx.intVal) * elemSize };
            }
          }
          // &(compound_literal) → address of file-scope compound literal
          if (inner.kind === Types.ExprKind.COMPOUND_LITERAL) {
            const addr = this.fileScopeCompoundLiteralAddrs.get(inner);
            if (addr !== undefined) return { kind: "addr", addrVal: addr };
          }
          return null;
        }
        const v = this._constEvalExpr(expr.operand);
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
      case Types.ExprKind.BINARY: {
        // Short-circuit LAND/LOR
        if (expr.op === "LAND") {
          const l = this._constEvalExpr(expr.left);
          if (!l) return null;
          const lv = l.kind === "int" ? l.intVal : l.kind === "float" ? (l.floatVal !== 0.0 ? 1n : 0n) : null;
          if (lv === null) return null;
          if (lv === 0n) return { kind: "int", intVal: 0n };
          const r = this._constEvalExpr(expr.right);
          if (!r) return null;
          const rv = r.kind === "int" ? r.intVal : r.kind === "float" ? (r.floatVal !== 0.0 ? 1n : 0n) : null;
          if (rv === null) return null;
          return { kind: "int", intVal: rv !== 0n ? 1n : 0n };
        }
        if (expr.op === "LOR") {
          const l = this._constEvalExpr(expr.left);
          if (!l) return null;
          const lv = l.kind === "int" ? l.intVal : l.kind === "float" ? (l.floatVal !== 0.0 ? 1n : 0n) : null;
          if (lv === null) return null;
          if (lv !== 0n) return { kind: "int", intVal: 1n };
          const r = this._constEvalExpr(expr.right);
          if (!r) return null;
          const rv = r.kind === "int" ? r.intVal : r.kind === "float" ? (r.floatVal !== 0.0 ? 1n : 0n) : null;
          if (rv === null) return null;
          return { kind: "int", intVal: rv !== 0n ? 1n : 0n };
        }
        const l = this._constEvalExpr(expr.left);
        const r = this._constEvalExpr(expr.right);
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
            const leftType = expr.left.type.removeQualifiers();
            let elemSize = leftType.kind === Types.TypeKind.POINTER ? this.sizeOf(leftType.baseType)
                         : leftType.kind === Types.TypeKind.ARRAY ? this.sizeOf(leftType.baseType) : 1;
            const offset = Number(r.intVal) * elemSize;
            return { kind: "addr", addrVal: expr.op === "ADD" ? l.addrVal + offset : l.addrVal - offset };
          }
          // int + addr
          if (r.kind === "addr" && l.kind === "int" && expr.op === "ADD") {
            const rightType = expr.right.type.removeQualifiers();
            let elemSize = rightType.kind === Types.TypeKind.POINTER ? this.sizeOf(rightType.baseType)
                         : rightType.kind === Types.TypeKind.ARRAY ? this.sizeOf(rightType.baseType) : 1;
            return { kind: "addr", addrVal: r.addrVal + Number(l.intVal) * elemSize };
          }
          // addr - addr (pointer difference)
          if (l.kind === "addr" && r.kind === "addr" && expr.op === "SUB") {
            const leftType = expr.left.type.removeQualifiers();
            let elemSize = leftType.kind === Types.TypeKind.POINTER ? this.sizeOf(leftType.baseType)
                         : leftType.kind === Types.TypeKind.ARRAY ? this.sizeOf(leftType.baseType) : 1;
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
      case Types.ExprKind.TERNARY: {
        const cond = this._constEvalExpr(expr.condition);
        if (!cond) return null;
        let cv;
        if (cond.kind === "int") cv = cond.intVal !== 0n;
        else if (cond.kind === "float") cv = cond.floatVal !== 0.0;
        else return null;
        return this._constEvalExpr(cv ? expr.thenExpr : expr.elseExpr);
      }
      case Types.ExprKind.CAST:
      case Types.ExprKind.IMPLICIT_CAST: {
        const v = this._constEvalExpr(expr.expr);
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
      case Types.ExprKind.SIZEOF_EXPR: return { kind: "int", intVal: BigInt(expr.expr.type.size) };
      case Types.ExprKind.SIZEOF_TYPE: return { kind: "int", intVal: BigInt(expr.operandType.size) };
      case Types.ExprKind.ALIGNOF_EXPR: return { kind: "int", intVal: BigInt(expr.expr.type.align) };
      case Types.ExprKind.ALIGNOF_TYPE: return { kind: "int", intVal: BigInt(expr.operandType.align) };
      case Types.ExprKind.COMPOUND_LITERAL: {
        // For scalar compound literals like (int){42}, extract the value
        if (!expr.type.isAggregate() && !expr.type.isArray() && expr.initList &&
            expr.initList.elements.length > 0) {
          return this._constEvalExpr(expr.initList.elements[0]);
        }
        // For aggregate/array compound literals, return the address
        const addr = this.fileScopeCompoundLiteralAddrs.get(expr);
        if (addr !== undefined) return { kind: "addr", addrVal: addr };
        return null;
      }
      default: return null;
    }
  }

  // --- Populate init list into static data ---
  populateInitListStatic(initList, type, baseOffset) {
    if (type.isArray()) {
      const elemType = type.baseType;
      const elemSize = this.sizeOf(elemType);
      for (let i = 0; i < initList.elements.length; i++) {
        const elemOffset = baseOffset + i * elemSize;
        const elem = initList.elements[i];
        if (elem.kind === Types.ExprKind.INIT_LIST) {
          this.populateInitListStatic(elem, elemType, elemOffset);
        } else if (elem.kind === Types.ExprKind.STRING && elemType.isArray()) {
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
          if (member.declKind !== Types.DeclKind.VAR) continue;
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
            } else if (elem.kind === Types.ExprKind.INIT_LIST) {
              this.populateInitListStatic(elem, member.type, fieldOffset);
            } else if (elem.kind === Types.ExprKind.STRING && member.type.isArray()) {
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
            if (member.declKind !== Types.DeclKind.VAR) continue;
            if (varIdx++ !== targetIdx) continue;
            const elem = initList.elements[0];
            if (elem.kind === Types.ExprKind.INIT_LIST) {
              this.populateInitListStatic(elem, member.type, baseOffset);
            } else if (elem.kind === Types.ExprKind.STRING && member.type.isArray()) {
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
        if (elem.kind === Types.ExprKind.INIT_LIST) {
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
          if (member.declKind !== Types.DeclKind.VAR) continue;
          if (member.bitWidth >= 0 && !member.name) continue;
          const fieldOffset = baseOffset + member.byteOffset;
          if (elemIdx < initList.elements.length) {
            const elem = initList.elements[elemIdx];
            if (member.bitWidth >= 0) {
              const val = this._constEvalExpr(elem);
              if (!val) {
                this.body.localGet(baseLocalIdx);
                if (fieldOffset) { this.body.i32Const(fieldOffset); this.body.aop(WT_I32, ALU.OP_ADD); }
                this.emitExpr(elem);
                this.emitConversion(elem.type, member.type);
                this.emitBitFieldStore(member);
              }
            } else if (elem.kind === Types.ExprKind.INIT_LIST) {
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
            if (member.declKind !== Types.DeclKind.VAR) continue;
            if (varIdx++ !== targetIdx) continue;
            const elem = initList.elements[0];
            if (elem.kind === Types.ExprKind.INIT_LIST) {
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
    if (type.isArray() && initExpr.kind === Types.ExprKind.STRING) {
      this.emitStringToFrameSlot(initExpr.value, type, frameOffset);
      return;
    }
    if (type.isAggregate() && initExpr.kind === Types.ExprKind.INIT_LIST) {
      const il = initExpr;
      if (type.isArray() && il.elements.length === 1 && il.elements[0].kind === Types.ExprKind.STRING) {
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
        ? new AST.EInt(Types.TINT, 0n) : cl.initList.elements[0];
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
        if (decl.declKind === Types.DeclKind.VAR && decl.storageClass !== Types.StorageClass.STATIC) {
          const def = decl.definition || decl;
          if (def === decl && def.allocClass === Types.AllocClass.MEMORY) memoryVars.push(decl);
        }
      }
    };
    const stack = [funcDef.body];
    while (stack.length > 0) {
      const stmt = stack.pop();
      if (!stmt) continue;
      switch (stmt.kind) {
        case Types.StmtKind.DECL: addMemoryDecls(stmt.declarations); break;
        case Types.StmtKind.COMPOUND:
          for (let i = stmt.statements.length - 1; i >= 0; i--) stack.push(stmt.statements[i]);
          break;
        case Types.StmtKind.IF:
          stack.push(stmt.thenBranch);
          if (stmt.elseBranch) stack.push(stmt.elseBranch);
          break;
        case Types.StmtKind.WHILE: stack.push(stmt.body); break;
        case Types.StmtKind.DO_WHILE: stack.push(stmt.body); break;
        case Types.StmtKind.FOR:
          if (stmt.init && stmt.init.kind === Types.StmtKind.DECL) addMemoryDecls(stmt.init.declarations);
          stack.push(stmt.body);
          break;
        case Types.StmtKind.SWITCH:
          for (let i = stmt.body.statements.length - 1; i >= 0; i--) stack.push(stmt.body.statements[i]);
          break;
        case Types.StmtKind.TRY_CATCH:
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
    if (memoryVars.length > 0 || memoryParams.length > 0 ||
        (funcDef.compoundLiterals && funcDef.compoundLiterals.length > 0)) {
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
      if (funcDef.compoundLiterals) {
        for (const cl of funcDef.compoundLiterals) {
          const a = this.alignOf(cl.type);
          offset = (offset + a - 1) & ~(a - 1);
          this.compoundLiteralOffsets.set(cl, offset);
          offset += this.sizeOf(cl.type);
        }
      }
      this.frameSize = (offset + 15) & ~15;
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
    switch (stmt.kind) {
      case Types.StmtKind.COMPOUND: {
        this.pushLocalScope();
        const stmts = stmt.statements;
        // Open forward-label blocks
        const forwardLabels = [];
        for (const s of stmts) {
          if (s.kind === Types.StmtKind.LABEL && s.hasGotos && !this.switchLevelLabels.has(s)) {
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
          if (s.kind === Types.StmtKind.LABEL) {
            if (!s.hasGotos) continue;
            if (s.labelKind === Types.LabelKind.FORWARD || s.labelKind === Types.LabelKind.BOTH) {
              for (let j = openLoopLabels.length - 1; j >= 0; j--) {
                this.blockDepth--;
                this.body.end();
                this.gotoLabelDepths.delete(openLoopLabels[j]);
              }
              openLoopLabels.length = 0;
              this.blockDepth--;
              this.body.end();
              this.gotoLabelDepths.delete(s);
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
          this.blockDepth--;
          this.body.end();
          this.gotoLabelDepths.delete(openLoopLabels[j]);
        }
        this.popLocalScope();
        break;
      }
      case Types.StmtKind.EXPR:
        this.emitExpr(stmt.expr, EXPR_DROP);
        break;
      case Types.StmtKind.DECL: {
        for (const decl of stmt.declarations) {
          if (decl.declKind === Types.DeclKind.VAR) {
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
      case Types.StmtKind.RETURN: {
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
      case Types.StmtKind.IF: {
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
      case Types.StmtKind.WHILE: {
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
      case Types.StmtKind.DO_WHILE: {
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
      case Types.StmtKind.FOR: {
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
      case Types.StmtKind.BREAK:
        this.body.br(this.blockDepth - this.breakTarget);
        break;
      case Types.StmtKind.CONTINUE:
        this.body.br(this.blockDepth - this.continueTarget);
        break;
      case Types.StmtKind.SWITCH: {
        const sw = stmt;
        const savedBreak = this.breakTarget;
        let defaultIdx = -1;
        for (let i = 0; i < sw.cases.length; i++) {
          if (sw.cases[i].isDefault) { defaultIdx = i; break; }
        }
        // Collect forward labels and their statement positions in switch body
        const switchFwdLabels = [];
        for (let si = 0; si < sw.body.statements.length; si++) {
          const s = sw.body.statements[si];
          if (s.kind === Types.StmtKind.LABEL && s.hasGotos) {
            if (s.labelKind === Types.LabelKind.FORWARD || s.labelKind === Types.LabelKind.BOTH)
              switchFwdLabels.push({ label: s, stmtPos: si });
          }
          if (s.kind === Types.StmtKind.COMPOUND) {
            for (const cs of s.statements) {
              if (cs.kind === Types.StmtKind.LABEL && cs.hasGotos) {
                if (cs.labelKind === Types.LabelKind.FORWARD || cs.labelKind === Types.LabelKind.BOTH) {
                  switchFwdLabels.push({ label: cs, stmtPos: si });
                  this.switchLevelLabels.add(cs);
                }
              }
            }
          }
        }
        const numCases = sw.cases.length;
        const numFwdBlocks = switchFwdLabels.length;

        // Compute adjusted br index for each case.
        // A forward label at stmtPos P is interleaved between cases with
        // stmtIndex <= P (inner) and cases with stmtIndex > P (outer).
        const caseBrIdx = new Array(numCases);
        for (let i = 0; i < numCases; i++) {
          let adj = 0;
          for (const fl of switchFwdLabels) {
            if (fl.stmtPos < sw.cases[i].stmtIndex) adj++;
          }
          caseBrIdx[i] = i + adj;
        }

        // Open break block
        this.body.block(); this.blockDepth++; this.breakTarget = this.blockDepth;

        // Open case blocks and forward label blocks interleaved.
        // Sort by stmtPos descending (higher pos = outermost).
        const blockEntries = [];
        for (let i = 0; i < numCases; i++) {
          blockEntries.push({ pos: sw.cases[i].stmtIndex, isForward: false, idx: i });
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
          const switchLocal = this.allocLocal(WT_I32);
          this.emitExpr(sw.expr);
          this.body.localSet(switchLocal);

          // Count non-default cases and find min/max for density check
          let nonDefaultCount = 0;
          let minVal = 0x7FFFFFFF, maxVal = -0x80000000;
          for (let i = 0; i < numCases; i++) {
            if (sw.cases[i].isDefault) continue;
            const v = Number(sw.cases[i].value) | 0;
            if (nonDefaultCount === 0 || v < minVal) minVal = v;
            if (nonDefaultCount === 0 || v > maxVal) maxVal = v;
            nonDefaultCount++;
          }
          const range = nonDefaultCount > 0 ? (maxVal - minVal + 1) >>> 0 : 0;
          const dense = nonDefaultCount >= 4 && range <= 512 &&
              (nonDefaultCount * 10 / range) >= 4; // density >= 40%

          if (this.compilerOptions.debugSwitch && sw.loc) {
            process.stderr.write(`${sw.loc.filename}:${sw.loc.line}: switch: ${dense ? "br_table" : "br_if"}\n`);
          }

          if (dense) {
            // br_table path: build a jump table
            const fallbackIdx = defaultIdx >= 0 ? caseBrIdx[defaultIdx] : numCases + numFwdBlocks;
            const table = new Array(range).fill(fallbackIdx);
            for (let i = 0; i < numCases; i++) {
              if (sw.cases[i].isDefault) continue;
              const v = Number(sw.cases[i].value) | 0;
              table[(v - minVal) >>> 0] = caseBrIdx[i];
            }
            this.body.localGet(switchLocal);
            this.body.i32Const(minVal);
            this.body.aop(WT_I32, ALU.OP_SUB);
            this.body.brTable(table, fallbackIdx);
          } else {
            // Linear br_if chain for sparse switches
            for (let i = 0; i < numCases; i++) {
              if (sw.cases[i].isDefault) continue;
              this.body.localGet(switchLocal);
              this.body.i32Const(sw.cases[i].value);
              this.body.aop(WT_I32, ALU.OP_EQ);
              this.body.brIf(caseBrIdx[i]);
            }
            if (defaultIdx >= 0) this.body.br(caseBrIdx[defaultIdx]);
            else this.body.br(numCases + numFwdBlocks);
          }
          this.popLocalScope();
        }
        // Case bodies
        const openLoopLabels = [];
        for (let i = 0; i < numCases; i++) {
          this.blockDepth--; this.body.end();
          const startIdx = sw.cases[i].stmtIndex;
          const endIdx = (i + 1 < numCases) ? sw.cases[i + 1].stmtIndex : sw.body.statements.length;
          for (let j = startIdx; j < endIdx; j++) {
            const s = sw.body.statements[j];
            if (s.kind === Types.StmtKind.LABEL) {
              if (!s.hasGotos) continue;
              if (s.labelKind === Types.LabelKind.FORWARD || s.labelKind === Types.LabelKind.BOTH) {
                for (let k = openLoopLabels.length - 1; k >= 0; k--) {
                  this.blockDepth--; this.body.end();
                  this.gotoLabelDepths.delete(openLoopLabels[k]);
                }
                openLoopLabels.length = 0;
                this.blockDepth--; this.body.end();
                this.gotoLabelDepths.delete(s);
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
          this.blockDepth--; this.body.end();
          this.gotoLabelDepths.delete(openLoopLabels[k]);
        }
        this.blockDepth--; this.body.end();
        this.breakTarget = savedBreak;
        break;
      }
      case Types.StmtKind.GOTO: {
        const target = stmt.target;
        const depth = this.gotoLabelDepths.get(target);
        if (depth === undefined) {
          const loc = stmt.loc || {};
          const funcName = this.currentFuncDef ? this.currentFuncDef.name : "?";
          process.stderr.write(`${loc.filename || "?"}:${loc.line || 0}: goto '${stmt.label}': target label not in scope (in function '${funcName}') (label may be in a nested block, or a loop label's scope was closed by a forward label)\n`);
          process.exit(1);
        }
        this.body.br(this.blockDepth - depth);
        break;
      }
      case Types.StmtKind.LABEL: break; // handled in COMPOUND
      case Types.StmtKind.EMPTY: break;
      case Types.StmtKind.THROW: {
        const tagIdx = this.exceptionToWasmTagIdx.get(stmt.tag);
        for (let i = 0; i < stmt.args.length; i++) this.emitExpr(stmt.args[i]);
        this.body.throw_(tagIdx);
        this.body.unreachable();
        break;
      }
      case Types.StmtKind.TRY_CATCH: {
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
        throw new Error(`emitStmt: unhandled statement kind ${stmt.kind}`);
    }
  }

  // --- Type helpers ---
  getBinaryWasmType(type) {
    type = type.removeQualifiers();
    if (type === Types.TEXTERNREF) return WT_EXTERNREF;
    if (type === Types.TREFEXTERN) return WT_REFEXTERN;
    if (type === Types.TEQREF) return WT_EQREF;
    if (type.kind === Types.TypeKind.GC_STRUCT || type.kind === Types.TypeKind.GC_ARRAY) {
      return WT_GCREF(getOrCreateGCWasmTypeIdx(this.wmod, type), true);
    }
    if (type === Types.TFLOAT) return WT_F32;
    if (type === Types.TDOUBLE || type === Types.TLDOUBLE) return WT_F64;
    if (type === Types.TLLONG || type === Types.TULLONG) return WT_I64;
    return WT_I32;
  }

  isUnsignedType(type) { return type.removeQualifiers().isUnsigned(); }

  // --- Load/Store ---
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
    this.emitLoad(field.type);
    if (bo !== 0) { this.body.i32Const(bo); this.body.aop(WT_I32, ALU.OP_SHR_U); }
    if (bw < 32) { this.body.i32Const((1 << bw) - 1); this.body.aop(WT_I32, ALU.OP_AND); }
    if (!this.isUnsignedType(field.type) && bw < 32) {
      const shift = 32 - bw;
      this.body.i32Const(shift); this.body.aop(WT_I32, ALU.OP_SHL);
      this.body.i32Const(shift); this.body.aop(WT_I32, ALU.OP_SHR_S);
    }
  }

  emitBitFieldStore(field) {
    const bw = field.bitWidth, bo = field.bitOffset;
    if (bw >= 32) { this.emitStore(field.type); return; }
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
    if (expr.kind === Types.ExprKind.INT && expr.value === 0n) return true;
    if (expr.kind === Types.ExprKind.IMPLICIT_CAST || expr.kind === Types.ExprKind.CAST) {
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
    else if (wtEquals(fromWasm, WT_F32) && wtEquals(toWasm, WT_I32)) { this.body.aop(WT_I32, ALU.OP_TRUNC_F32, toSigned); this.emitSubIntNarrowing(toType); }
    else if (wtEquals(fromWasm, WT_F32) && wtEquals(toWasm, WT_I64)) this.body.aop(WT_I64, ALU.OP_TRUNC_F32, toSigned);
    else if (wtEquals(fromWasm, WT_F64) && wtEquals(toWasm, WT_I32)) { this.body.aop(WT_I32, ALU.OP_TRUNC_F64, toSigned); this.emitSubIntNarrowing(toType); }
    else if (wtEquals(fromWasm, WT_F64) && wtEquals(toWasm, WT_I64)) this.body.aop(WT_I64, ALU.OP_TRUNC_F64, toSigned);
    else if (wtEquals(fromWasm, WT_F32) && wtEquals(toWasm, WT_F64)) this.body.aop(WT_F64, ALU.OP_PROMOTE_F32);
    else if (wtEquals(fromWasm, WT_F64) && wtEquals(toWasm, WT_F32)) this.body.aop(WT_F32, ALU.OP_DEMOTE_F64);
  }

  // --- LValue ---
  emitLValue(expr) {
    if (expr.kind === Types.ExprKind.IDENT && expr.decl && expr.decl.declKind === Types.DeclKind.VAR) {
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
    if (expr.kind === Types.ExprKind.MEMBER) {
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
      const lv = { kind: LV_MEMORY, type: expr.type, bitField: (expr.memberDecl && expr.memberDecl.bitWidth >= 0) ? expr.memberDecl : null, addrSource: LV_ADDR_LOCAL };
      lv.savedLocal = this.allocLocal(WT_I32);
      this.body.localSet(lv.savedLocal);
      return lv;
    }
    if (expr.kind === Types.ExprKind.ARROW) {
      this.emitAddressOf(expr);
      const lv = { kind: LV_MEMORY, type: expr.type, bitField: (expr.memberDecl && expr.memberDecl.bitWidth >= 0) ? expr.memberDecl : null, addrSource: LV_ADDR_LOCAL };
      lv.savedLocal = this.allocLocal(WT_I32);
      this.body.localSet(lv.savedLocal);
      return lv;
    }
    if (expr.kind === Types.ExprKind.SUBSCRIPT) {
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
      const elemSize = this.sizeOf(expr.type);
      this.emitExpr(expr.array);
      this.emitExpr(expr.index);
      if (wtEquals(this.getBinaryWasmType(expr.index.type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
      if (elemSize !== 1) { this.body.i32Const(elemSize); this.body.aop(WT_I32, ALU.OP_MUL); }
      this.body.aop(WT_I32, ALU.OP_ADD);
      const lv = { kind: LV_MEMORY, type: expr.type, addrSource: LV_ADDR_LOCAL };
      lv.savedLocal = this.allocLocal(WT_I32);
      this.body.localSet(lv.savedLocal);
      return lv;
    }
    if (expr.kind === Types.ExprKind.UNARY && expr.op === "OP_DEREF") {
      this.emitExpr(expr.operand);
      const lv = { kind: LV_MEMORY, type: expr.type, addrSource: LV_ADDR_LOCAL };
      lv.savedLocal = this.allocLocal(WT_I32);
      this.body.localSet(lv.savedLocal);
      return lv;
    }
    throw new Error(`emitLValue: unsupported expression kind ${expr.kind}`);
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
    if (expr.kind === Types.ExprKind.IDENT) {
      if (expr.decl.declKind === Types.DeclKind.FUNC) {
        const func = expr.decl.definition || expr.decl;
        const tIdx = this.funcDefToTableIdx.get(func);
        this.body.i32Const(tIdx);
        return;
      }
      if (expr.decl.declKind === Types.DeclKind.VAR) {
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
    if (expr.kind === Types.ExprKind.MEMBER) {
      this.emitAddressOf(expr.base);
      const tag = expr.base.type.tagDecl;
      const offset = this.getFieldOffset(tag, expr.memberDecl);
      if (offset) { this.body.i32Const(offset); this.body.aop(WT_I32, ALU.OP_ADD); }
      return;
    }
    if (expr.kind === Types.ExprKind.ARROW) {
      this.emitExpr(expr.base);
      const ptrType = expr.base.type.decay();
      const baseType = ptrType.baseType;
      const tag = baseType.tagDecl;
      const offset = this.getFieldOffset(tag, expr.memberDecl);
      if (offset) { this.body.i32Const(offset); this.body.aop(WT_I32, ALU.OP_ADD); }
      return;
    }
    if (expr.kind === Types.ExprKind.SUBSCRIPT) {
      const elemSize = this.sizeOf(expr.type);
      this.emitExpr(expr.array);
      this.emitExpr(expr.index);
      if (wtEquals(this.getBinaryWasmType(expr.index.type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
      if (elemSize !== 1) { this.body.i32Const(elemSize); this.body.aop(WT_I32, ALU.OP_MUL); }
      this.body.aop(WT_I32, ALU.OP_ADD);
      return;
    }
    if (expr.kind === Types.ExprKind.UNARY && expr.op === "OP_DEREF") {
      this.emitExpr(expr.operand);
      return;
    }
    if (expr.kind === Types.ExprKind.COMPOUND_LITERAL) {
      const fsAddr = this.fileScopeCompoundLiteralAddrs.get(expr);
      if (fsAddr !== undefined) { this.body.i32Const(fsAddr); }
      else {
        this.emitCompoundLiteralInit(expr);
        this.emitFrameAddr(this.compoundLiteralOffsets.get(expr));
      }
      return;
    }
    throw new Error(`emitAddressOf: unsupported expression kind ${expr.kind}`);
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
        const elemSize = this.sizeOf(lhsType.baseType);
        if (elemSize !== 1) { this.body.i32Const(elemSize); this.body.aop(WT_I32, ALU.OP_MUL); }
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
    switch (expr.kind) {
      case Types.ExprKind.INT: {
        const type = expr.type;
        if (type.kind === Types.TypeKind.LLONG || type.kind === Types.TypeKind.ULLONG) {
          this.body.i64Const(expr.value);
        } else {
          this.body.i32Const(Number(BigInt.asIntN(32, expr.value)));
        }
        break;
      }
      case Types.ExprKind.FLOAT: {
        if (expr.type.removeQualifiers() === Types.TFLOAT) this.body.f32Const(expr.value);
        else this.body.f64Const(expr.value);
        break;
      }
      case Types.ExprKind.STRING: {
        const addr = this.getStringAddress(expr.value);
        this.body.i32Const(addr);
        break;
      }
      case Types.ExprKind.IDENT: {
        if (expr.decl.declKind === Types.DeclKind.VAR) {
          const varDecl = expr.decl.definition || expr.decl;
          const gait = this.globalArrayAddrs.get(varDecl);
          if (gait !== undefined) {
            if (varDecl.type.isArray() || varDecl.type.isAggregate()) this.body.i32Const(gait);
            else { this.body.i32Const(gait); this.emitLoad(varDecl.type); }
            break;
          }
          const lait = this.localArrayOffsets.get(varDecl);
          if (lait !== undefined) {
            this.emitFrameAddr(lait);
            if (!varDecl.type.isArray() && !varDecl.type.isAggregate()) this.emitLoad(varDecl.type);
            break;
          }
          const pait = this.paramMemoryOffsets.get(varDecl);
          if (pait !== undefined) {
            this.emitFrameAddr(pait);
            if (!varDecl.type.isArray() && !varDecl.type.isAggregate()) this.emitLoad(varDecl.type);
            break;
          }
          const lit = this.localVarToWasmLocalIdx.get(varDecl);
          if (lit !== undefined) { this.body.localGet(lit); }
          else {
            const git = this.globalVarToWasmGlobalIdx.get(varDecl);
            if (git !== undefined) this.body.globalGet(git);
            else throw new Error(`emitExpr: variable '${varDecl.name}' not found`);
          }
        } else if (expr.decl.declKind === Types.DeclKind.ENUM_CONST) {
          this.body.i32Const(expr.decl.value);
        } else if (expr.decl.declKind === Types.DeclKind.FUNC) {
          const func = expr.decl.definition || expr.decl;
          const tIdx = this.funcDefToTableIdx.get(func);
          this.body.i32Const(tIdx);
        }
        break;
      }
      case Types.ExprKind.BINARY: {
        if (expr.op.endsWith("ASSIGN")) {
          this.emitAssignment(expr, ctx);
          return;
        }
        const leftType = expr.left.type, rightType = expr.right.type;
        const isComparison = ["EQ","NE","LT","GT","LE","GE"].includes(expr.op);
        const wt = this.getBinaryWasmType(isComparison ? leftType : expr.type);
        const isUnsigned = this.isUnsignedType(leftType);
        // Pointer arithmetic
        if (expr.op === "ADD" && (leftType.isPointer() || rightType.isPointer() || leftType.isArray() || rightType.isArray())) {
          let ptrExpr, intExpr, elemType;
          if (leftType.isPointer()) { ptrExpr = expr.left; intExpr = expr.right; elemType = leftType.baseType; }
          else if (leftType.isArray()) { ptrExpr = expr.left; intExpr = expr.right; elemType = leftType.baseType; }
          else if (rightType.isPointer()) { ptrExpr = expr.right; intExpr = expr.left; elemType = rightType.baseType; }
          else { ptrExpr = expr.right; intExpr = expr.left; elemType = rightType.baseType; }
          const elemSize = this.sizeOf(elemType);
          this.emitExpr(ptrExpr); this.emitExpr(intExpr);
          if (wtEquals(this.getBinaryWasmType(intExpr.type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
          if (elemSize !== 1) { this.body.i32Const(elemSize); this.body.aop(WT_I32, ALU.OP_MUL); }
          this.body.aop(WT_I32, ALU.OP_ADD);
          break;
        }
        if (expr.op === "SUB" && (leftType.isPointer() || leftType.isArray())) {
          const leftElemType = leftType.isArray() ? leftType.baseType : leftType.baseType;
          this.emitExpr(expr.left); this.emitExpr(expr.right);
          if (rightType.isPointer() || rightType.isArray()) {
            this.body.aop(WT_I32, ALU.OP_SUB);
            const elemSize = this.sizeOf(leftElemType);
            if (elemSize !== 1) { this.body.i32Const(elemSize); this.body.aop(WT_I32, ALU.OP_DIV, true); }
          } else {
            if (wtEquals(this.getBinaryWasmType(rightType), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
            const elemSize = this.sizeOf(leftElemType);
            if (elemSize !== 1) { this.body.i32Const(elemSize); this.body.aop(WT_I32, ALU.OP_MUL); }
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
      case Types.ExprKind.UNARY: {
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
            if (!expr.type.isAggregate() && !expr.type.isFunction()) this.emitLoad(expr.type);
            break;
          case "OP_ADDR":
            this.emitAddressOf(expr.operand);
            break;
        }
        break;
      }
      case Types.ExprKind.CALL: {
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
                argType = expr.arguments[i].type.decay();
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
                storeType = arg.type.decay();
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
          // Indirect call
          const calleeType = expr.callee.type.decay();
          const funcType = calleeType.isPointer() ? calleeType.baseType : calleeType;
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
          for (let i = 0; i < expr.arguments.length; i++) this.emitExpr(expr.arguments[i]);
          this.emitExpr(expr.callee);
          const typeId = getWasmFunctionTypeIdForCFunctionType(this.wmod, funcType);
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
        break;
      }
      case Types.ExprKind.SUBSCRIPT: {
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
        const elemSize = this.sizeOf(elemType);
        this.emitExpr(expr.array);
        this.emitExpr(expr.index);
        if (wtEquals(this.getBinaryWasmType(expr.index.type), WT_I64)) this.body.aop(WT_I32, ALU.OP_WRAP_I64);
        if (elemSize !== 1) { this.body.i32Const(elemSize); this.body.aop(WT_I32, ALU.OP_MUL); }
        this.body.aop(WT_I32, ALU.OP_ADD);
        if (!elemType.isAggregate()) this.emitLoad(elemType);
        break;
      }
      case Types.ExprKind.MEMBER: {
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
        else if (!expr.type.isArray() && !expr.type.isAggregate()) this.emitLoad(expr.type);
        break;
      }
      case Types.ExprKind.ARROW: {
        this.emitExpr(expr.base);
        const field = expr.memberDecl;
        const ptrType = expr.base.type.decay();
        const baseType = ptrType.baseType;
        const tag = baseType.tagDecl;
        const offset = this.getFieldOffset(tag, field);
        if (offset) { this.body.i32Const(offset); this.body.aop(WT_I32, ALU.OP_ADD); }
        if (field.bitWidth >= 0) this.emitBitFieldLoad(field);
        else if (!expr.type.isArray() && !expr.type.isAggregate()) this.emitLoad(expr.type);
        break;
      }
      case Types.ExprKind.SIZEOF_EXPR:
        this.body.i32Const(this.sizeOf(expr.expr.type)); break;
      case Types.ExprKind.SIZEOF_TYPE:
        this.body.i32Const(this.sizeOf(expr.operandType)); break;
      case Types.ExprKind.ALIGNOF_EXPR:
        this.body.i32Const(this.alignOf(expr.expr.type)); break;
      case Types.ExprKind.ALIGNOF_TYPE:
        this.body.i32Const(this.alignOf(expr.operandType)); break;
      case Types.ExprKind.IMPLICIT_CAST: {
        if (ctx === EXPR_DROP) { this.emitExpr(expr.expr, EXPR_DROP); return; }
        this.emitExpr(expr.expr);
        this.emitConversion(expr.expr.type, expr.type, expr.expr);
        break;
      }
      case Types.ExprKind.CAST: {
        this.emitExpr(expr.expr);
        this.emitConversion(expr.expr.type, expr.targetType);
        break;
      }
      case Types.ExprKind.TERNARY: {
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
      case Types.ExprKind.INTRINSIC: {
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
      case Types.ExprKind.WASM: {
        for (const arg of expr.args) this.emitExpr(arg);
        for (const b of expr.bytes) this.body.push(b);
        break;
      }
      case Types.ExprKind.COMMA: {
        for (let i = 0; i < expr.expressions.length; i++) {
          const isLast = i + 1 === expr.expressions.length;
          this.emitExpr(expr.expressions[i], isLast ? ctx : EXPR_DROP);
        }
        return;
      }
      case Types.ExprKind.COMPOUND_LITERAL: {
        const fsAddr = this.fileScopeCompoundLiteralAddrs.get(expr);
        if (fsAddr !== undefined) {
          this.body.i32Const(fsAddr);
          if (!expr.type.isArray() && !expr.type.isAggregate()) this.emitLoad(expr.type);
        } else {
          this.emitCompoundLiteralInit(expr);
          this.emitFrameAddr(this.compoundLiteralOffsets.get(expr));
          if (!expr.type.isArray() && !expr.type.isAggregate()) this.emitLoad(expr.type);
        }
        break;
      }
      case Types.ExprKind.GC_NEW: {
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
        throw new Error(`emitExpr: unhandled expression kind ${expr.kind}`);
    }
    if (ctx === EXPR_DROP) this.body.drop();
  }
}

// ====================
// generateCode orchestration
// ====================

function generateCode(units, outputFile, options) {
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
    process.stderr.write("Error: no 'main' function defined\n");
    process.exit(1);
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
    for (const cl of (unit.fileScopeCompoundLiterals || [])) {
      const addr = cg.allocateStatic(cg.sizeOf(cl.type), cg.alignOf(cl.type));
      cg.fileScopeCompoundLiteralAddrs.set(cl, addr);
    }
  }

  // Initialize file-scope compound literals
  for (const unit of units) {
    for (const cl of (unit.fileScopeCompoundLiterals || [])) {
      const addr = cg.fileScopeCompoundLiteralAddrs.get(cl);
      const baseOffset = addr - (cg.stackPages * 65536);
      if (cl.type.isArray() && cl.initList.elements.length === 1 && cl.initList.elements[0].kind === Types.ExprKind.STRING) {
        cg.writeStringLiteralToStatic(cl.initList.elements[0].value, cl.type, baseOffset);
      } else if (cl.type.isAggregate() || cl.type.isArray()) {
        cg.populateInitListStatic(cl.initList, cl.type, baseOffset);
      } else {
        const initExpr = cl.initList.elements.length === 0 ? new AST.EInt(cl.type, 0n) : cl.initList.elements[0];
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
      if (varDef.initExpr && varDef.initExpr.kind === Types.ExprKind.INIT_LIST) {
        cg.populateInitListStatic(varDef.initExpr, varDef.type, baseOffset);
      } else if (varDef.initExpr && varDef.initExpr.kind === Types.ExprKind.COMPOUND_LITERAL && varDef.type.isAggregate()) {
        cg.populateInitListStatic(varDef.initExpr.initList, varDef.type, baseOffset);
      } else if (varDef.initExpr && varDef.type.isArray() && varDef.initExpr.kind === Types.ExprKind.STRING) {
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
          (e.kind === Types.ExprKind.INT && e.value === 0n) ||
          (e.kind === Types.ExprKind.IMPLICIT_CAST && isNullConst(e.expr)) ||
          (e.kind === Types.ExprKind.CAST && isNullConst(e.expr));
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
      if (varDef.initExpr && varDef.initExpr.kind === Types.ExprKind.INT) {
        const val = Types.truncateConstInt(varDef.initExpr.value, varDef.type);
        if (wtEquals(wt, WT_F32)) globalIdx = wmod.addGlobalF32(Number(val), true);
        else if (wtEquals(wt, WT_F64)) globalIdx = wmod.addGlobalF64(Number(val), true);
        else if (wtEquals(wt, WT_I64)) globalIdx = wmod.addGlobalI64(val, true);
        else globalIdx = wmod.addGlobalI32(Number(val), true);
      } else if (varDef.initExpr && varDef.initExpr.kind === Types.ExprKind.FLOAT) {
        if (wtEquals(wt, WT_F32)) globalIdx = wmod.addGlobalF32(varDef.initExpr.value, true);
        else globalIdx = wmod.addGlobalF64(varDef.initExpr.value, true);
      } else if (varDef.initExpr && varDef.initExpr.kind === Types.ExprKind.STRING) {
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

  // Emit function bodies
  for (const unit of units) {
    for (const func of [...unit.definedFunctions, ...unit.staticFunctions]) {
      const fdef = func.definition || func;
      if (fdef !== func) continue;
      cg.emitFunctionBody(fdef);
    }
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

  return wmod.emit();
}

return { generateCode };
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

#define __builtin_clz(x) __wasm(int, (x), op 0x67)
#define __builtin_ctz(x) __wasm(int, (x), op 0x68)
#define __builtin_clzll(x) ((int)__wasm(long long, (x), op 0x79))
#define __builtin_ctzll(x) ((int)__wasm(long long, (x), op 0x7a))

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
  `,
  "fcntl.h": `
#pragma once
#include <unistd.h>
#define O_RDONLY  0
#define O_WRONLY  1
#define O_RDWR    2
#define O_CREAT   0x40
#define O_EXCL    0x80
#define O_TRUNC   0x200
#define O_APPEND  0x400
__import int __open_impl(const char *path, int flags, int mode);
int open(const char *path, int flags, ...);
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
#define S_ISDIR(m)  (((m) & S_IFMT) == S_IFDIR)
#define S_ISREG(m)  (((m) & S_IFMT) == S_IFREG)
#define S_ISLNK(m)  (((m) & S_IFMT) == S_IFLNK)

struct stat {
  unsigned long st_dev;
  unsigned long st_ino;
  unsigned long st_mode;
  unsigned long st_nlink;
  unsigned long st_size;
  long          st_atime;
  long          st_mtime;
  long          st_ctime;
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
  if ((stream->flags & __F_WRITE) && stream->buf_pos > 0) {
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
  stream->flags &= ~__F_EOF;
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
  const hrtime = timing ? (() => { const [s, ns] = process.hrtime(); return s * 1000 + ns / 1e6; }) : null;

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
    // Per-TU passes (before linking)
    Parser.lowerSetjmpLongjmp(unit, exceptionTagRegistry);
    Parser.annotateImplicitCasts(unit);
    if (!options?.compilerOptions?.noUndefined) Parser.filterUnusedDeclarations(unit);
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
  const warningFlags = { pointerDecay: false, circularDependency: false };
  const compilerOptions = { debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false, allowKnRDefinitions: false, allowImplicitFunctionDecl: false, allowUndefined: false, gcSections: false, gcNoExportRoots: false, noUndefined: false, timeReport: false, requireSources: [] };
  let noXterm = false;
  const pp = Stdlib.createDefaultPPRegistry();

  // Set up file reader
  pp.fileReader = (filePath) => {
    try {
      return Lexer.spliceLines(fs.readFileSync(filePath, "utf-8"));
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
    process.stderr.write("Usage: node compiler.js [-a <lex|parse|link|compile>] [-o output.wasm|.html|.js] [-Dname[=val]] [-Ipath] <files...>\n");
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
  } else if (action === "parse" || action === "link" || action === "compile") {
    const hrtime = () => {
      const [s, ns] = process.hrtime();
      return s * 1000 + ns / 1e6;
    };
    const timing = compilerOptions.timeReport ? { lexMs: 0, parseMs: 0 } : null;
    const units = Stdlib.parseAllUnits(fs, pp, inputFiles, { warningFlags, compilerOptions, timing });

    if (action === "parse") {
      process.stdout.write(Parser.dumpAst(units));
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
      const codegenOpts = { compilerOptions };
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
  TypeKind: Types.TypeKind,
  TagKind: Types.TagKind,
  StorageClass: Types.StorageClass,
  ExprKind: Types.ExprKind,
  StmtKind: Types.StmtKind,
  DeclKind: Types.DeclKind,
  TypeInfo: Types.TypeInfo,
  LabelKind: Types.LabelKind,
  usualArithmeticConversions: Types.usualArithmeticConversions,
  // Parser
  parseTokens: Parser.parseTokens,
  parseSource: Parser.parseSource,
  dumpAst: Parser.dumpAst,
  filterUnusedDeclarations: Parser.filterUnusedDeclarations,
  linkTranslationUnits: Parser.linkTranslationUnits,
  lowerSetjmpLongjmp: Parser.lowerSetjmpLongjmp,
  annotateImplicitCasts: Parser.annotateImplicitCasts,
  annotateExpr: Parser.annotateExpr,
  annotateStmt: Parser.annotateStmt,
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
