# #322 W2-TE — template STYLE/FONT honored + WS_EX_CLIENTEDGE end-to-end (+#345)

Four commits on `0322-dialog-template-exstyle`, plus the #345 rider.

## WRES v2→v3 — why a hard bump, not a dual reader

The format grows `u32 exstyle` after the dialog-level `u32 style` AND after
every control's. Strategy decision: **hard bump + regenerate all 4 committed
sidecars in the same commit**, no v2 compatibility path. A dual reader is a
zombie fallback with no customer — every pack in the tree is ours and
regenerates in seconds, and the regeneration commands were first proven
byte-identical against the committed v2 packs (so the commands themselves are
verified, not assumed).

The durable half: the reader's version gate used to be a **bare return** — a
stale sidecar read as "app has no resources", every string/menu/dialog just
gone, nothing in any log. It now reports through `__win32_unsupported` naming
the pack path, the found version, and the fix. The next person to bump this
format gets a loud failure instead of a blank app.

## WS_EX_CLIENTEDGE — a real non-client inset, one seam

Rejected the cheap version (draw a ring inside the control's rect and call it
done): it lies to `GetClientRect`, and per-control special cases don't
generalize. Instead `nc_edge()` threads ONE 2px inset through every geometry
consumer: GetDC wraps the inset span (so a control's DC **physically cannot
reach** its ring — incremental draws can't clobber it), the ring draws at
BeginPaint over the e=0 window span (the WM_NCPAINT analog; parent erases are
always followed by a child full-repaint via `invalidate_tree`),
GetClientRect/WM_SIZE report inset sizes, `hwnd_origin` adds each ancestor's
edge, hit-test/route_mouse/wheel deliver inset client coords, and
AdjustWindowRectEx finally reads its exStyle. Control procs moved from
`h->w/h->h` to `cli_w/cli_h` (46 sites, mechanical; `h->w` stays the window
rect). `style_net`'s hardcoded `~0x200u` becomes the truthful kind of quiet:
the bit is READ now. Liability L70 retired.

Gotcha for future NC work: clicks ON the ring deliver to the window at
slightly negative client coords — there are no NC messages here, recorded at
the hit-test.

## Template FONT — the "MS Shell Dlg" policy

`FONT 8, "MS Shell Dlg"` is NOT a file request; it is the logical
dialog-font alias, and gucOS's dialog font is the stock font (sans 20px,
font-20 retune). So the corpus boilerplate takes a zero-churn fast path
(no HFONT, byte-identical dialogs), while any real face/size resolves
through the #281 mapper at `pt * WIN32_STOCK_FONT_PX / 8` px — 8pt == the
system size, uniformly in every family. Base units come from the RESOLVED
font's metrics, so layout and rendering agree by construction; scaling by
true 8pt-at-96dpi metrics would have been the actual "off by the font
ratio" bug. `WIN32_STOCK_FONT_PX` moved to win32_internal.h as the single
source. The dialog owns the HFONT; it dies at the dialog's WM_DESTROY with
all borrowed child references cleared FIRST (children are destroyed
parent-first — dc_with_font would otherwise select a freed object).

## Template STYLE — honor, policy, or report; never silent

`DLG_STYLE_MOOT` is now a documented three-way taxonomy: HONORED
(WS_CHILD+DS_CONTROL embedding into the owner at template x,y;
WS_THICKFRAME; WS_DISABLED; the font bits), CHROME/WM POLICY (caption
furniture is the kernel's; placement — DS_CENTER/DS_CENTERMOUSE/
DS_ABSALIGN and top-level x,y — is the WM's; a process cannot place its
own top-level, so honoring is impossible from this side of the surface and
the comment says so instead of pretending), MOOT (WS_POPUP, WS_CLIP*,
DS_MODALFRAME/DS_3DLOOK). Everything else still reports. DS bits are
consumed in dlg_create and STRIPPED before CreateWindowEx so the #32770
CLS_LOW_KNOWN row stays truthfully 0x0000. A WS_CHILD dialog skips the
modal owner-disable (it lives in the owner's tree — disabling the owner
would deadlock its own message flow).

## Tests

test_win32rc's three discard-warn pins inverted into v3 arrival
assertions; gap #25's accelerator checks untouched. ctldemo: IDD_ODD
flipped negative→positive (THICKFRAME in style, dialog font exists,
controls borrow it, client box == template DLUs by an independently
created equal font), new IDD_EMBED pins embedding, CLIENTEDGE legs pin
the geometry contract AND the ring's actual pixels (sampled from the
PARENT's DC — the child's own DC can't see its ring by construction).
test_user32_e2e's two #318 template-report pins inverted into absence
checks.

## Ship evidence (headless pixel probe, not committed)

notepad's editor: ring outer px = BTNSHADOW, inner = 3DDKSHADOW(black),
interior white — at the editor's window corner. calc: the readout STATIC
(rect 13,3 437x49) has the identical ring at its corner, 479 sunken-pair
pixels across the readout band. Both shipped apps visibly changed.

## #345 (separate commit)

btn_proc's WM_LBUTTONDBLCLK arm widened: BS_RADIOBUTTON/BS_OWNERDRAW
auto-notify BN_DBLCLK without BS_NOTIFY (real Windows). CLS_LOW_KNOWN
masks untouched — only the comment clause records it. ctldemo grew one
leg per kind; the plain-pushbutton press check still passes.
