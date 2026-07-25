# Upload file button (VT1/touch mobile) — page-side host-file ingest

Branch `upload-btn` (on b6c0ddc6). iPhone users have no drag-drop, so the
existing host-file drop path (todos/0067) gets a second, touch-friendly
entry point: an **Upload** button in `#vtbar` + a hidden `<input
type="file" multiple>`. Page-side `os.html` ONLY — no image bump, no
kernel change, no new FS path.

## Mechanism

- ONE ingest loop, `postHostFiles(files)`: the drag-drop handler's body
  factored out verbatim — per File, `arrayBuffer()` → post
  `{type:'drop-file', name, bytes}` with the buffer TRANSFERRED. Both the
  `#desktop` drop listener and the picker's `change` call it, so kernel
  policy (sanitize, "-N" collision, 128MB cap, fsync, `/root/Desktop`)
  stays the single owner and the wm's ~1s re-read grows the icon as
  before.
- iOS gesture rule: the button's `click` handler calls
  `uploadInput.click()` — a tap IS the user gesture, so Safari opens the
  chooser. `change` clears `.value` afterward so picking the same file
  twice re-fires (the captured File refs stay readable).
- Gate: `#uploadbtn` is `display:none`, shown under `body[data-touchui]`
  (both VTs — an upload isn't VT-specific). Desktop keeps drag-drop and
  never sees the button. `touch-action: manipulation` per-element (the
  v163 double-tap-zoom rule; touch-action does not inherit).

## The #vtbar overflow trap (the part worth remembering)

A phone-width bar now holds more controls than fit, so `#vtbar` grew
`overflow-x:auto; flex-wrap:nowrap; #vtbar > * { flex-shrink:0 }`. But
the tab bar's active-tab seam trick — children at `position:relative;
top:1px` descending onto the bar's `border-bottom` so the active tab
visually merges with the content below — DIES inside a scroll container:
a border sits outside the padding box, and overflow clips children at
the padding box edge, so the 1px descent gets cut and the border line
runs through the active tab. Fix that keeps the seam byte-visual-
identical: replace the border with `box-shadow: inset 0 -1px 0` (same
color) + `padding-bottom: 1px`, so the line AND the tabs' 1px descent
both live inside the padding box. Same outer height (6+H+0+1border ==
6+H+1pad). `scrollHeight == clientHeight` in the phone leg of
os-vt1mobile.mjs pins exactly this (a clipped seam shows up as vertical
overflow).

`#oskbtn { margin-left:auto }` needed no tweak: flex auto margins absorb
free space only — on overflow they resolve to 0 and the cluster just
trails off the right edge and pans in. Asserted both ways (right-aligned
while the bar fits; Upload reachable at scroll end on a 360px phone).

## Verification

- os-vt1mobile.mjs grew 7 legs: touch visibility, synthesized
  picker-change → `[drop]` kernel log, input re-armed, icon appears on
  the desktop grid (deskEntries/deskCell model), md5 byte-identity
  through the shell, fits-case right alignment, and a 360px ctx3 for the
  overflow/pan/seam contract. os-drop.mjs grew the hidden-on-desktop
  gate leg. The picker DIALOG itself is un-drivable headless — real
  iPhone Safari check pending (flagged in the handoff).
- Gate: unit 774 ok · projects 29 ok · kernel 114 ok ·
  sweep 38/39 (os-vt1mobile 33 legs, os-drop 14, os-osk green).
- **os-hires.mjs is red on ORIGIN/MAIN** (verified by stashing this
  diff): its `settleZoom(2)` at :104 still pins the auto-2× phone
  default that v163 (1a5a5b33) flipped to 1× — the same stale-contract
  class the minesweeper lane re-pinned in os-mobile2x, missed for
  os-hires. Not fixed here (out of scope, parallel-lane territory);
  needs its own P0 re-pin.
