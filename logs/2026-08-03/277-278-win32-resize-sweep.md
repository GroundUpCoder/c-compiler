# #277 + #278 — ctldemo/gdidemo join the win32 resize sweep

Batch lane (rule 3a: same suite target, distinct instruments —
test_user32_e2e.js vs test_gdi32_e2e.js). Template ticket #203/0459; recipe:
`WS_THICKFRAME` at create + WM_SIZE relayout against the live client rect;
`fileman.c` is the in-tree template. The kernel dispatches WMP_RESIZE vs
SET_DST on the create-time resizable bit (os/wm.c), so without the style both
apps got NEAREST bitmap stretch.

## The constraint that shaped both changes

Both apps' coordinates are LOAD-BEARING: test_gdi32_e2e.js probes exact scene
pixels, test_user32_e2e.js/os-user32.mjs pin control rects, and the gdi test
asserts two independent boots paint BIT-EXACT at 480x360. So the resize
support had to be a strict superset: **at the default 480x360 client size the
output must be byte-identical to before.** Both designs therefore treat
480x360 as a *design grid* and express the live layout as a function that
degenerates to the old literals at the design size.

## gdidemo (#278): scale the design grid, re-render

`draw_scene(hdc, cw, ch)` maps every authored coordinate through
`SX(v)=MulDiv(v,cw,480)` / `SY(v)=MulDiv(v,ch,360)` — MulDiv is the identity
at the design size, so the goldens stay bit-exact. Deliberate non-scaling:
stroke widths (3px/5px pens), the RoundRect corner radius, text sizes, and
the 1:1 BitBlt checker — they are resolution-independent marks, and the
BitBlt leg's whole point is a unit blit (the StretchBlt beside it is the
scaling demo, and its dest rect does scale). WM_SIZE just invalidates; the
next WM_PAINT re-derives from GetClientRect. Never a stretch: the proof in
the e2e is that `wmctl shot` parses at the NEW dims — a SET_DST-scaled
fixed-size surface keeps its 480x360 buffer, so that observable cannot lie.

## ctldemo (#277): the anchor/fill policy

Delta-based relayout (`dw = cw-480`, `dh = ch-360`, clamped at >= 0):

- **Fills (get the horizontal slack):** Name EDIT, LISTBOX, notes EDIT
  (width +dw each).
- **Right-edge riders (x +dw):** Add/Greet (right of the Name EDIT), the
  SCROLLBAR (glued to the LISTBOX's right edge), the DESC_* acceptance
  column, About/Quit.
- **Vertical slack goes to the notes EDIT alone** (height +dh). The LISTBOX
  keeps its height so the DESC_* column's rows (44/78/112/160) stay aligned
  with the list region — those four controls are the 0236/0278 descender-clip
  pixel subjects and their 28/40px heights are part of that contract.
- **Bottom-edge riders (y +dh):** the Verbose/Options/About/Quit row.
- **Fixed:** the "Name:" label, Verbose/Options x positions.
- **Below the design size the layout holds its minimum and clips at the
  window edge** (slack clamps at 0) — the Win32 convention; every policy
  clips somewhere below its design minimum.

At exactly 480x360 every rectangle equals its WM_CREATE literal, so all
pinned geometry (kernel + browser) is untouched.

## Instruments (pinned before the gate, batch rule 3a.2)

- **#278 / test_gdi32_e2e.js:** the "no R flag" pin flips to "R flag
  present"; new legs: resize to 640x480 (wait dim + cairo-idiom settle) →
  shot parses at 640x480 + 11 scaled-geometry probes; maximize → shot dims
  must equal the `wmctl list` row's work-area dims (screen-derived, computed
  not hardcoded) + 2 scaled probes; restore gated by a REAL
  `wmctl wait dim 640x480`. 39 checks → **54 checks**, PASS standalone.
- **#277 / test_user32_e2e.js:** the "fixed-size" pin flips; new legs:
  resize to 640x480 → 10 tree-rect relayout asserts (agent tree, no pixels);
  maximize → work-area dims read back from the tree and the relayout
  arithmetic checked against them; restore wait-gated.

Also: `os/image.json` 225 → 226 (the demos ship via packages/demos.json into
the fat bake; the in-browser OPFS gate is version-only).

## Verified-unaffected neighbors

test_listview_e2e.js / test_lb_vscroll_e2e.js / os-user32.mjs / os-gdi.mjs /
os-sounds.mjs / os-edittab.mjs all drive these apps at the default size —
geometry unchanged there by construction. menudemo/lvdemo (same file,
separate top-levels) are NOT in #277's scope — flagged to the coordinator
for separate tickets rather than silently swept in.
