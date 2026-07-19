# gucOS Unicode Phase B — tty IUTF8 + downstream text polish (kills W3, W8)

Design: the unicode design note (external), §1.4 (IUTF8) + §3 (Layer 4
downstream). Phase A (term.c/host.js, v130) landed at 7d04f1d; this is the
parallel polish increment: four small items, one bake (v131). Branch
`unicode-phaseB`.

## 1. tty IUTF8 — char-wise ERASE/KILL (W3)

The canonical-mode line discipline popped one BYTE per ERASE, so a
multi-byte char on VT1 (or any canonical tty) needed N backspaces and
mis-erased the screen. kernel.js grows the Linux `IUTF8` c_iflag bit
(0x4000, default ON for every Tty — pty slaves included) and a
`Tty._popChar` helper: with IUTF8 set, trailing UTF-8 continuation bytes
(`(b & 0xC0) === 0x80`) fall with their lead byte, so one ERASE deletes a
whole character; ERASE and KILL both route through it (KILL's ECHOK echo
is now per-character too). The termios header gets `#define IUTF8 0x04000`
— the full-struct tcgetattr/tcsetattr transfer means C programs see and
can clear it; `cfmakeraw` deliberately leaves it (Linux behavior; raw mode
has no canonical erase anyway).

**Honest partial (documented, deliberate):** the erase echo is ONE
`[8,32,8]` cell per character regardless of display width. A double-width
(CJK) char occupies 2 cells, so its erase echo should be 2×`[8,32,8]` —
that needs `wcwidth`, which is Phase D territory (D-plan: no width tables
before the CJK font exists). Linux line disciplines historically shipped
exactly this 1-cell state pre-wcwidth. `_popChar` carries the note.

Tests: `test_tty.js` grew an IUTF8 block (defaults-on, 2-byte é erase in
one keystroke + one-cell echo, 4-byte astral erase, char-wise KILL echo,
and the IUTF8-cleared byte-wise regression leg). Red pre-fix: 4 legs.

## 2. WMP title[32] truncation snap (W8)

`wmpTitle32` (kernel.js — the ONE encode choke for the 80-byte record AND
the EV_TITLE frame tail) byte-capped at 31, which could split a UTF-8
sequence and render one tofu. Fix at the encode side, the user32.c:193
`w2a_trunc` "no split UTF-8" rule verbatim: walk the cut point back past
continuation bytes so the copy ends on a whole sequence. Record layout
UNCHANGED (32 stays 32 — ~10 CJK chars; widening is a protocol bump for
little gain, per the design ruling). wm.c needs no change — it renders
whatever whole-sequence bytes arrive.

Tests: `test_wm_policy.js` — a 30×'x'+'é' title (32 bytes) must arrive as
exactly the 30 ASCII bytes (no dangling C3 lead), plus a fits-whole
multi-byte round-trip leg. Red pre-fix: 1 leg.

## 3. crt16 wsprintfW narrow %s UTF-8 decode (W8)

`w16_vformat`'s narrow-%s branch zero-extended each byte into a WCHAR —
Latin-1 mojibake for UTF-8 args. Since kernel32 decrees `CP_ACP ==
CP_UTF8`, the UTF-8 decode is both the Windows-correct and the compatible
fix. crt16.c now includes `win32_internal.h` and runs narrow args through
`__u8_next` — the ONE veneer decoder (the same conversion
MultiByteToWideChar performs): per-code-point decode, surrogate pairs for
astral, malformed → U+FFFD. Width/precision count UTF-16 units; precision
never splits a surrogate pair (emits one fewer unit instead of a lone
lead).

Tests: k32demo grew two self-checks (é/€ decode, astral → surrogate
pair), asserted through `test_kernel32_e2e.js`'s n/n PASS. Red pre-fix:
2 checks.

## 4. C.UTF-8 / nl_langinfo(CODESET) shim (W8)

Apps probing the locale couldn't discover UTF-8. The libc's charset IS
unconditionally UTF-8 (the real mb/wc codec, MB_CUR_MAX 4), so the musl
model is the honest one: `setlocale` now tracks a current-name static —
accepts "C", "POSIX", "C.UTF-8", and maps "" (the native locale) to
"C.UTF-8" — and a new `<langinfo.h>` provides `nl_langinfo` with
`CODESET` pinned to "UTF-8" regardless of the set name, C-locale strings
for the standard POSIX items (days/months/formats/radix), "" out of
range. Item numbering is libc-private (no external ABI). busybox and
future ports key UTF-8 behavior off exactly this probe.

Codegen-neutral by construction: pure libc addition (new header + extended
`__locale.c`), no compiler semantics touched. The existing
`tests/unit/stdlib/locale` golden updated (`set_empty` now C.UTF-8 — the
intended discovery change); new `tests/unit/locale/01_c_utf8` covers the
probe end-to-end. Red pre-fix: both tests.

## SameBoy byte-identity gate — and a real finding (todos/0269)

The mandate: compiler.js touched → SameBoy output must be byte-identical.
It is — but proving it surfaced a P0: the FIRST baseline build (pristine
compiler.js) produced a 662546-byte wasm at `f3022c70…`; every one of six
subsequent builds — pristine in-place, pristine from /tmp, the full Phase
B edit, and three bisect variants (define-only, comment-only, minus
langinfo.h) — produced `04eccc9e…`, also 662546 bytes. Post-change ==
pristine byte-for-byte, so the shim is confirmed codegen-neutral. The
outlier differs by exactly ONE function-table slot (one low slot absent,
all higher baked fps −1): run-to-run slot-allocation drift with identical
inputs. Filed as **todos/0269 (P0)** with the section-level forensics; the
byte-identity verdict here rests on the six-run agreement including the
same-inputs rebuild.

## Deferred (noted, not dropped)

- ctype/wide-ctype Unicode tables: byte-level `isalpha` ASCII-only is
  CORRECT under UTF-8 (high bytes aren't alpha); codepoint `iswalpha`
  awaits a real table when an OS surface needs it. No queue item — the
  design note's Layer-4 list is the backlog of record.
- wcwidth / double-width erase echo: Phase D (see §1).
- kernel.js `charCodeAt & 0xff` fallbacks (strace quoting, ProcFS
  TextEncoder-less path): ASCII-only by design, now annotated in place.
- term.c/host.js untouched (Phase A, landed); wm chrome untouched
  (Phase C).
