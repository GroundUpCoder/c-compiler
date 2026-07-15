# 0205 — automatic-storage FAM initializer accepted; clobbers the frame

- **Status**: done (2026-07-16) — automatic-storage FAM init rejected (recoverable parse error) via initListInitializesFAM after normalizeInitList; static/file-scope FAM init pinned working in fam_init_ok; full gate green
- **Design**: CLAUDE.md "Conformance tests", C11 6.7.2.1

## Goal

`struct FAM {int n; int data[];}; struct FAM f = {1,{2,3}};` as a LOCAL
was accepted (gcc/clang reject) and the FAM element stores ran past the
plain-sizeOf frame slot — silent frame corruption (the repro's printf
output vanished entirely). Static-storage FAM init is fine (the object is
sized via computeInitAllocSize).

## Plan

Reject (the conformant option): after normalizeInitList in the
block-scope decl path, a non-STATIC object whose init list provides FAM
elements (initListInitializesFAM, mirroring computeFAMExtraSize's
non-zero condition) gets a recoverable parse error. diag conformance test
`diag_local_fam_init`; positive legs (short init, block-scope static,
file-scope) covered in `fam_init_ok`.

## Acceptance

- diag test fails before, passes after; positive cases unchanged.
- Full estate green.
