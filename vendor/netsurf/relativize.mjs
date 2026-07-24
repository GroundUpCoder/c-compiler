#!/usr/bin/env node
// Include-relativization for the vendored NetSurf constellation.
//
// Why: the gucOS build (lib.json/bin.json) flattens every component's -I
// dirs into ONE ordered list, and five NetSurf components each carry their
// own `utils/…` (and `charset/detect.h`) header namespaces.  A quote-include
// like `#include "utils/utils.h"` inside libcss would resolve against the
// FIRST -I dir that has one (the netsurf core tree), not against libcss's
// own copy.  C11 6.10.2p3 searches the including file's own directory
// before the -I list, so rewriting the ambiguous includes to
// includer-relative paths ("../utils/utils.h") pins each one to the file
// its component means — with zero build-system machinery.
//
// This script does that MECHANICALLY, so it can be re-run on any future
// upstream pull instead of maintaining a 300-line sed:
//   for every quote-include P in every .c/.h under the component trees:
//     - if <dir-of-includer>/P exists, C already resolves it right: skip.
//     - LIB components: if P exists in MORE THAN ONE component's roots and
//       the includer's own component provides it, rewrite to the
//       includer-relative path.  This makes the lib trees include-order
//       INDEPENDENT — any lib.json dep expansion order links right.
//     - netsurf core: rewrite only when the canonical flattened -I order
//       (INCLUDE_ORDER below) would resolve P to a different file than the
//       core's own — the core is always the app root and its include dirs
//       are listed FIRST in every app json (documented in README.md), so
//       its own `utils/…` spellings stay upstream-clean.
//
// Usage:
//   node relativize.mjs <tree-root>            rewrite in place, print count
//   node relativize.mjs <tree-root> --check    report needed rewrites, exit 1
//                                              if any (drift gate: a freshly
//                                              vendored tree must come out
//                                              clean after update.sh ran it)
//
// <tree-root> is the directory holding the component subdirs — the staging
// dir during update.sh, or vendor/netsurf itself for --check.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Component → its own include roots, in the order its own build searches
// them.  INCLUDE_ORDER below is the canonical flattened -I list; the
// committed lib.jsons and nsmonkey.json MUST list their include dirs in an
// order consistent with it (netsurf core first, then shim, then the libs).
const LIBS = {
  netsurf: ['netsurf', 'netsurf/include', 'netsurf/content/handlers', 'netsurf/frontends'],
  shim: ['shim'],
  libwapcaplet: ['libwapcaplet/include', 'libwapcaplet/src'],
  libparserutils: ['libparserutils/include', 'libparserutils/src'],
  libhubbub: ['libhubbub/include', 'libhubbub/src'],
  libdom: ['libdom/include', 'libdom/src', 'libdom/bindings/hubbub'],
  libcss: ['libcss/include', 'libcss/src'],
  libnsgif: ['libnsgif/include', 'libnsgif/src'],
  libnsbmp: ['libnsbmp/include', 'libnsbmp/src'],
  libnsutils: ['libnsutils/include', 'libnsutils/src'],
  libnsfb: ['libnsfb/include', 'libnsfb/src'],
};
const INCLUDE_ORDER = Object.values(LIBS).flat();

const root = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!root) {
  console.error('usage: node relativize.mjs <tree-root> [--check]');
  process.exit(2);
}

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(c|h)$/.test(e.name)) yield p;
  }
}

const INC_RE = /^([ \t]*#[ \t]*include[ \t]*)"([^"]+)"/gm;
let rewrites = 0;
const report = [];

for (const [lib, ownRoots] of Object.entries(LIBS)) {
  for (const r of ownRoots) {
    const dir = path.join(root, r);
    // Only scan a root that is not a parent of another scanned root twice:
    // dedup by absolute file path.
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      let changed = false;
      const out = src.replace(INC_RE, (m, pre, inc) => {
        // Includer-relative already resolves: C picks it first — leave it.
        if (exists(path.join(path.dirname(file), inc))) return m;
        const intended = ownRoots.find((d) => exists(path.join(root, d, inc)));
        if (!intended) return m;                     // deliberately foreign
        if (lib === 'netsurf') {
          // Core rule: canonical order must land on the core's own file.
          const winner = INCLUDE_ORDER.find((d) => exists(path.join(root, d, inc)));
          if (winner === intended) return m;
        } else {
          // Lib rule: only a path provided by 2+ components is ambiguous.
          const providers = new Set(
            Object.entries(LIBS)
              .filter(([, roots]) => roots.some((d) => exists(path.join(root, d, inc))))
              .map(([name]) => name));
          if (providers.size <= 1) return m;
        }
        const target = path.join(root, intended, inc);
        let rel = path.relative(path.dirname(file), target).split(path.sep).join('/');
        changed = true;
        rewrites++;
        report.push(`${path.relative(root, file)}: "${inc}" -> "${rel}"`);
        return `${pre}"${rel}"`;
      });
      if (changed && !checkOnly) fs.writeFileSync(file, out);
    }
  }
}

// Dedup report lines (files reachable through nested roots are visited once
// per root; the rewrite itself is idempotent — after the first pass the
// include is includer-relative and skips).
const uniq = [...new Set(report)];
if (checkOnly) {
  if (uniq.length) {
    console.error(`relativize --check: ${uniq.length} unresolved ambiguous include(s):`);
    for (const l of uniq) console.error('  ' + l);
    process.exit(1);
  }
  console.log('relativize --check: clean');
} else {
  console.log(`relativize: rewrote ${uniq.length} include(s)`);
}
