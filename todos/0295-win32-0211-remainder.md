# 0295 — win32 0211 remainder: WM_MOUSELEAVE, LISTBOX WS_VSCROLL, WM_SYSKEYDOWN activation, comdlg32 lpstrFilter

- **Status**: open
- **Design**: `todos/WIN32.md:471-490` (the 0211 audit's remainder list).

## Goal

File and fix the four verified-but-unticketed win32 divergences from the 0211 audit. Ticket-DB
grep over all 91 bodies found **no ticket** for any of them:

| Divergence | ticket hits |
|---|---|
| `WM_MOUSELEAVE` never fires on surface exit (needs a kernel leave event) | **0** |
| `LISTBOX` `WS_VSCROLL` draws no scrollbar (calc's stats box declares it) | 0 for LISTBOX (#32 / `0136` is the **EDIT** control) |
| No `WM_SYSKEYDOWN`/`WM_SYSCOMMAND`/`WM_ACTIVATE` family; no Alt/F10 menu activation | **0** |
| `comdlg32` `lpstrFilter`/`nFilterIndex` ignored; `CommDlgExtendedError()` always 0 | **0** |

## Why these stayed invisible

**The list is partially funded, and that is what made the unfunded entries blend in.** `EDIT`
word-wrap from the same audit list **is** scheduled (#33 / `todos/0137`), so `WIN32.md:471-490`
reads as a tracked backlog. Anyone skimming sees a list with tickets against some entries and
assumes the rest are covered too.

Likewise the LISTBOX scrollbar looks covered by `0136` until you notice `0136` is the **EDIT**
control — a near-miss that reads as a hit.

## Status of the underlying facts

**Inventory-only.** The sweep reconciled these against the ticket DB but did **not** re-verify
each in code today. **First step of this item: re-verify all four against current code**, since
the audit predates several win32 waves and any of them may have been incidentally fixed. Do not
start implementing from the table above.

## Plan

- Re-verify each of the four against `847dc057`+; drop any that no longer reproduce (and say so).
- Split into sub-items if the four turn out to be independently sized — `WM_MOUSELEAVE` needs a
  **kernel leave event**, which is a larger seam than the other three and may deserve its own
  item.
- Fix what remains; update `WIN32.md:471-490` to cite ticket ids so the list stops being a
  mixture of funded and unfunded entries.

## Acceptance

- Each of the four is either fixed, or re-verified as already fixed, or split into its own filed
  item — none silently dropped.
- `WIN32.md:471-490` entries each cite a ticket id (this is also `0286`'s register rule applied
  to the doc that motivated it).
- These are the exact gaps a new win32 port trips over: where fixed, a test covers the behaviour.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.

## VERIFICATION (cont-78, 1e8a940)

**Verdict: CONFIRMED — all four still reproduce in current code. None was
incidentally fixed. The near-miss claim about `0136` also holds.**

Static re-verification against the working tree at `1e8a940`; no suite was run.

### (a) `WM_MOUSELEAVE` never fires on surface exit — CONFIRMED

`os/win32/user32.c:1738-1743` is the ONLY `WM_MOUSELEAVE` post, and it is gated on
an intra-surface `WM_MOUSEMOVE` that lands on a *different* window:

```c
if (downMsg == WM_MOUSEMOVE && g_tme.hwnd && g_tme.hwnd != target) {
    HWND was = g_tme.hwnd;                   /* left the tracked window: */
    UINT f = g_tme.flags;                    /* fire LEAVE + auto-cancel */
    g_tme.hwnd = NULL;
    if (f & TME_LEAVE) PostMessage(was, WM_MOUSELEAVE, 0, 0);
}
```

The gap is still self-documented in the message pump at `user32.c:1805-1811`:

```c
/* NB (0211 audit, still open): the pointer leaving the SURFACE
 * delivers no SDL event in this world (the kernel routes input
 * per-window and simply goes quiet), so a TME_LEAVE armed window
 * only gets WM_MOUSELEAVE via intra-surface movement — calc's
 * hot button stays lit until re-entry. Needs a kernel leave
 * event; recorded in WIN32.md. */
```

Still needs a kernel leave event; still the largest of the four (a kernel-side
seam, not a veneer-side one) and the one that most deserves its own item.

### (b) `LISTBOX` `WS_VSCROLL` draws no scrollbar — CONFIRMED

`grep -n WS_VSCROLL os/win32/*.c` yields exactly three hits and **none is in the
LISTBOX proc**:

- `ctldemo.c:283` — an EDIT creation flag.
- `user32.c:3383` — `return edit_ml(h) && (h->style & WS_VSCROLL) != 0;` (EDIT).
- `user32.c:3527` — `/* The built-in WS_VSCROLL bar (0210): … */` (EDIT).

`lb_proc`'s `WM_PAINT` (the LISTBOX section starts at `user32.c:4504`) draws
`draw_well()` + the row list + `TextOut` per row and nothing else — no scrollbar
geometry, no reserved gutter, and `st->top` is only moved by wheel/keys.

### (c) No `WM_SYSKEYDOWN`/`WM_SYSCOMMAND`/`WM_ACTIVATE` family, no Alt/F10 menu activation — CONFIRMED

- `WM_SYSKEYDOWN`, `WM_SYSKEYUP`, `WM_SYSCHAR`, `WM_ACTIVATE`, `WM_NCACTIVATE`:
  **not even `#define`d** — zero hits across `os/win32/*.c` and `os/win32/include/`.
- `WM_SYSCOMMAND` (`include/windows.h:684`), `WM_MENUSELECT` (`:688`),
  `WM_INITMENU` (`:686`), `WM_INITMENUPOPUP` (`:687`) are **defined but never
  referenced by any `.c`** — declaration without implementation.
- Alt is consumed in exactly two places, neither of which is menu activation:
  `user32.c:1080` (accelerator-table `FALT` matching) and `user32.c:5809`
  (`IsDialogMessageW`'s Alt+mnemonic). `VK_F10` (`include/windows.h:765`) is
  **never read by any `.c`**.

### (d) `comdlg32` `lpstrFilter`/`nFilterIndex` ignored; `CommDlgExtendedError()` always 0 — CONFIRMED

- `grep -c 'lpstrFilter\|nFilterIndex' os/win32/comdlg32.c` → **0**. Both fields
  exist only as struct members in `os/win32/include/commdlg.h:23` and `:26`, so an
  app can set them and be silently ignored.
- `os/win32/comdlg32.c:717` — `DWORD CommDlgExtendedError(void) { return 0; }`
  (error is indistinguishable from cancel, exactly as WIN32.md:489-490 records).
- `nFileOffset` IS written (`comdlg32.c:217-219`) but in **UTF-8 bytes**, with the
  `/* ASCII paths: == bytes */` caveat right there — consistent with WIN32.md:488.

### Near-miss claim: `0136` is the EDIT control — CONFIRMED

`todos/0136-edit-scrollbars.md:1` — "# 0136 — EDIT control interactive scrollbars
(WM_VSCROLL / WM_HSCROLL)". It funds the **EDIT** scrollbar, not LISTBOX's, so the
LISTBOX entry at `WIN32.md:469-470` really is unfunded.

**Correction to `todos/0133-edit-control-completeness.md:85`**, which says
"0134, 0135, 0136, 0137 are in `todos/done/`": all four are **still open** in
`todos/` (`0134-edit-mouse-wheel.md`, `0135-edit-undo-buffer.md`,
`0136-edit-scrollbars.md`, `0137-edit-word-wrap.md`); `todos/done/` contains none
of them. The ticket's premise that 0137 (EDIT word wrap) is *scheduled* is
therefore correct — it is open, not done — but 0133's own status line is stale and
should be fixed by whoever picks this up.

### Scope note for the implementer

The four are NOT equally sized. (b) and (d) are veneer-local. (c) is a message-family
addition plus a menu-activation state machine. (a) needs a **new kernel event**
(pointer-left-surface) routed through the WMP seam — a different lane from the other
three, and the natural split point if this item is broken up.
