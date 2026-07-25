#!/usr/bin/env bash
# Regenerate the committed JavaScript bindings at genjs/duktape/.
#
#   ./regen-js-bindings.sh [--src DIR] [--check]
#
# *** MAINTAINER-ONLY.  NO BUILD EVER RUNS THIS. ***
#
# The nsgenbind output is COMMITTED (genjs/duktape/: 223 .c + 3 headers + the
# two xxd'd .js blobs + the generated source-list Makefile).  That is
# deliberate, and load-bearing:
#
#   nsgenbind is a flex+bison tool needing **GNU bison >= 3**.  Apple ships
#   bison 2.3, and there is no package manager on the reference machine, so a
#   build-time dependency on nsgenbind would mean every checkout had to build
#   bison 3 from source first.  Committing the generated C means a normal
#   build — `node vendor/netsurf/smoke.mjs`, an OS image bake, the run.py
#   projects suite — needs NO bison, NO flex and NO nsgenbind at all.  Only
#   editing a .bnd/.idl brings this script into play.  Keep it that way: do
#   NOT wire regeneration into any build graph.
#
# Run this after editing netsurf/content/handlers/javascript/duktape/*.bnd or
# netsurf/content/handlers/javascript/WebIDL/*.idl, then commit the genjs/
# diff alongside the .bnd change (committed output is what makes a binding
# edit reviewable).  If the interface set changed, the generated source list
# moves too — this script rewrites netsurf-core.json's `genjs/duktape/*.c`
# block from the generated Makefile's NSGENBIND_SOURCES so the two can never
# drift.  `--check` regenerates into a temp dir and diffs instead of
# installing: the drift gate.
#
#   --src DIR   use existing clones in DIR/{nsgenbind,buildsystem} instead of
#               cloning (each must contain the pinned revision)
#
# Host tools needed: git, cc, flex, **bison >= 3** (set $BISON to point at it
# if it is not the `bison` on PATH), node.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR=""
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC_DIR="$2"; shift 2 ;;
    --check) CHECK=1; shift ;;
    *) echo "usage: $0 [--src DIR] [--check]" >&2; exit 2 ;;
  esac
done

pin() { node -e "console.log(require('$HERE/UPSTREAM.json').tools['$1'].rev)"; }
url() { node -e "console.log(require('$HERE/UPSTREAM.json').tools['$1'].url)"; }

# ---- 0. host tool gate: fail LOUD and early, never half-generate ----
BISON="${BISON:-bison}"
if ! command -v "$BISON" >/dev/null 2>&1; then
  echo "regen: no bison found (set \$BISON).  nsgenbind needs GNU bison >= 3." >&2
  exit 1
fi
bison_ver="$("$BISON" --version | head -1 | sed -e 's/.* //')"
bison_major="${bison_ver%%.*}"
if [ "${bison_major:-0}" -lt 3 ]; then
  cat >&2 <<EOF
regen: $BISON is GNU bison $bison_ver — nsgenbind needs >= 3.
       (Apple ships 2.3.  Build one from source and re-run with
        BISON=/path/to/bison-3.x/bin/bison, e.g.
          curl -LO https://ftp.gnu.org/gnu/bison/bison-3.8.2.tar.gz
          tar xf bison-3.8.2.tar.gz && cd bison-3.8.2
          ./configure --prefix=\$PWD/../tools && make -j8 install)
       NOTHING ELSE in this repo needs bison: the generated bindings are
       committed at genjs/.  You only need this to EDIT a .bnd/.idl.
EOF
  exit 1
fi
command -v flex >/dev/null 2>&1 || { echo "regen: no flex on PATH" >&2; exit 1; }
echo "using $BISON (GNU bison $bison_ver), $(command -v flex)"

STAGE="$(mktemp -d /tmp/netsurf-genbind.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
echo "staging in $STAGE"

# ---- 1. the generator, at its pinned revision ----
for c in nsgenbind buildsystem; do
  rev="$(pin "$c")"
  mkdir -p "$STAGE/$c"
  if [ -n "$SRC_DIR" ]; then
    git -C "$SRC_DIR/$c" archive "$rev" | tar -x -C "$STAGE/$c"
  else
    git clone --quiet "$(url "$c")" "$STAGE/.clone-$c"
    git -C "$STAGE/.clone-$c" archive "$rev" | tar -x -C "$STAGE/$c"
    rm -rf "$STAGE/.clone-$c"
  fi
  echo "  $c @ $rev"
done

echo "building nsgenbind…"
make -C "$STAGE/nsgenbind" -j8 \
  NSSHARED="$STAGE/buildsystem" \
  BISON="$BISON" \
  PREFIX="$STAGE/prefix" install >"$STAGE/nsgenbind-build.log" 2>&1 || {
    echo "regen: nsgenbind build FAILED — tail of $STAGE/nsgenbind-build.log:" >&2
    tail -30 "$STAGE/nsgenbind-build.log" >&2
    exit 1
  }
NSGENBIND="$STAGE/prefix/bin/nsgenbind"
[ -x "$NSGENBIND" ] || { echo "regen: nsgenbind did not install at $NSGENBIND" >&2; exit 1; }

# ---- 2. generate ----
# nsgenbind bakes the paths it is GIVEN, verbatim, into its output: the outdir
# into every generated file's self-includes (#include "duktape/binding.h") and
# the .bnd path into `#line` directives.  Both must therefore be spelled
# exactly as the committed sources spell them, or regeneration "drifts" by
# nothing but path strings.  The committed spelling is outdir `duktape` and
# bnd `../netsurf/…` — i.e. what you get running from vendor/netsurf/genjs.
# So stage that exact geometry (a symlink to the real netsurf tree beside a
# scratch genjs) instead of generating into the working tree: same relative
# paths, zero risk of a failed run leaving a half-written genjs/.
#   `genjs` is on netsurf-core.json's include list, so the self-include
#   "duktape/binding.h" resolves to genjs/duktape/binding.h.
BND='../netsurf/content/handlers/javascript/duktape/netsurf.bnd'
IDL='../netsurf/content/handlers/javascript/WebIDL'
mkdir -p "$STAGE/tree/genjs"
ln -s "$HERE/netsurf" "$STAGE/tree/netsurf"
OUT="$STAGE/tree/genjs"
echo "generating bindings…"
( cd "$OUT" && mkdir -p duktape &&
  "$NSGENBIND" -D -I "$IDL" "$BND" duktape \
    >"$STAGE/genbind.log" 2>&1 ) || {
    echo "regen: nsgenbind FAILED — tail of $STAGE/genbind.log:" >&2
    tail -30 "$STAGE/genbind.log" >&2
    exit 1
  }
# `-D` is upstream's own GBFLAGS (duktape/Makefile: "ensure genbind generates
# debugging files") and it does change the generated C — it is what puts the
# `#line` directives back to the .bnd — so keep it and drop the debug spill it
# also writes.  Then assert nothing UNEXPECTED is left: a future nsgenbind that
# emits a new kind of source must fail loudly here rather than have it silently
# dropped on the floor.
rm -f "$OUT"/duktape/binding-ast "$OUT"/duktape/binding-trace \
      "$OUT"/duktape/ir-map "$OUT"/duktape/ir.dot \
      "$OUT"/duktape/webidl-ast "$OUT"/duktape/webidl-*.idl-trace \
      "$OUT"/duktape/*.dbg
unexpected="$(cd "$OUT/duktape" && ls | grep -v -e '\.c$' -e '\.h$' -e '^Makefile$' || true)"
if [ -n "$unexpected" ]; then
  echo "regen: nsgenbind emitted files this script does not classify:" >&2
  echo "$unexpected" | sed 's/^/  /' >&2
  echo "  → decide whether each is source (commit it) or debug spill (prune it)" >&2
  exit 1
fi

# ---- 3. the two xxd'd JS blobs (upstream duktape/Makefile's XXD rules) ----
# netsurf's own tools/xxd (kept by update.sh's prune whitelist for exactly
# this, the libcss gen_parser precedent), plus upstream's symbol-renaming sed.
# xxd -i derives the array's C symbol from the input PATH, and upstream's sed
# rewrites the one path spelling its own build produces — so run this from the
# netsurf root with that exact relative path, or the sed silently misses and
# the .inc declares an array dukky.c never sees.
cc -O2 -o "$STAGE/xxd" "$HERE/netsurf/tools/xxd.c"
for js in generics polyfill; do
  rel="content/handlers/javascript/duktape/$js.js"
  ( cd "$HERE/netsurf" && "$STAGE/xxd" -i "$rel" "$STAGE/$js.tmp" )
  sed -e "s/content_handlers_javascript_duktape_${js}_js/${js}_js/" \
    "$STAGE/$js.tmp" > "$OUT/duktape/$js.js.inc"
  grep -q "unsigned char ${js}_js\[\]" "$OUT/duktape/$js.js.inc" || {
    echo "regen: $js.js.inc has no ${js}_js[] symbol — xxd path/sed mismatch" >&2
    exit 1
  }
done

# ---- 4. install or gate ----
# In --check mode report BOTH the tree drift and the source-list drift before
# failing: a stale genjs/ and a stale netsurf-core.json have different fixes,
# and stopping at the first hides the other.
if [ "$CHECK" = 1 ]; then
  rc=0
  if diff -r "$HERE/genjs/duktape" "$OUT/duktape" >"$STAGE/drift.diff" 2>&1; then
    echo "regen --check: genjs/duktape is byte-identical to a fresh generation"
  else
    echo "regen --check: DRIFT — committed genjs/ differs from a fresh generation:" >&2
    head -60 "$STAGE/drift.diff" >&2
    rc=1
  fi
  node "$HERE/genjs-sources.mjs" "$OUT/duktape/Makefile" \
    "$HERE/netsurf-core.json" --check || rc=1
  exit "$rc"
else
  # Keep netsurf-core.json's source list == nsgenbind's own manifest.
  node "$HERE/genjs-sources.mjs" "$OUT/duktape/Makefile" "$HERE/netsurf-core.json"
  rm -rf "$HERE/genjs/duktape"
  mkdir -p "$HERE/genjs"
  cp -R "$OUT/duktape" "$HERE/genjs/duktape"
  echo "installed $(ls "$HERE/genjs/duktape"/*.c | wc -l | tr -d ' ') generated .c into genjs/duktape/"
  echo "done.  Now: node vendor/netsurf/smoke.mjs && node vendor/netsurf/smoke-js.mjs"
fi
