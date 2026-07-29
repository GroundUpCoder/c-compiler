# 0436 — patchcheck.mjs's mismatch diagnostic clips both sides from column 0, hiding the drift it reports

- **Status**: open
- **Design**: —

## Goal

`vendor/netsurf/patchcheck.mjs` finds a context mismatch correctly. But it reports the
mismatch badly. The message shows two strings. When the difference is far from the start of
the line, the two strings look the same. The reader cannot see the difference.

The cause is the `clip()` function at `patchcheck.mjs:228`:

```js
function clip(s) { return s.length > 60 ? s.slice(0, 57) + '…' : s; }
```

The call site at `patchcheck.mjs:193` clips each side independently. Each clip starts at
column 0. If the two lines are the same for the first 57 characters, the message shows the
same text two times.

This is a measured defect, not a theory. todos/0423's gate injected one character at column
59 of `vendor/netsurf/netsurf/content/content.c`. The check failed correctly with exit 1. It
printed this message:

```
context mismatch at line 450: the tree has "bool content_key_release(struct hlcache_handle *h, uint32…",
                              the record expects "bool content_key_release(struct hlcache_handle *h, uint32…"
```

The two quoted strings are identical. The injected character is after the cut.

The defect is worst in the case that matters most. `todos/0423` exists to catch a small,
quiet edit to a vendored file. A small edit is usually deep in a long line of C. So the
diagnostic is least useful exactly where the check is most valuable.

## Plan

1. Add a function that clips a **pair** of lines around the first column where they differ.
   Keep the existing behaviour when the two lines differ near the start.
2. Show a leading ellipsis when the window does not start at column 0. Show a trailing
   ellipsis when the window does not reach the end.
3. Give the reader the column number of the first difference.
4. Replace the two independent `clip()` calls at `patchcheck.mjs:193` with the new function.
5. Keep `clip()` for the single-string sites, or delete it if no site remains.

A sufficient shape:

```js
function clipPair(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const start = Math.max(0, i - 20);
  const cut = s => (start > 0 ? '…' : '') + s.slice(start, start + 60)
                 + (s.length > start + 60 ? '…' : '');
  return { a: cut(a), b: cut(b), col: i + 1 };
}
```

## Acceptance

1. Inject one character at column 59 or later of a patched file. Run
   `node vendor/netsurf/patchcheck.mjs`. The exit code stays 1. The two quoted strings in the
   message are **different**, and the difference is visible.
2. The message names the column of the first difference.
3. A mismatch near the start of a line still reads well. It does not gain a useless leading
   ellipsis.
4. `node tests/netsurf/run.js` stays 2/2.
5. The tests in `tests/netsurf/patchcheck.test.mjs` that assert on message text still pass, or
   the test updates travel in the same commit.

## Provenance

todos/0423's coordinator gate found this. The gate ran an injection battery against branch
`0423-patch-record` at `0629dcb1`. Test A of that battery produced the message above. The
defect does not affect correctness. Every injection failed with the correct exit code. Only
the explanation is wrong, so this item is P2 and light.
