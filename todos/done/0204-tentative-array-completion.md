# 0204 — tentative int arr[] gets 0 bytes; next global overlaps it

- **Status**: done (2026-07-16) — end-of-TU tentative completion pass in linkTranslationUnits (unsized tentative array → arrayOf(base,1) after definition merge); conformance test tentative_array; full gate green
- **Design**: CLAUDE.md "Conformance tests", C11 6.9.2p2

## Goal

`int arr2[]; int next = 42;` — the tentative unsized array sizes to 0
bytes at allocateStatic, so the next global lands at the SAME address and
`arr2[0]=7` clobbers it. C11 6.9.2p2 (EXAMPLE 2) requires end-of-TU
completion to one element, zero-initialized; clang/gcc do that (with a
warning).

## Plan

No end-of-TU tentative-definition completion exists. Add it in
linkTranslationUnits after definition merge: any winning DVar definition
that is still a tentative definition with an unsized array type
(arraySize 0, no FAM confusion — file-scope only) gets its type replaced
with arrayOf(base, 1). Conformance test `tentative_array` (extern +
static flavors, adjacent-global no-overlap probe).

## Acceptance

- New conformance test fails before, passes after.
- Full estate green.
