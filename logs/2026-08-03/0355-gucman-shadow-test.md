# #141 (0355) — firing test for gucman's dispatch-shadow install guard

The install-time guard (`gm_same_file(disp, GM_DISPATCH)` in gucman's
bin-plant loop) refuses to plant `/usr/local/bin/<cmd>` over a name the base
image dispatches. It was unreachable through the shipped pipeline by design —
mkpkg refuses to *build* such a payload (that is the first tier), and gucman
verifies the payload sha256 against the index — so only its non-firing path
had coverage, and a regression could only ever fail *silently* (the backstop
stops backstopping; installs keep working).

**Approach: ticket plan 1, without any mkpkg seam.** The payload format is
just ustar(control.json + `opt/<name>/**`) + gzip, so the test builds it by
hand (~40 lines: `tarMember`/`addShadowPackage` in
`tests/kernel/test_cmdalt_e2e.js`) with a `bin: {python: "tool"}` claim,
drops it into the per-instance test repo's `pool/`, and patches that repo's
`index.json` with the matching sha256 — gucman then accepts it all the way to
the bin-plant loop, where the guard must fire. No `--force-unsafe-bin` escape
hatch was needed in mkpkg; the tool keeps refusing such definitions
unconditionally.

Assertions are guard-branch-specific: gucman's message is "would shadow the
command dispatcher at", mkpkg's build-tier message is "would shadow the
**base image's** command dispatcher at" — so a refusal from anywhere earlier
in the install (index shape, sha256, tar validation) cannot satisfy the
check. Also asserted: exit 1, no `/usr/local/bin/python`, no
`/var/lib/gucman/shadowpkg.json`, no `/opt/shadowpkg` (gm_unwind sweeps the
staged tree).

**Presence controls** (the #97 lesson): the fixture's premise — `python` is a
dispatched name — is asserted twice, host-side (derived from `os/image.json`
with mkpkg's own filter) and in-OS (`readlink /usr/bin/python` →
`/usr/bin/cmdalt`), each with a "re-pin the fixture" failure message. If
python ever stops being dispatched, the leg fails loudly instead of decaying
into a trivially-different refusal.

**RED-then-GREEN**: with the guard neutered (`if (0 && gm_same_file(...))`,
rebaked minimal image) exactly the 6 guard checks fail and the output shows
the real disaster: `RC=0`, `PYTHON-LINK-PLANTED`, `DB-RECORD`, `OPT-RESIDUE` —
a permanent PATH shadow with a DB record. Guard restored: 54/54 checks pass.

Retired `todos/LIABILITIES.md` L46 in the same commit (acceptance).
