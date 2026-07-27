'use strict';

// `inline` is a property of the FUNCTION, not of one declaration of it
// (C11 6.7.4p1) — todos/0328. It reaches the WAST inliner as
// `fnMeta.inlineHint`, which swaps the 64-node calleeCap for the 256-node
// hintCalleeCap, so a spelling that loses the specifier silently produces
// different codegen. Before the fix, `isInline` came from each
// declaration's own specifiers and an `inline` on a prototype, on a
// re-declaration after the definition, or on a block-scope declaration was
// dropped: rows 2-5 below all reported inlineHint false.
//
// What is asserted here:
//   - fnMeta.inlineHint (read off the real WasmModule the codegen hands to
//     the inliner, not a reconstruction) is TRUE for every spelling that
//     mentions `inline` anywhere, FALSE only for the spelling that does not
//   - the hint is load-bearing: the hinted forms inline the 3 call sites
//     that the unhinted form refuses on budgetCallee, and emit identical
//     module bytes as the definition-side spelling
//   - the C11 6.7.4p7 EXTERNAL-DEFINITION rule is untouched — that one is
//     decided off the definition's OWN `inline` keyword (`isInline`), and
//     ORing it across declarations would silently accept a second external
//     definition from another TU. Both directions are pinned below.
//
// The matching execution test (all spellings compute the same answer) is
// tests/unit/conformance/inline_on_redeclaration/.
//
// Each case prints PASS/FAIL; exits non-zero on any failure.

const fs = require('fs');
const path = require('path');
const os = require('os');
const C = require('./../../compiler.js');

let failures = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); return; }
  failures++;
  console.log(`FAIL ${name}${detail !== undefined ? ' — ' + detail : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-hint-'));

// The codegen calls WAST.runPasses(this) through the exported object, so
// wrapping it reads fnMeta off the very WasmModule the inliner is about to
// consume. Snapshot at ENTRY, not after generateCode: a hinted callee that
// inlines into all its sites is then deleted by the tree-shake, so its
// funcDef no longer exists by the time the bytes come back.
const realRunPasses = C.WAST.runPasses;
let captured = null;
C.WAST.runPasses = function (wmod) {
  captured = new Map();
  const nImports = wmod.funcImports.length;
  // funcNames is [{idx, name}] over the GLOBAL function index space
  // (imports first); the inliner reads fnMeta off the same funcDefs entries.
  for (const { idx, name } of wmod.funcNames) {
    const d = wmod.funcDefs[idx - nImports];
    if (d && d.fnMeta) captured.set(name, d.fnMeta);
  }
  return realRunPasses.call(this, wmod);
};

function compileC(src, name, files) {
  const paths = [];
  if (files) {
    for (const [fname, body] of Object.entries(files)) {
      const p = path.join(TMP, fname);
      fs.writeFileSync(p, body);
      paths.push(p);
    }
  } else {
    // ONE fixed filename for every spelling: the byte-equality assertions
    // below compare whole modules, and a differing source path length
    // would move the totals on its own.
    const p = path.join(TMP, 'spelling.c');
    fs.writeFileSync(p, src);
    paths.push(p);
  }
  const pp = C.createDefaultPPRegistry();
  pp.fileReader = (fp) => { try { return fs.readFileSync(fp, 'utf-8'); } catch { return null; } };
  const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: false };
  const compilerOptions = {
    debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false,
    allowKnRDefinitions: false, allowImplicitFunctionDecl: false, allowUndefined: false,
    allowZeroLengthArrays: false, gcSections: false, gcNoExportRoots: false,
    noUndefined: false, timeReport: false, requireSources: [], backend: 'default',
    // Only so the capture below can address a funcDef BY NAME; it adds a
    // name custom section and nothing else, identically for every spelling.
    emitNames: true,
  };
  const units = C.parseAllUnits(fs, pp, paths, { warningFlags, compilerOptions });
  const link = C.linkTranslationUnits(units, compilerOptions);
  if (link.errors.length) return { linkErrors: link.errors.map(e => e.message) };
  captured = null;
  const wasm = C.generateCode(units, path.join(TMP, 'spelling.wasm'), {
    compilerOptions, warningFlags,
    fatalExit: (code) => { throw new Error('codegen fatal ' + code); },
  });
  return {
    linkErrors: [],
    fnMeta: captured,
    stats: C.WAST.lastPassStats.inline,
    bytes: wasm.length,
  };
}

// A body big enough to exceed calleeCap (64 real nodes) but not
// hintCalleeCap (256), called from three sites so the single-use bypass
// cannot mask the budget decision.
const BODY = `{
  int a=x+1,b=x+2,c=x+3,d=x+4,e=x+5;
  a+=b; b+=c; c+=d; d+=e; e+=a;
  a^=b; b^=c; c^=d; d^=e; e^=a;
  a*=3; b*=5; c*=7; d*=11; e*=13;
  a-=b; b-=c; c-=d; d-=e; e-=a;
  a|=b; b|=c; c|=d; d|=e; e|=a;
  a&=0xffff; b&=0xffff; c&=0xffff; d&=0xffff; e&=0xffff;
  return a+b+c+d+e;
}`;

const MAIN = 'int main(void){ int s = big(1)+big(2)+big(3); printf("%d\\n", s); return 0; }';

const SPELLINGS = [
  ['no-inline-anywhere', `static int big(int x) ${BODY}\n${MAIN}`, false],
  ['on-definition', `static inline int big(int x) ${BODY}\n${MAIN}`, true],
  ['on-prototype', `static inline int big(int);\nstatic int big(int x) ${BODY}\n${MAIN}`, true],
  ['on-tail-redecl', `static int big(int x) ${BODY}\nstatic inline int big(int);\n${MAIN}`, true],
  ['on-block-scope', `static int big(int x) ${BODY}\n` +
    'int main(void){ inline int big(int); int s = big(1)+big(2)+big(3); printf("%d\\n", s); return 0; }', true],
  // The declaration goes out of scope before the definition is parsed, so
  // there is no node left to chase — this is why the hint is recorded by
  // NAME on the parser and not only threaded node-to-node.
  ['on-block-scope-before-def',
    'int main(void){ inline int big(int); int s = big(1)+big(2)+big(3); printf("%d\\n", s); return 0; }\n' +
    `int big(int x) ${BODY}`, true],
];

const results = new Map();
for (const [name, body, wantHint] of SPELLINGS) {
  const r = compileC('#include <stdio.h>\n' + body, name.replace(/-/g, '_'));
  ok(`compiles/${name}`, r.linkErrors.length === 0, JSON.stringify(r.linkErrors));
  if (r.linkErrors.length) continue;
  const m = r.fnMeta.get('big');
  ok(`fnMeta-present/${name}`, !!m, 'no fnMeta for "big"');
  if (!m) continue;
  ok(`fnMeta.inlineHint/${name}`, m.inlineHint === wantHint,
     `got ${m.inlineHint}, want ${wantHint}`);
  results.set(name, r);
}

// The hint is load-bearing, not cosmetic: each hinted spelling inlines
// exactly the three sites the unhinted one refuses on budgetCallee, and
// lands on byte-identical output.
const base = results.get('no-inline-anywhere');
const ref = results.get('on-definition');
if (base && ref) {
  ok('hint-changes-inliner',
     ref.stats.inlined === base.stats.inlined + 3 &&
     ref.stats.refused.budgetCallee === base.stats.refused.budgetCallee - 3,
     JSON.stringify({ baseIn: base.stats.inlined, refIn: ref.stats.inlined,
                      baseB: base.stats.refused.budgetCallee,
                      refB: ref.stats.refused.budgetCallee }));
  ok('hint-changes-bytes', ref.bytes !== base.bytes,
     `both ${base.bytes} — the test body no longer straddles calleeCap`);
}
for (const name of ['on-prototype', 'on-tail-redecl', 'on-block-scope',
                    'on-block-scope-before-def']) {
  const r = results.get(name);
  if (!r || !ref) continue;
  // …except the forward block-scope form, whose `big` has external linkage
  // (a block-scope declaration cannot say `static`) and so keeps an
  // exported out-of-line copy the tree-shake may not delete.
  if (name !== 'on-block-scope-before-def') {
    ok(`bytes-match-on-definition/${name}`, r.bytes === ref.bytes,
       `${r.bytes} vs ${ref.bytes}`);
  }
  ok(`inlined-match-on-definition/${name}`, r.stats.inlined === ref.stats.inlined,
     `${r.stats.inlined} vs ${ref.stats.inlined}`);
}

// ---- C11 6.7.4p7 is a SEPARATE question and must not move ----
//
// p7 asks whether a TU provides an external definition, which requires ALL
// its file-scope declarations to say `inline`. `inline int f(void); int
// f(void){...}` therefore DOES provide one and collides with another TU's
// definition — the propagated hint must not launder that into an inline
// definition.
{
  const r = compileC(null, 'p7_dup', {
    'p7a.c': 'int f(void);\nint main(void){ return f(); }\n',
    'p7b.c': 'inline int f(void);\nint f(void){ return 1; }\n',
    'p7c.c': 'int f(void){ return 2; }\n',
  });
  ok('p7-decl-inline-still-external-definition',
     r.linkErrors.some(m => /Duplicate definition of symbol 'f'/.test(m)),
     JSON.stringify(r.linkErrors));
}
{
  // …and a real inline definition (all declarations inline) still coexists
  // with one external definition, as before.
  const r = compileC(null, 'p7_ok', {
    'p7d.c': 'int f(void);\nint main(void){ return f(); }\n',
    'p7e.c': 'inline int f(void){ return 1; }\n',
    'p7f.c': 'int f(void){ return 2; }\n',
  });
  ok('p7-true-inline-definition-still-links',
     r.linkErrors.length === 0, JSON.stringify(r.linkErrors));
}

C.WAST.runPasses = realRunPasses;
fs.rmSync(TMP, { recursive: true, force: true });

if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('all inline-hint propagation tests passed');
