# 0436 — patchcheck.mjs: clip the mismatch pair around the first difference

## The defect

`reverseApply` found a context mismatch and printed two clipped strings. The old
`clip()` at `patchcheck.mjs:228` cut each string at character 57, from column 0.
When the difference sat after the cut, the two strings looked identical. The
reader saw a failure with no visible cause. The defect was worst for a small
edit deep in a long line of C. That is the exact case todos/0423's check exists
to catch.

## The fix

One new exported function, `clipPair(a, b)`, replaces the two `clip()` calls at
the one call site. It finds the first column where the two lines differ. It
opens a 60-character window approximately 20 characters before that column. It
pulls the window left when the window would pass the end of both lines. It marks
a cut at each end with `…`. It returns the 1-based column, and the message now
prints it: `context mismatch at line N column C`.

Decisions:

- A short pair shows whole. The window start is 0 when the longer line fits in
  the window. So a near-start mismatch does not get a useless leading ellipsis.
- When one line is a prefix of the other, the column is one past the end of the
  shorter line.
- Equal inputs anchor the window at the common end and report
  `col = length + 1`. The caller never passes equal inputs. The comment in the
  code states this contract.
- `clip()` had exactly one call site. It is deleted.

## Proof by execution

I reproduced the bad output on the unmodified checker first. An injection at
column 60 of `content/content.c:450` printed two identical quoted strings. After
the fix, a five-point injection matrix (columns 1, 31, 60, 64, and a
length-changing edit) rendered a visible difference and the correct column in
every message. Every injection printed its edit and asserted the file changed
before the run. Every restore returned the tree to
`68 file check(s), 0 failure(s)` at exit 0. The before message and the full
matrix are in the ticket, `todos/done/0436-*.md`.

Tests: 8 new checks in `tests/netsurf/patchcheck.test.mjs` (37 → 45 executed
checks): seven `clipPair` unit shapes (column 0, near start, mid-line, end of
line, prefix pair, long-line length drift, equal inputs) plus one regression
guard that replays the ticket's deep-line tamper through `reverseApply` and
asserts the two quoted strings differ and the message names column 60. No new
test file; the `netsurf-patch` suite stays 2/2.
