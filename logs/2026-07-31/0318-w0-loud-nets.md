# #318 W0 — win32 loud-net instrumentation (the "never again" ticket)

Branch `0318-w0-loud-nets`, image v207→v208. Eight work items, one commit
each — the point of the wave: #317 (LISTBOX ignored WS_VSCROLL for
months) happened because all three fail-loud tiers were structurally
blind to unread style bits, NULL-HWND sends, partially-handled messages
and never-sent notifications. W0 converts that class from archaeology to
stderr, BEFORE the later waves that assume the nets exist.

## What landed (per item)

- **(i) `style_net`** (user32.c, at create_window_impl): every
  style/exStyle bit outside the class's KNOWN set reports once per
  class+bit. KNOWN is three annotated categories: READ somewhere,
  BY-CONSTRUCTION (e.g. push-button text centers both ways, so
  BS_CENTER|BS_VCENTER hold; painter's-order drawing makes WS_CLIP*
  moot; ALL caption furniture is kernel-chrome policy), or TICKETED
  (each cites its ticket, register-enrolled). App-registered classes own
  their low style word (Windows semantics) — only the WS_ half is
  checked there; the built-ins + comctl32's classes carry audited masks.
- **(ii) `null_send`**: control-contract messages (EM_/BM_/LB_/CB_/SBM_)
  to a NULL HWND report once per message and return CB_ERR/LB_ERR for
  the CB_/LB_ ranges instead of fake-success 0. This is gap #1: calc's
  `CB_GETLBTEXT` to the skipped COMBOBOX "succeeded" without writing the
  buffer and convert.c compared uninitialized stack. SendDlgItemMessageW
  routes its missing-item case through the same net.
- **(iii) dlg_create** reports the discarded template STYLE dword (bits
  outside `DLG_STYLE_MOOT`) and any FONT record other than the
  "MS Shell Dlg 8" boilerplate. Reporting only — honoring is #322.
- **(iv) sbar_proc** got comctl32's first loud site: unhandled SB_*
  contract messages report (per-message dedup) instead of silently
  falling to DefWindowProc.
- **(v) win32rc** warns on discarded EXSTYLE at all three sites (the
  WRES format carries no exstyle — gap #2's rc half) and on non-VIRTKEY
  accelerator entries (ASCII flag or flag-less string), which
  TranslateAcceleratorW skips forever. Gotcha: `styleExpr()` returns
  `{or,not}`, not a scalar — the first cut compared an object to 0 and
  the warnings never fired; `applyStyle(0, …)` is the evaluation.
- **(vi)** SetTimer-TIMERPROC, CreateThread, LoadLibraryW,
  GetProcAddress and SetMapMode (was a bare fprintf) normalized onto
  WIN32_UNSUPPORTED (once-guard + WIN32_STRICT). GetProcAddress guards
  the MAKEINTRESOURCE-ordinal case before formatting %s.
- **(vii) ports.json** grew fileman/ctlpanel/software/fontramp/filepick
  — five SHIPPED apps the link-demand harness never measured. All five
  link clean; PORTS.md honestly reads "0 distinct symbols across 12
  targets" now.
- **(viii) WIN32.md** correction pass — see "doc drift" below — plus
  register entries L69–L71 for the three silent allowlist suppressions.

## Every report the new nets fired, and what happened to each

Stderr sweep = launch all ten win32 apps headless (`boot.js`, app `2>`
file, cat), plus the 8-file e2e core set and the deliberate ctldemo
negatives:

1. **gdidemo windowed launch: "DeleteObject on a selected pen/brush/
   font"** — a PRE-EXISTING 0211 report (not one of W0's) surfaced by
   the same sweep; gdidemo's scene code deletes a selected GDI object at
   every plain launch (refused ⇒ also leaks). **Filed P0 #342.**
2. **calc keypad: style bits 0x4F00 on BUTTON.** Triage split: 0xF00
   (BS_CENTER|BS_VCENTER) is exactly honored by construction → KNOWN;
   BS_NOTIFY 0x4000 is real — BN_SETFOCUS/KILLFOCUS/DBLCLK are never
   sent. **Filed #343**, allowlisted citing it (register L69).
3. **calc display: style bit 0x200 on STATIC** (SS_CENTERIMAGE) —
   exactly honored by the 0236 single-line vcenter → by-construction.
4. **notepad GoTo: ES_NUMBER** (latent — fires when the dialog opens):
   the digit filter does not exist. **Folded into #343** (L69).
5. **notepad EDIT: WS_EX_CLIENTEDGE** — the one recognized exStyle bit;
   end-to-end fix is #322. Allowlisted citing it (register L70).
6. **notepad status bar: SBARS_SIZEGRIP** — W5 residue #334 per the
   ticket's own carve-out (register L71); CCS_BOTTOM holds by
   construction (self-bottom-parking).
7. **calc boot: two LoadLibrary probes** (uxtheme, htmlhelp — one
   report line, once-per-site) — the deliberate (vi) consequence,
   documented in WIN32.md; calc sits outside the 0211 zero-report
   suite.

Everything else — fileman, ctlpanel, software, paint, fontramp,
filepick, winmine, notepad, and the whole dialog surface the e2es
drive — launches and runs **report-free**. The booted zero-report suite
holds.

## Doc drift found by (viii)

The gap inventory's #44 claimed the "crt16 wsprintfA %S/%ls read 4-byte
wchar_t" divergence was FIXED. It verified the WRONG formatter: the
surrogate-correct UTF-8→UTF-16 path is wsprintfW's %S (narrow-in-wide);
**wsprintfA delegates to libc vsnprintf**, whose %S/%ls still read
4-byte wchar_t. The entry was corrected, not deleted (latent — no
corpus caller). Also struck the long-fixed LISTBOX WS_VSCROLL entry
(#275/#317) and added the honest %c/%hd notes.

## Test-infra gotcha worth keeping

App stderr does NOT reliably interleave into driveBoot's captured tty
stream — the gdi32/kernel32 e2e pins failed until the scripts adopted
the user32-e2e pattern (`app 2>/tmp/x.err` + `cat`). Also: the per-file
kernel logs carry the TEST's output, not the boot's raw stderr — a
grep over `build/test-kernel/*.log` proves nothing about report
absence; the launch sweep above is the honest probe.

## Pins

ctldemo selftest grew 8 checks (75 total): TIMERPROC refusal, four
NULL-send contract returns, SB_GETRECT statusbar report, the BS_FLAT +
exStyle 0x100 style-net pair, and the IDD_ODD template (DS_CENTER|
WS_THICKFRAME + "Courier New" 12 → both dlg_create reports). gdidemo
selftest grew mapmode_refused. test_user32_e2e greps all seven report
lines; test_gdi32_e2e/test_kernel32_e2e grep theirs; test_win32rc.js
grew the six warn-leg checks (spawned without -q).
