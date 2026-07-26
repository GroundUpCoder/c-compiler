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
