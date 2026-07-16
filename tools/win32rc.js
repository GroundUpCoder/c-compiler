#!/usr/bin/env node
// win32rc.js — a tiny Win32 resource compiler (todos/0068, design
// todos/WIN32.md "resource story").
//
// Compiles the .rc subset the port corpus actually uses (STRINGTABLE,
// MENU, DIALOG/DIALOGEX, ACCELERATORS, BITMAP/ICON/WAVE file refs) into a
// SIDECAR resource pack: `<binary>.res` sits next to the wasm binary the
// way the resource section sits inside a PE image. os/win32/user32.c's
// loader finds it via argv0 at the first Load* call — no link-time
// coupling, so resource-less apps (gdidemo/ctldemo/k32demo) never know.
//
// The container is NOT Microsoft's .res: a minimal versioned pack —
// **the WRES format below MUST MATCH os/win32/user32.c `res_*`** (the
// loader re-declares it; change both together):
//
//   header:  "WRES" u32-version(2) u32-count
//   entries: count x { u16 type, u16 id, u32 off, u32 size }   (file offsets)
//   data:    blobs (layouts below; all little-endian, strings UTF-8)
//
//   type 2 RT_BITMAP: the raw .bmp file bytes (BITMAPFILEHEADER included)
//   type 4 RT_MENU:   menu := u16 n, n x item
//                     item := u8 kind (0 item | 1 popup | 2 separator)
//                       kind 0: u16 id, u16 textLen, text
//                       kind 1: u16 textLen, text, menu (recursive)
//   type 5 RT_DIALOG: i16 x,y,w,h (dialog units), u32 style, u16 menuId
//                     (0 = none; v2 — calc's templates carry MENU),
//                     u16 capLen, caption, u16 fontSize, u16 faceLen, face,
//                     u16 n, n x control
//                     control := u8 class (1 BUTTON 2 EDIT 3 STATIC
//                       4 LISTBOX 5 SCROLLBAR 6 COMBOBOX), i16 id,
//                       i16 x,y,w,h, u32 style, u16 textLen, text
//   type 6 RT_STRING: one entry PER STRING id (not Windows' 16-bundles);
//                     data = the UTF-8 bytes
//   type 9 RT_ACCELERATOR: u16 n, n x { u8 fFlags, u16 key, u16 cmd }
//                     fFlags = Windows ACCEL: FVIRTKEY 0x01, FNOINVERT 0x02,
//                     FSHIFT 0x04, FCONTROL 0x08, FALT 0x10
//
// Preprocessing is the pragmatic subset: #define (numeric exprs), #ifdef/
// #ifndef/#else/#endif, quoted #include (parsed for defines AND resource
// statements — the lang/xx-YY.rc pattern), angle #include (skipped),
// #pragma/LANGUAGE (skipped). Unknown identifiers in expressions fail
// LOUD; missing binary asset files are skipped with a warning on stderr
// (winmine's .ico/.wav are deliberately not vendored — LoadIcon returns a
// stub handle and PlaySound is a success stub).
//
// Usage:
//   node tools/win32rc.js <input.rc> -o <output.res> [-D SYMBOL]... [-q]
'use strict';

const fs = require('fs');
const path = require('path');

/* ---- builtin constants (values MUST MATCH os/win32/include/windows.h
 * where shared; the DS_/ES_/SS_/BS_ dialog styles are Windows') ---- */
const BUILTIN = {
  // window styles
  WS_OVERLAPPED: 0x00000000, WS_POPUP: 0x80000000, WS_CHILD: 0x40000000,
  WS_MINIMIZE: 0x20000000, WS_VISIBLE: 0x10000000, WS_DISABLED: 0x08000000,
  WS_CLIPSIBLINGS: 0x04000000, WS_CLIPCHILDREN: 0x02000000,
  WS_MAXIMIZE: 0x01000000, WS_CAPTION: 0x00C00000, WS_BORDER: 0x00800000,
  WS_DLGFRAME: 0x00400000, WS_VSCROLL: 0x00200000, WS_HSCROLL: 0x00100000,
  WS_SYSMENU: 0x00080000, WS_THICKFRAME: 0x00040000, WS_GROUP: 0x00020000,
  WS_TABSTOP: 0x00010000, WS_MINIMIZEBOX: 0x00020000, WS_MAXIMIZEBOX: 0x00010000,
  WS_EX_CLIENTEDGE: 0x200, WS_EX_STATICEDGE: 0x20000,
  // dialog styles
  DS_ABSALIGN: 0x01, DS_SYSMODAL: 0x02, DS_3DLOOK: 0x04, DS_FIXEDSYS: 0x08,
  DS_NOFAILCREATE: 0x10, DS_LOCALEDIT: 0x20, DS_SETFONT: 0x40,
  DS_MODALFRAME: 0x80, DS_NOIDLEMSG: 0x100, DS_SETFOREGROUND: 0x200,
  DS_CONTROL: 0x400, DS_CENTER: 0x800, DS_CENTERMOUSE: 0x1000,
  DS_CONTEXTHELP: 0x2000, DS_SHELLFONT: 0x40 | 0x08,
  // static styles
  SS_LEFT: 0x0, SS_CENTER: 0x1, SS_RIGHT: 0x2, SS_ICON: 0x3, SS_NOPREFIX: 0x80,
  SS_WHITERECT: 0x6, SS_GRAYRECT: 0x8, SS_SUNKEN: 0x1000, SS_CENTERIMAGE: 0x200,
  // edit styles
  ES_LEFT: 0x0, ES_CENTER: 0x1, ES_RIGHT: 0x2, ES_MULTILINE: 0x4,
  ES_UPPERCASE: 0x8, ES_LOWERCASE: 0x10, ES_PASSWORD: 0x20,
  ES_AUTOVSCROLL: 0x40, ES_AUTOHSCROLL: 0x80, ES_NOHIDESEL: 0x100,
  ES_READONLY: 0x800, ES_WANTRETURN: 0x1000, ES_NUMBER: 0x2000,
  // button styles
  BS_PUSHBUTTON: 0x0, BS_DEFPUSHBUTTON: 0x1, BS_CHECKBOX: 0x2,
  BS_AUTOCHECKBOX: 0x3, BS_RADIOBUTTON: 0x4, BS_3STATE: 0x5,
  BS_AUTO3STATE: 0x6, BS_GROUPBOX: 0x7, BS_AUTORADIOBUTTON: 0x9,
  BS_OWNERDRAW: 0xB, BS_NOTIFY: 0x4000, BS_CENTER: 0x300, BS_VCENTER: 0xC00,
  // listbox / combo styles
  LBS_NOTIFY: 0x1, LBS_SORT: 0x2, LBS_NOINTEGRALHEIGHT: 0x100,
  CBS_SIMPLE: 0x1, CBS_DROPDOWN: 0x2, CBS_DROPDOWNLIST: 0x3, CBS_SORT: 0x100,
  // the DIALOGEX position sentinel (ReactOS uses it for x)
  CW_USEDEFAULT16: 0x8000,
  // dialog ids
  IDOK: 1, IDCANCEL: 2, IDABORT: 3, IDRETRY: 4, IDIGNORE: 5, IDYES: 6,
  IDNO: 7, IDCLOSE: 8, IDHELP: 9,
  // virtual keys (the ACCELERATORS vocabulary)
  VK_BACK: 0x08, VK_TAB: 0x09, VK_RETURN: 0x0D, VK_ESCAPE: 0x1B,
  VK_SPACE: 0x20, VK_PRIOR: 0x21, VK_NEXT: 0x22, VK_END: 0x23, VK_HOME: 0x24,
  VK_LEFT: 0x25, VK_UP: 0x26, VK_RIGHT: 0x27, VK_DOWN: 0x28,
  VK_INSERT: 0x2D, VK_DELETE: 0x2E,
  VK_F1: 0x70, VK_F2: 0x71, VK_F3: 0x72, VK_F4: 0x73, VK_F5: 0x74,
  VK_F6: 0x75, VK_F7: 0x76, VK_F8: 0x77, VK_F9: 0x78, VK_F10: 0x79,
  VK_F11: 0x7A, VK_F12: 0x7B,
  // menu flags (initial-state flags legal in MENUITEM lines)
  MF_GRAYED: 0x1, MF_DISABLED: 0x2, MF_CHECKED: 0x8, MF_MENUBARBREAK: 0x20,
  MF_MENUBREAK: 0x40, MFT_RIGHTJUSTIFY: 0x4000,
  // misc that shows up in rc STYLE lines
  NOT: 0,           // handled by the expression parser, listed for clarity
};

// The <dlgs.h> standard control ids (rct1, cmb2, edt4, ... — the comdlg
// template vocabulary; notepad's PAGESETUP template uses them). Values are
// Windows' dlgs.h layout starting at ctlFirst 0x0400.
for (const [prefix, base, count] of [
  ['psh', 0x0400, 16], ['chx', 0x0410, 16], ['rad', 0x0420, 16],
  ['grp', 0x0430, 4], ['frm', 0x0434, 4], ['rct', 0x0438, 4],
  ['ico', 0x043C, 4], ['stc', 0x0440, 32], ['lst', 0x0460, 16],
  ['cmb', 0x0470, 16], ['edt', 0x0480, 16], ['scr', 0x0490, 8],
  ['ctl', 0x04A0, 1],
]) {
  for (let i = 0; i < count; i++) BUILTIN[prefix + (i + 1)] = base + i;
}
BUILTIN.IDC_STATIC = -1;

const RT = { BITMAP: 2, ICON: 3, MENU: 4, DIALOG: 5, STRING: 6, ACCELERATOR: 9, WAVE: 10 };
const CTL = { BUTTON: 1, EDIT: 2, STATIC: 3, LISTBOX: 4, SCROLLBAR: 5, COMBOBOX: 6 };

/* ---------------- CLI ---------------- */

const argv = process.argv.slice(2);
let input = null, output = null, quiet = false;
const defines = new Map();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') output = argv[++i];
  else if (a === '-D') defines.set(argv[++i], 1);
  else if (a.startsWith('-D')) defines.set(a.slice(2), 1);
  else if (a === '-q') quiet = true;
  else if (!input) input = a;
  else { console.error('win32rc: unexpected argument ' + a); process.exit(2); }
}
if (!input || !output) {
  console.error('usage: node tools/win32rc.js <input.rc> -o <output.res> [-D SYMBOL]...');
  process.exit(2);
}
const warn = (m) => { if (!quiet) console.error('win32rc: ' + m); };

/* ---------------- preprocess: lines -> token-ready text ----------------
 * Line-oriented: strips comments, resolves #ifdef trees, collects #defines
 * (numeric exprs evaluated lazily at use), inlines quoted #includes. */

const symbols = new Map(Object.entries(BUILTIN));
for (const [k, v] of defines) symbols.set(k, v);

function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else if (src[i] === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (src[i] === '"') {                 // don't eat comments in strings
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += src[i++];
    }
  }
  return out;
}

function preprocess(file, depth) {
  if (depth > 8) throw new Error('include depth exceeded at ' + file);
  // '\'-newline splices (STRINGTABLE strings wrap this way in ReactOS).
  const src = stripComments(fs.readFileSync(file, 'utf8')).replace(/\\\r?\n/g, '');
  const dir = path.dirname(file);
  const lines = src.split('\n');
  const out = [];
  const stack = [];                              // {active, seenElse}
  const active = () => stack.every((s) => s.active);
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    // rc continuation lines are rare; the corpus doesn't use them.
    const m = line.match(/^\s*#\s*(\w+)\s*(.*)$/);
    if (m) {
      const [, directive, rest] = m;
      if (directive === 'ifdef') stack.push({ active: symbols.has(rest.trim()), seenElse: false });
      else if (directive === 'ifndef') stack.push({ active: !symbols.has(rest.trim()), seenElse: false });
      else if (directive === 'else') { const t = stack[stack.length - 1]; if (t) { t.active = !t.active && !t.seenElse; t.seenElse = true; } }
      else if (directive === 'endif') stack.pop();
      else if (!active()) { /* inactive branch: skip other directives */ }
      else if (directive === 'define') {
        const dm = rest.match(/^(\w+)\s*(.*)$/);
        if (dm) symbols.set(dm[1], dm[2].trim() === '' ? 1 : dm[2].trim());
      } else if (directive === 'undef') {
        symbols.delete(rest.trim());
      } else if (directive === 'include') {
        const q = rest.match(/^"([^"]+)"/);
        if (q) {
          const inc = path.join(dir, q[1]);
          if (fs.existsSync(inc)) out.push(...preprocess(inc, depth + 1));
          else warn('include not found, skipped: ' + q[1]);
        } else {
          warn('angle include skipped: ' + rest.trim());
        }
      } else if (directive === 'pragma') { /* code_page etc: ignore */ }
      continue;
    }
    if (!active()) continue;
    if (/^\s*LANGUAGE\b/.test(line)) continue;   // locale metadata: ignore
    out.push({ text: line, file, line: li + 1, dir });
  }
  return out;
}

/* ---------------- tokenizer ---------------- */

function tokenize(lines) {
  const toks = [];
  for (const L of lines) {
    let s = L.text, i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '"') {
        let j = i + 1, v = '';
        while (j < s.length) {
          if (s[j] === '"' && s[j + 1] === '"') { v += '"'; j += 2; continue; }
          if (s[j] === '"') break;
          if (s[j] === '\\') {
            const e = s[j + 1];
            v += e === 't' ? '\t' : e === 'n' ? '\n' : e === 'r' ? '\r'
               : e === '\\' ? '\\' : e === '"' ? '"' : e;
            j += 2;
            continue;
          }
          v += s[j++];
        }
        // gucOS text is LF-native (todos/0210): the res pack is a text-in
        // path, so \r\n / lone \r normalize to \n at compile time (\r used
        // to leak a literal 'r' into the string).
        v = v.replace(/\r\n?/g, '\n');
        toks.push({ t: 'str', v, ...loc(L) });
        i = j + 1;
      } else if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < s.length && /\w/.test(s[j])) j++;
        toks.push({ t: 'id', v: s.slice(i, j), ...loc(L) });
        i = j;
      } else if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(s[i + 1]))) {
        let j = i + 1;
        while (j < s.length && /[0-9a-fA-FxX]/.test(s[j])) j++;
        toks.push({ t: 'num', v: parseInt(s.slice(i, j)), ...loc(L) });
        i = j;
      } else {
        toks.push({ t: c, ...loc(L) });
        i++;
      }
    }
    // rc continuation: a line ending in '|' or ',' continues on the next
    // (ReactOS wraps long STYLE tails) — suppress the newline token.
    const last = toks[toks.length - 1];
    if (!last || (last.t !== '|' && last.t !== ',')) toks.push({ t: 'nl', ...loc(L) });
  }
  return toks;
  function loc(L) { return { file: L.file, line: L.line, dir: L.dir }; }
}

/* ---------------- expression eval (ids, numbers, |, +, ~, NOT, parens) */

function evalName(name, where) {
  let seen = 0;
  let v = name;
  while (typeof v === 'string' && !/^-?\d/.test(v)) {
    if (!symbols.has(v)) throw new Error(`undefined identifier '${v}' at ${where}`);
    v = symbols.get(v);
    if (++seen > 32) throw new Error(`define cycle at '${name}'`);
  }
  if (typeof v === 'number') return v;
  return evalExprString(String(v), where);
}

function evalExprString(s, where) {
  // tiny recursive-descent over |, +, -, unary ~/-, NOT, parens
  let i = 0;
  function ws() { while (i < s.length && /\s/.test(s[i])) i++; }
  function primary() {
    ws();
    if (s[i] === '(') { i++; const v = expr(); ws(); if (s[i] === ')') i++; return v; }
    if (s[i] === '~') { i++; return ~primary(); }
    if (s[i] === '-') { i++; return -primary(); }
    const m = s.slice(i).match(/^(0[xX][0-9a-fA-F]+|\d+)/);
    if (m) { i += m[0].length; return parseInt(m[0]); }
    const idm = s.slice(i).match(/^\w+/);
    if (idm) {
      i += idm[0].length;
      if (idm[0] === 'NOT') { ws(); return { not: primary() }; }   // rc NOT
      return evalName(idm[0], where);
    }
    throw new Error(`bad expression '${s}' at ${where}`);
  }
  function expr() {
    let v = primary();
    for (;;) {
      ws();
      const op = s[i];
      if (op !== '|' && op !== '+' && op !== '-' && op !== '&') break;
      i++;
      const r = primary();
      v = combine(v, r, op);
    }
    return v;
  }
  function combine(a, b, op) {
    // rc's NOT clears bits from the accumulated style
    const av = typeof a === 'object' ? 0 : a, bn = typeof b === 'object';
    if (bn) return (av & ~b.not) >>> 0;
    if (typeof a === 'object') return (bv(b) & ~a.not) >>> 0;
    if (op === '|') return (av | b) >>> 0;
    if (op === '&') return (av & b) >>> 0;
    if (op === '+') return av + b;
    return av - b;
    function bv(x) { return typeof x === 'object' ? 0 : x; }
  }
  const v = expr();
  return typeof v === 'object' ? 0 : v >>> 0;
}

/* ---------------- parser over the token stream ---------------- */

const lines = preprocess(path.resolve(input), 0);
const toks = tokenize(lines);
let p = 0;

const cur = () => toks[p];
const at = (t) => cur() && cur().t === t;
const atId = (v) => cur() && cur().t === 'id' && cur().v.toUpperCase() === v;
function next() { return toks[p++]; }
function skipNl() { while (at('nl')) p++; }
function expect(t, what) {
  if (!at(t)) fail(`expected ${what || t}, got '${cur() ? cur().t + (cur().v !== undefined ? ':' + cur().v : '') : 'EOF'}'`);
  return next();
}
function fail(msg) {
  const c = cur() || toks[toks.length - 1];
  throw new Error(`win32rc: ${msg} at ${c ? c.file + ':' + c.line : 'EOF'}`);
}
function where() { const c = cur(); return c ? c.file + ':' + c.line : 'EOF'; }
function value() {                              // id-or-number scalar
  if (at('num')) return next().v;
  if (at('id')) { const t = next(); return evalName(t.v, t.file + ':' + t.line); }
  fail('expected a value');
}
// a style expression: ids/numbers joined by | + - and NOT, until , or nl
function styleExpr() {
  let acc = 0;
  let pending = null;                            // 'not' marker
  for (;;) {
    skipNothing();
    if (at('num')) { acc = apply(acc, next().v, pending); pending = null; }
    else if (at('id')) {
      const t = next();
      if (t.v.toUpperCase() === 'NOT') { pending = 'not'; continue; }
      acc = apply(acc, evalName(t.v, t.file + ':' + t.line), pending);
      pending = null;
    } else fail('expected style term');
    if (at('|') || at('+')) { next(); continue; }
    break;
  }
  return acc >>> 0;
  function apply(a, v, mode) { return mode === 'not' ? (a & ~v) >>> 0 : (a | v) >>> 0; }
  function skipNothing() { while (at('nl')) fail('style expression ran off the line'); }
}

/* resource accumulators */
const entries = [];                              // { type, id, data: Buffer }
function addEntry(type, id, data) {
  const dup = entries.find((e) => e.type === type && e.id === id);
  if (dup) fail(`duplicate resource type=${type} id=${id}`);
  entries.push({ type, id, data });
}

/* buffer builder */
function bb() {
  const parts = [];
  return {
    u8(v) { parts.push(Buffer.from([v & 0xff])); },
    u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); parts.push(b); },
    i16(v) { const b = Buffer.alloc(2); b.writeInt16LE(((v & 0xffff) << 16) >> 16); parts.push(b); },
    u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); },
    str(s) { const b = Buffer.from(s, 'utf8'); this.u16(b.length); parts.push(b); },
    raw(b) { parts.push(b); },
    done() { return Buffer.concat(parts); },
  };
}

/* ---- STRINGTABLE ---- */
function parseStringTable() {
  // optional flags up to BEGIN
  while (!atId('BEGIN') && !at('nl')) next();
  skipNl();
  expect('id', 'BEGIN');
  skipNl();
  while (!atId('END')) {
    const idTok = next();
    const id = idTok.t === 'num' ? idTok.v : evalName(idTok.v, idTok.file + ':' + idTok.line);
    if (at(',')) next();
    const s = expect('str', 'string literal').v;
    addEntry(RT.STRING, id, Buffer.from(s, 'utf8'));
    skipNl();
  }
  next();                                        // END
}

/* ---- MENU ---- */
function parseMenuBody() {
  skipNl();
  expect('id', 'BEGIN');                         // BEGIN token (id 'BEGIN')
  skipNl();
  const items = [];
  while (!atId('END')) {
    if (atId('POPUP')) {
      next();
      const text = expect('str', 'popup text').v;
      skipNl();
      const sub = parseMenuBody();
      items.push({ kind: 1, text, sub });
    } else if (atId('MENUITEM')) {
      next();
      if (atId('SEPARATOR')) { next(); items.push({ kind: 2 }); }
      else {
        const text = expect('str', 'item text').v;
        expect(',', 'comma');
        const id = value();
        // optional trailing flags (CHECKED, GRAYED...) — parsed, ignored
        while (at(',')) { next(); if (at('id')) next(); }
        items.push({ kind: 0, id, text });
      }
    } else fail('expected MENUITEM/POPUP/END');
    skipNl();
  }
  next();                                        // END
  return items;
}
function serializeMenu(items, b) {
  b.u16(items.length);
  for (const it of items) {
    b.u8(it.kind);
    if (it.kind === 0) { b.u16(it.id); b.str(it.text); }
    else if (it.kind === 1) { b.str(it.text); serializeMenu(it.sub, b); }
  }
}

/* ---- DIALOG / DIALOGEX ---- */
const CTRL_KEYWORDS = {
  LTEXT: { cls: CTL.STATIC, style: 0x50020000 /* WS_CHILD|WS_VISIBLE|WS_GROUP */ | 0, text: true },
  CTEXT: { cls: CTL.STATIC, style: 0x50020000 | 1, text: true },
  RTEXT: { cls: CTL.STATIC, style: 0x50020000 | 2, text: true },
  ICON: { cls: CTL.STATIC, style: 0x50020000 | 3, text: true },
  EDITTEXT: { cls: CTL.EDIT, style: 0x50810080 /* WS_CHILD|WS_VISIBLE|WS_BORDER|WS_TABSTOP|ES_AUTOHSCROLL */, text: false },
  DEFPUSHBUTTON: { cls: CTL.BUTTON, style: 0x50010001, text: true },
  PUSHBUTTON: { cls: CTL.BUTTON, style: 0x50010000, text: true },
  CHECKBOX: { cls: CTL.BUTTON, style: 0x50010003 /* AUTOCHECKBOX */, text: true },
  AUTOCHECKBOX: { cls: CTL.BUTTON, style: 0x50010003, text: true },
  RADIOBUTTON: { cls: CTL.BUTTON, style: 0x50010009 /* AUTORADIOBUTTON */, text: true },
  AUTORADIOBUTTON: { cls: CTL.BUTTON, style: 0x50010009, text: true },
  GROUPBOX: { cls: CTL.BUTTON, style: 0x50000007, text: true },
  LISTBOX: { cls: CTL.LISTBOX, style: 0x50810001 /* +LBS_NOTIFY */, text: false },
  COMBOBOX: { cls: CTL.COMBOBOX, style: 0x50010002, text: false },
  SCROLLBAR: { cls: CTL.SCROLLBAR, style: 0x50000000, text: false },
};
function parseDialog(id, isEx) {
  const dx = value(); expect(',', ','); const dy = value(); expect(',', ',');
  const dw = value(); expect(',', ','); const dh = value();
  skipNl();
  let style = 0x80C80080 >>> 0;                  // WS_POPUP|WS_CAPTION|DS_MODALFRAME (default-ish)
  let caption = '', fontSize = 8, fontFace = 'MS Shell Dlg', menuId = 0;
  for (;;) {
    skipNl();
    if (atId('STYLE')) { next(); style = styleExpr(); }
    else if (atId('EXSTYLE')) { next(); styleExpr(); }
    else if (atId('CAPTION')) { next(); caption = expect('str', 'caption').v; }
    else if (atId('FONT')) {
      next();
      fontSize = value();
      if (at(',')) { next(); fontFace = expect('str', 'font face').v; }
      // DIALOGEX FONT may carry weight/italic/charset tails
      while (at(',')) { next(); if (at('num') || at('id')) next(); }
    }
    else if (atId('MENU')) { next(); menuId = value(); }
    else if (atId('CLASS') || atId('CHARACTERISTICS') || atId('VERSION')) {
      next();
      while (!at('nl')) next();
    }
    else break;
  }
  skipNl();
  expect('id', 'BEGIN');
  skipNl();
  const controls = [];
  while (!atId('END')) {
    const kw = expect('id', 'control keyword').v.toUpperCase();
    if (kw === 'CONTROL') {                      // generic control
      const text = expect('str', 'text').v; expect(',', ',');
      const cid = value(); expect(',', ',');
      const clsName = expect('str', 'class').v.toUpperCase(); expect(',', ',');
      const st = styleExpr(); expect(',', ',');
      const x = value(); expect(',', ','); const y = value(); expect(',', ',');
      const w = value(); expect(',', ','); const h = value();
      while (at(',')) { next(); styleExpr(); }   // exstyle tail
      const cls = CTL[clsName];
      if (!cls) fail(`unsupported CONTROL class '${clsName}'`);
      controls.push({ cls, id: cid, x, y, w, h, style: (st | 0x40000000) >>> 0, text });
    } else {
      const spec = CTRL_KEYWORDS[kw];
      if (!spec) fail(`unsupported dialog control '${kw}'`);
      let text = '';
      if (spec.text) { text = expect('str', 'text').v; expect(',', ','); }
      const cid = value(); expect(',', ',');
      const x = value(); expect(',', ','); const y = value(); expect(',', ',');
      const w = value(); expect(',', ','); const h = value();
      let style = spec.style >>> 0;
      if (at(',')) {                             // optional style tail
        next();
        if (!at('nl')) style = (style | styleExpr()) >>> 0;
        while (at(',')) { next(); if (!at('nl')) styleExpr(); }  // exstyle
      }
      controls.push({ cls: spec.cls, id: cid, x, y, w, h, style, text });
    }
    skipNl();
  }
  next();                                        // END
  const b = bb();
  b.i16(dx); b.i16(dy); b.i16(dw); b.i16(dh);
  b.u32(style);
  b.u16(menuId);
  b.str(caption);
  b.u16(fontSize); b.str(fontFace);
  b.u16(controls.length);
  for (const c of controls) {
    b.u8(c.cls); b.i16(c.id);
    b.i16(c.x); b.i16(c.y); b.i16(c.w); b.i16(c.h);
    b.u32(c.style); b.str(c.text);
  }
  addEntry(RT.DIALOG, id, b.done());
  void isEx;
}

/* ---- ACCELERATORS ---- */
function parseAccelerators(id) {
  skipNl();
  expect('id', 'BEGIN');
  skipNl();
  const acc = [];
  while (!atId('END')) {
    let key, flags = 0;
    if (at('str')) {
      const s = next().v;
      if (s.startsWith('^') && s.length === 2) { key = s.toUpperCase().charCodeAt(1); flags |= 0x08 | 0x01; }
      else key = s.toUpperCase().charCodeAt(0);
    } else {
      key = value();
    }
    expect(',', ',');
    const cmd = value();
    while (at(',')) {
      next();
      const f = expect('id', 'accel flag').v.toUpperCase();
      if (f === 'VIRTKEY') flags |= 0x01;
      else if (f === 'NOINVERT') flags |= 0x02;
      else if (f === 'SHIFT') flags |= 0x04;
      else if (f === 'CONTROL') flags |= 0x08;
      else if (f === 'ALT') flags |= 0x10;
      else if (f === 'ASCII') { /* default */ }
      else fail(`unknown accelerator flag '${f}'`);
    }
    acc.push({ flags, key, cmd });
    skipNl();
  }
  next();                                        // END
  const b = bb();
  b.u16(acc.length);
  for (const a of acc) { b.u8(a.flags); b.u16(a.key); b.u16(a.cmd); }
  addEntry(RT.ACCELERATOR, id, b.done());
}

/* ---- file-backed resources (BITMAP / ICON / WAVE) ---- */
function parseFileResource(id, type, dir) {
  const f = expect('str', 'file name').v;
  const full = path.join(dir, f);
  if (!fs.existsSync(full)) {
    warn(`asset not vendored, resource skipped: ${f} (type ${type} id ${id})`);
    return;
  }
  addEntry(type, id, fs.readFileSync(full));
}

/* ---- top level ---- */
while (p < toks.length) {
  skipNl();
  if (p >= toks.length) break;
  const t = next();
  if (t.t !== 'id' && t.t !== 'num') fail(`unexpected top-level token '${t.t}'`);
  if (t.t === 'id' && t.v.toUpperCase() === 'STRINGTABLE') { parseStringTable(); continue; }
  // <name-id> TYPE ...
  const id = t.t === 'num' ? t.v : evalName(t.v, t.file + ':' + t.line);
  const typeTok = expect('id', 'resource type');
  const type = typeTok.v.toUpperCase();
  if (type === 'MENU' || type === 'MENUEX') {
    const items = parseMenuBody();
    const b = bb();
    serializeMenu(items, b);
    addEntry(RT.MENU, id, b.done());
  } else if (type === 'DIALOG' || type === 'DIALOGEX') {
    parseDialog(id, type === 'DIALOGEX');
  } else if (type === 'ACCELERATORS') {
    parseAccelerators(id);
  } else if (type === 'BITMAP') {
    parseFileResource(id, RT.BITMAP, typeTok.dir);
  } else if (type === 'ICON') {
    parseFileResource(id, RT.ICON, typeTok.dir);
  } else if (type === 'WAVE') {
    parseFileResource(id, RT.WAVE, typeTok.dir);
  } else {
    fail(`unsupported resource type '${type}'`);
  }
}

/* ---------------- emit ---------------- */
const HDR = 12, ENT = 12;
let off = HDR + entries.length * ENT;
const head = Buffer.alloc(HDR + entries.length * ENT);
head.write('WRES', 0, 'ascii');
head.writeUInt32LE(2, 4);
head.writeUInt32LE(entries.length, 8);
entries.forEach((e, i) => {
  const base = HDR + i * ENT;
  head.writeUInt16LE(e.type, base);
  head.writeUInt16LE(e.id & 0xffff, base + 2);
  head.writeUInt32LE(off, base + 4);
  head.writeUInt32LE(e.data.length, base + 8);
  off += e.data.length;
});
fs.writeFileSync(output, Buffer.concat([head, ...entries.map((e) => e.data)]));
if (!quiet) {
  const byType = {};
  for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log(`win32rc: ${output}: ${entries.length} resources (` +
    Object.entries(byType).map(([t, n]) => `type${t}x${n}`).join(' ') + `), ${off} bytes`);
}
