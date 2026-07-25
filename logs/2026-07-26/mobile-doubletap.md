# mobile: double-tap-to-zoom on the tab-bar cluster (+ boot-error message drop)

Branch `mobile-doubletap`, off `main @4834c21b` (image v165, NetSurf Lane A).
Reported from a real iPhone against live apex: *"I thought the double tap
keyboard zoom issue was fixed? But I'm seeing it again wtf"*.

Static assets only — **no `image.json` bump**, and none would be correct:
`os.html` and `kernel-worker.js` are both in `BAKE_INPUT_SKIP`
(`os/os-common.js:1144-1147`), i.e. explicitly excluded from the 0082
input-freshness scan as runtime-only files that cannot change blob bytes.
Verified rather than assumed.

## Item 1 — the bug: it was never fixed for these elements

The prior fixes (`7ae67648`, `1a5a5b33`) were scoped to the **OSK keys and the
keystrip keys**. The tab-bar cluster above them —
`Terminal | Desktop | ⌨ | A− | A+ | −/1×/+ | Desktop site | Upload` — never got
the guard, and `touch-action` does not inherit, so the `html, body` root
declaration does not cover them.

Confirmed mechanically before touching the CSS. New table-driven check in
`tests/browser/os-vt1mobile.mjs`, run against unmodified `os.html`:

```
ok   .stripkey   … manipulation        <- had a local guard
ok   #uploadbtn  … manipulation        <- had a local guard
FAIL #vt1tab #vt2tab #oskbtn #fontminus #fontplus
     #zoomminus #zoomplus #desksite #vtbar   "auto"      <- 9 controls, no guard
ok   #screen / #osk keep "none"
```

That is exactly the reported set. `A−`/`A+`/`⌨` are the worst of it because
they are **repeat-tap** controls: stepping font size means tapping several
times quickly, which *is* a double-tap.

### Why one container rule instead of three more per-button copies

The local-sprinkle option would have been the 4th and 5th copy of
`touch-action: manipulation` in this stylesheet, with the explanatory comment
already pasted twice. Chose the container-scoped rule:

```css
#vtbar, #vtbar *, #keystrip, #keystrip * { touch-action: manipulation; }
```

- **The per-button shape is what failed.** `#uploadbtn` was added *with* its own
  guard while its neighbours were never retrofitted — the guard depended on
  someone remembering a property. Membership is now structural: be in the bar,
  be covered. The next control added inherits the fix instead of re-learning
  this the hard way.
- **The descendant `*` (not `> *`) is load-bearing.** `#fontctl` and `#zoomctl`
  are wrapper spans, so their buttons are *grandchildren* of `#vtbar` — a child
  selector would have missed `A−`/`A+`/`−`/`+`, precisely the worst offenders.
- **It covers the bar itself**, which had no declaration of its own since
  `de850ec9` made it an `overflow-x: auto` scroll container.
- **Net lines go down**: two local copies + two pasted comments removed, one
  rule + one comment added.
- A shared opt-in class (`.tapctl`) was rejected: it has the same
  remember-to-add failure mode as the property, just one level up.

**Not folded in — deliberately:** `#screen` and `#osk` keep `touch-action:
none`; they own their touches (0212). `.oskkey` keeps its local guard, because
`#osk`'s container is `none` on purpose and an `#osk *` rule would flip the
inter-key gaps none→manipulation — a real behaviour change, not a cleanup.

**Pinch-zoom is untouched.** `manipulation` = `pan-x + pan-y + pinch-zoom`; only
the double-tap gesture is dropped. The viewport meta still omits
`user-scalable=no` (`os/os.html:28-36` documents that as an intentional
contract). Horizontal panning of `#vtbar` is likewise unaffected — proven by
the two pre-existing legs *"phone VT2 bar overflows sideways (scrollable)"* and
*"bar pans to the end; Upload (the tail control) reachable"*, both still green.

**The `overflow-x` theory was checked and is a red herring.** `#vtbar` computed
`auto` because nothing declared it, not because it scrolls; the OSK keys had the
identical problem inside a non-scrolling parent. Moot either way now — the fix
puts `manipulation` on the bar *and* every descendant.

## Item 2 — the boot-failure panel dropped `e.message`

`startBoot()` posted `String((e && e.stack) || e)`. On V8 `Error.stack` renders
as `"Error: <message>\n  at …"`, so the message rides along and the bug is
invisible on desktop. **WebKit's `stack` is the bare frame list** — so on iOS
the red panel printed frames only, and the message is exactly where the two
facts that matter live: the `throw new Error(p + ': HTTP ' + xhr.status)` at
`kernel-worker.js:379` names *which file* and *which status*. Both had to be
reconstructed from line numbers.

New `errText(e)` leads with `name: message` and appends the stack only when the
engine hasn't already folded it in, so both engines render it once and neither
duplicates. Verified in node across six shapes: V8 Error, WebKit-shaped stack
(message now surfaces), thrown string, `null`, no-stack, empty-message.

## Item 3 (decide-only) — bounded retry/backoff on non-200: **NO**

**Root cause of the incident, established from the deploy's runtime allowlist:**
the external embedder's build ships only the runtime JS (`os.html`, the workers,
`os-common.js`, `compositor.js`, `ksvc.js`, `osk.js`, `hello.c`), the root JS,
xterm, `doom1.wad`, decks, packages, and the image. **No C sources and no vendor
build trees are deployed.** Therefore `bakeSystemImage`'s synchronous-XHR source
reads (`kernel-worker.js:374-383`) 404 *by construction* on a deployed site.

The failing sequence is: `fetch('image.json')` → OPFS blob is version-stale →
`fetch(manifest.image)` misses during a propagation window → the `catch` at
`kernel-worker.js:417` **falls through to the bake** → the first source read
404s → hard boot failure reading `"<some C file>: HTTP 404"`. That is the
message shape jku saw, and why the dropped message hurt.

**Recommendation: do not add a bounded retry/backoff.**

1. The 404 that actually fired is **permanent, not transient** — the resource is
   not deployed at all. A backoff ladder cannot succeed on any attempt; it only
   converts a fast clear failure into a slow stall. This is exactly the trap the
   brief flagged.
2. The two genuinely transient fetches (`image.json`, the blob) already sit
   behind CDN + ETag revalidation, and the blob is content-hashed and immutable,
   so a fetch that *succeeds* is never a stale one.
3. Boot is where a user most needs a fast, legible answer; a retry ladder puts a
   stall in front of it.

**Two targeted non-retry fixes are worth filing** (deliberately NOT implemented
here — the mandate was decide-only, and both change boot behaviour and want
their own queue item + gate):

- **(a) Fall back to the fixed blob name.** The deploy publishes *both*
  `os-system.<sha>.img` (immutable) and `os-system.img` (fixed name,
  must-revalidate). On a `manifest.image` miss, one fetch of the fixed name is a
  *different resource*, not a retry of the same one, and the existing version
  gate at `kernel-worker.js:410` already rejects a stale blob. This turns the
  propagation window from a hard boot failure into a correct boot.
- **(b) Kill the zombie bake fallback on deploys.** `manifest.image` being set is
  the deploy marker (the repo manifest carries no `image` field —
  `kernel-worker.js:400-404`). When it is set and no blob could be fetched, fail
  loud naming the blob and status instead of falling into a bake that provably
  cannot succeed. This is the repo's own "no zombie fallbacks" rule, and it is
  what would have made this incident self-describing.

## Verified / not verified

Run solo, serially, off a fresh `--packages=all` v165 prebake:

| suite | result |
|---|---|
| `os-vt1mobile` | PASS (44 checks; RED→GREEN proven on the new legs) |
| `os-osk`, `os-touch`, `os-vt2zoom`, `os-mobile2x` | PASS |
| `os-boots` | PASS (covers the touched `kernel-worker.js` boot path) |

**NOT verified — needs a real device.** This is an iOS Safari *gesture*
behaviour; headless Chromium cannot reproduce it. What the new test guards is
the **CSS contract the gesture depends on** (computed `touch-action` per
control) — which is what regressed, and it now fails loudly if any bar control
loses the guard. The gesture itself is unverified until jku taps a phone.
Item 2's `errText` is likewise verified by construction + node, not by an
observed iOS boot failure.

### Manual check-list (iPhone Safari, after deploy + hard reload)

1. Rapid double-tap **A+** and **A−** (VT1) → font steps, page does **not** zoom.
2. Rapid double-tap **⌨** → keyboard toggles, page does **not** zoom.
3. Rapid double-tap **Terminal** / **Desktop** → VT switches, page does **not** zoom.
4. On VT2: rapid double-tap **−/+** and **Desktop site** → no page zoom.
5. Double-tap the **empty part of the tab bar** → no page zoom.
6. **Pinch-zoom anywhere still works** (must NOT have been disabled).
7. Drag the tab bar sideways on a narrow phone → **still pans** to reveal Upload.
