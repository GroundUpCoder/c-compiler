'use strict';

// JS-level unit tests for WAST validate()'s control-structure rules —
// specifically the one-else-per-if rule (todos/0227 W2). No C-level
// producer can emit a double else today; this is defensive substrate
// hardening so a future pass bug surfaces as the substrate's named error
// ("second else in one if") instead of V8's opaque rejection of the
// serialized module. Both layers are covered: validate() for pass output
// (hand-built node lists — the builder can no longer produce the shape)
// and WastBuilder.else_() at the producing site.
//
// Each case prints PASS/FAIL; exits non-zero on any failure.

const C = require('../../compiler.js');
const { WAST } = C;
const { WastBuilder, WIf, WElse, WEnd, WNop } = WAST;

let failures = 0;

function ok(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

function throwsWith(fn, needle) {
  try { fn(); return false; } catch (e) { return String(e.message).includes(needle); }
}

const EMPTY = { tag: 'empty' };

// ---- validate(): hand-built node lists ----

ok('if-else-end validates', (() => {
  try { WAST.validate([new WIf(EMPTY), new WNop(), new WElse(), new WNop(), new WEnd()], null); return true; }
  catch { return false; }
})());

ok('double else rejected', throwsWith(
  () => WAST.validate([new WIf(EMPTY), new WElse(), new WElse(), new WEnd()], null),
  'second else in one if'));

ok('else outside if still rejected', throwsWith(
  () => WAST.validate([new WElse()], null),
  'else outside an if'));

// One else each across nested ifs is fine — the seen-set is per-WIf.
ok('nested if-else validates', (() => {
  try {
    WAST.validate([
      new WIf(EMPTY), new WElse(),
      new WIf(EMPTY), new WElse(), new WEnd(),
      new WEnd(),
    ], null);
    return true;
  } catch { return false; }
})());

// The inner if's else must not satisfy (or poison) the outer if's slot:
// after the inner END pops, a second else on the OUTER if is still a
// duplicate.
ok('outer double else rejected after nested if', throwsWith(
  () => WAST.validate([
    new WIf(EMPTY), new WElse(),
    new WIf(EMPTY), new WElse(), new WEnd(),
    new WElse(),
    new WEnd(),
  ], null),
  'second else in one if'));

// Two sequential ifs each take one else — node identity, not position.
ok('sequential if-else pairs validate', (() => {
  try {
    WAST.validate([
      new WIf(EMPTY), new WElse(), new WEnd(),
      new WIf(EMPTY), new WElse(), new WEnd(),
    ], null);
    return true;
  } catch { return false; }
})());

// ---- WastBuilder.else_(): the producing site ----

ok('builder if/else/end builds', (() => {
  try {
    const b = new WastBuilder();
    b.if_(EMPTY); b.nop(); b.else_(); b.nop(); b.end();
    return b.nodes.length === 5;
  } catch { return false; }
})());

ok('builder second else_ throws', throwsWith(() => {
  const b = new WastBuilder();
  b.if_(EMPTY); b.else_(); b.else_();
}, 'second else_() in one if'));

ok('builder else_ outside if throws', throwsWith(() => {
  const b = new WastBuilder();
  b.else_();
}, 'else_() outside an if'));

ok('builder else_ inside block throws', throwsWith(() => {
  const b = new WastBuilder();
  b.block(); b.else_();
}, 'else_() outside an if'));

// A fresh if after a closed if/else takes its own else.
ok('builder sequential else_ ok', (() => {
  try {
    const b = new WastBuilder();
    b.if_(EMPTY); b.else_(); b.end();
    b.if_(EMPTY); b.else_(); b.end();
    return true;
  } catch { return false; }
})());

process.exit(failures ? 1 : 0);
