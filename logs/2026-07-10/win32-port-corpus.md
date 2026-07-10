# 0060 — the Win32 port corpus + compile-test harness

Landed `todos/0060`: vendored real raw-C Win32/GDI programs (ReactOS
winmine / notepad / calc @ `1a706d759e`), built `tools/win32ports.js` to
compile-test them against the os/win32 veneer, and committed the
missing-symbol report `os/win32/PORTS.md` — from here on, 0059+ implements
to that log's demand, not to speculation.

## What the harness is

A ~200-line Node tool over the compiler LIBRARY (parseAllUnits →
linkTranslationUnits → generateCode), not the CLI: it needs to keep going
past failures and classify them, where the boot-path `buildProject`
rightly throws. Per `os/win32/ports.json` target it reports one of three
states — `links` (codegen clean), `missing-symbols` (parse clean, link
fails ONLY on `Undefined symbol 'X'` — the useful state; X-list is the
demand data), `parse-errors` (header surface doesn't cover the code yet).
gdidemo/ctldemo ride along as control targets that must stay `links` with
zero missing — the harness's own negative case. `--check` re-derives the
report and byte-compares against the committed one
(`tests/kernel/test_win32_ports.js` runs it in the kernel suite).

Current state: winmine 38 missing, notepad 118, calc 74 — 175 distinct.
The aggregate table's top (symbols wanted by all three) reads exactly like
the 0059 plan: W message-pump entries, registry, LoadString/LoadImage,
menus, dialogs, GetSystemMetrics, ShellAbout.

## Decisions worth remembering

- **Implicit function declarations were a dead end** for symbol logging:
  the parser types them `int f(void)` — any real call site errors with
  "too many arguments", and handle-returning calls hit int→pointer
  conversion errors even in --allow-old-c mode. So the headers declare the
  full surface the corpus touches, properly typed, and undefined symbols
  surface at LINK. That inverts into a virtue: windows.h's declaration
  surface = documented corpus demand, and the demand log carries correct
  W-signatures.
- **The A/W split** (WIN32.md friction #2) landed as: implemented
  functions ARE the ANSI generic names; `gdi32.c`/`user32.c` `#undef
  UNICODE` at the top; W variants are declared; under UNICODE the generic
  names `#define` onto W at the END of windows.h (order matters — after
  all uses of the generic tokens), and the A-alias block is
  `#ifndef UNICODE`-guarded so `TextOutA` can't chain to `TextOutW`.
- **WCHAR is 2-byte UTF-16, libc wchar_t is 4-byte int — they must never
  meet.** `u"..."` literals are the WCHAR-width literals (the compiler's
  char16_t path; `u ## q` token-paste in TEXT()/_T() works, verified
  including u'c' char literals). Bare `L"..."` in ported code fails to
  typecheck BY DESIGN; the five corpus occurrences were patched to
  `u"..."` (patch tables in the vendor READMEs). The 16-bit wide CRT
  can't reuse msvcrt names (wcslen would collide with <wchar.h> at the
  wrong width), so the `_tcs*` tchar names ARE the veneer's real symbols
  under _UNICODE — tchar.h documents the deviation; "_tcslen" in the log
  reads as "16-bit wide CRT needed".
- **`#define VOID void`, not typedef** (the winnt.h way): ReactOS declares
  `VOID Fn(VOID)`, and a typedef'd VOID parses as a named parameter type,
  not the (void) special case — "expected 1 argument, got 0" at every
  call site until this switched to the macro.
- **calc builds with `-D__GNUC__=4`**: its `#ifdef __GNUC__` arms pick
  `ULL` literal suffixes; the MSVC arms use `UI64` which the lexer
  (correctly) rejects. Also `-D__REACTOS__` for all three, matching
  upstream CMake — winmine's sound toggle and several workarounds live
  behind it.
- **sol is C++** (CardLib) — excluded from the raw-C corpus. metapad and
  PuTTY are the next corpus rungs when the current log shrinks.
- **No image bump**: header growth is declaration-only and the veneer .c
  changes are two `#undef`s — gdidemo/ctldemo wasm verified byte-identical
  vs HEAD (sha256 over `buildProject` output in an isolated worktree), so
  v36 stands and no browser sweep was needed (nothing baked changed).

## Verification

- `node tools/win32ports.js` — all five targets match expectations; report
  regenerated deterministically (sorted, no timestamps).
- `--check` negative-tested (perturbed report → exit 1; regenerate → 0).
- `test_gdi32_e2e.js`, `test_user32_e2e.js`, `test_os_boot.js` PASS; full
  kernel suite run after the change set settled.
