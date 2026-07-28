# 0386 — design/diagnosis: what makes `test_netsurf_mutation_e2e.js` read 285 vs 234

- **Ticket**: `todos/0386-netsurf-mutation-e2e-intermittent.md` (stays **open** — this is a
  diagnosis pass, it closes nothing)
- **Method**: READ-ONLY source reading. **No test was run** (another lane held a gating build;
  and a repro under uncontrolled load adds nothing to three existing sightings — the open
  question was always *mechanism*).
- **Base**: `origin/main` @ `3df5d28f40c433e0479537ee3054e63f5f1080d8`, branch `0386-diagnosis`.

---

## 0. Summary in five lines

1. **285 and 234 are fully accounted for.** `285 = 52 chrome + 233 glyph ink`, and
   `234 = 52 chrome + 182 glyph ink` — **one glyph, worth 51 ink pixels, is missing.** The `52`
   is not a guess: it is `2 border columns × 26 scanned rows`, and it is the exact number lane B
   measured for a field that received *zero* keystrokes.
2. There is a **real, unguarded window** in which NetSurf **silently discards a keystroke**:
   between `html__reconvert()` surrendering the focus and `html_reconvert_box_done()` handing it
   back, `html->focus_type == HTML_FOCUS_SELF`, and `html_keypress()` drops printable characters
   on the floor. That window is **one gucOS event-loop iteration wide** — including a
   `SDL_WaitEventTimeout(NULL, 1)` park that a *typed key itself wakes early*.
3. The competing explanation — the single un-settled `wmctl shot` on the ticky leg sampled a
   frame **before the last keystroke was painted** — is also live, and the test as written
   **cannot tell the two apart**. That conflation is itself a defect in the test.
4. **This test is deterministic-able, not "honestly load-tolerant."** Both mechanisms have a
   barrier-shaped fix. Widening the pixel tolerance would be wrong — and note the existing
   `* 0.9` slack is *already* wide enough to swallow the loss of a small glyph silently.
5. A **second, distinct defect** was found in the same window and filed separately as
   **`todos/0400`** (P0): a click that lands mid-re-conversion leaves `focus_owner.textarea`
   pointing into the `talloc_free`d old box tree.

---

## 1. The arithmetic: where 285, 234 and 52 come from

The assertion is in `tests/kernel/test_netsurf_mutation_e2e.js:407-425`:

```js
const fieldInk = (s) => {
  let n = 0;
  for (let y = 2; y < 28; y++)                       // 26 rows
    for (let x = 0; x < Math.min(s.w, 260); x++) {
      const p = px(s, x, y);
      if (p[0] < 100 && p[1] < 100 && p[2] < 100) n++;   // "dark"
    }
  return n;
};
```

The page is `typingPage()` (`:128-140`): `<input id="i" type="text" size="20">` under
`#i { font-size: 20px }`, `body { margin: 0 }`.

NetSurf's default stylesheet (`vendor/netsurf/netsurf/resources/default.css:114-117`) gives that
input:

```css
input, button { background-color: #fff; color: #000; font-family: sans-serif;
    border: 1px solid #444; padding: 2px 3px; line-height: 1.33;
    margin: 1px; box-sizing: border-box; }
```

`#444` = `(68,68,68)` — **all three channels below 100, so the border is counted as ink.**

Lay the box out: `margin 1` → border-box starts at `y = 1`; the **top border occupies exactly
`y = 1`**, and `fieldInk` starts at `y = 2`, so the top border is excluded. Content is
`1 (margin) + 1 (border) + 2 (padding) + ~27 (line-height 1.33 × 20px)`, putting the **bottom
border near `y = 33`**, past the `y < 28` bound — also excluded. Width from `size="20"` at 20px
sans is ≈ 210 px plus padding/borders, so the **right border sits well inside `x < 260`**.

⇒ the only chrome inside the scanned band is the **two 1-px vertical border columns**, over
**26 rows** (`y = 2 … 27`):

```
2 columns × 26 rows = 52
```

and `logs/2026-07-26/netsurf-lane-b.md:59` records, first-hand, that a field which received **no
keystrokes at all** read **exactly 52**. The model is confirmed by an independent measurement,
not fitted to it.

Therefore:

| shot | ink | decomposition |
|---|---|---|
| `x1` static (passing, both sightings) | **285** | 52 chrome + **233** for six glyphs `abcdef` |
| `x2` ticky (passing) | 285 | identical — lane B measured "285 vs 285, byte-identical" |
| `x2` ticky (**failing**, both sightings) | **234** | 52 chrome + **182** for **five** glyphs |

**`285 − 234 = 51` is one glyph's ink.** Mean glyph ink is `233 / 6 = 38.8`, so 51 is
`1.31 ×` mean — i.e. an **ascender** glyph (`b`, `d`, `f`), not an x-height one (`a`, `c`, `e`).
I cannot name which of the three from source alone; that needs a render, and §4's ladder
measures it directly.

**Things 51 is *not*** (each checked, not assumed):

- **Not the caret.** `gucos_redraw_window` (`vendor/netsurf/gucos/gui.c:262-277`) strokes it with
  `pen.stroke_colour = 0xFF0000FF`. `colour_to_pixel` for XBGR8888 is the identity
  (`libnsfb/src/plot/32bpp-xbgr8888.c:80-83`), so R is the low byte ⇒ the caret is **red
  (255,0,0)** and `p[0] < 100` rejects it. (Same convention `isRed` in the toggle leg relies on.)
- **Not the `<div id="d">tick N</div>`.** It begins around `y ≈ 35`, below the `y < 28` bound —
  and if it *did* intrude, a changing digit count would scatter the number across many values,
  not two.
- **Not a layout shift.** Six glyphs moved sideways have identical ink.
- **Not chrome.** Chrome is 52 and is present in both shots.

---

## 2. The mechanism: an unguarded keystroke-loss window during live re-conversion

### 2.1 Focus is surrendered at teardown-*start*, restored at the swap

`vendor/netsurf/patches/netsurf.diff`, in `html__reconvert()` (the coalesced live-reconvert
pass), snapshots the focused gadget and then **drops the focus immediately**:

```c
    c->reconvert_focus_node  = dom_node_ref(fc->node);      /* snapshot */
    c->reconvert_focus_caret = textarea_get_caret_char(...);
    ...
    c->focus_type  = HTML_FOCUS_SELF;                       /* <-- surrendered HERE */
    c->focus_owner.self = true;
    ...
    c->reconverting = true;
    error = dom_to_box(html, c, html_reconvert_box_done, &c->box_conversion_context);
```

and only `html_reconvert_box_done()` — the **completion callback of `dom_to_box`** — hands it
back, after the reformat:

```c
    if (c->reconvert_focus_node != NULL) {
        struct box *fb = box_for_node(c->reconvert_focus_node);
        if (fb && fb->gadget && fb->gadget->data.text.ta) {
            html_set_focus(c, HTML_FOCUS_TEXTAREA, fo, true, 0,0,0, NULL);
            textarea_set_caret(fb->gadget->data.text.ta, c->reconvert_focus_caret);
        }
        ...
    }
    c->reconverting = false;
```

Between those two points, a printable keystroke is **silently discarded**.
`content/handlers/html/interaction.c:1917-1951`:

```c
    fire_dom_key_event(html, corestring_dom_keydown, key);   /* DOM still sees it! */
    switch (html->focus_type) {
    case HTML_FOCUS_CONTENT:  return content_keypress(...);
    case HTML_FOCUS_TEXTAREA: return box_textarea_keypress(...);
    default:  break;                       /* HTML_FOCUS_SELF falls through */
    }
    switch (key) { case NS_KEY_COPY_SELECTION: ... }          /* no 'a'..'f' case */
    return false;                                             /* dropped */
```

The frontend then treats the unclaimed key as a navigation key
(`vendor/netsurf/gucos/gui.c:801-842`) — `'a'` matches no `case`, so **nothing happens and the
character is gone for good.**

⚠️ Note `fire_dom_key_event(keydown)` runs *before* the focus switch, so a JS `keydown` listener
still sees every key. **A DOM-event-based probe would report six keys even when the field got
five** — that trap is why §4's probes read `input.value`, never an event count.

### 2.2 The window is exactly one event-loop iteration — and a keystroke opens it

`gucos_schedule_run()` (`vendor/netsurf/gucos/schedule.c:163-225`) samples `gettimeofday(&tv)`
**once** at line 180 and compares with `timercmp(&tv, &cur_nscb->tv, >)` — **strictly greater**.
A callback scheduled at delay 0 *during* the drain gets `tv = now ≥ tv_snapshot`, so it **cannot
run in the same drain**. `vendor/netsurf/gucos/main.c:266-271` states this explicitly ("its
comparison is strictly greater, so a callback due this very microsecond needs the clock to move
on"). So each 0-delay hop costs one full loop iteration:

| loop iteration | `gucos_schedule_run()` | `gucos_process_events()` |
|---|---|---|
| N | JS `setInterval` fires → `textContent =` → `html_schedule_reconvert` → schedule `html__reconvert` @0 | focus **intact** — key safe |
| **N+1** | **`html__reconvert()` — focus surrendered**, `dom_to_box` schedules `convert_xml_to_box` @0 | 🔴 **focus GONE — any key drained here is LOST** |
| N+2 | `convert_xml_to_box` (7-element page < the 10-node yield cap ⇒ one call) → `html_reconvert_box_done` → focus restored | safe again |

So a key is lost **iff it lands in the SDL queue between the end of `process_events(N)` and the
`process_events(N+1)` drain**. In wall-clock that interval is
`redraw_all(N)` + `SDL_WaitEventTimeout(NULL, 1)` + `html__reconvert()`.

🔴 **The park makes this worse, not better.** `gucos_schedule_next()` returns 0 (the reconvert is
already due), so `main.c:271` parks for **1 ms** — and that park is a *real* wait on the kernel
input ring (todos/0178), so **a keystroke arriving during it returns the park early**, and the
very next thing that happens is `schedule_run` running `html__reconvert` **before**
`process_events` drains that key. A key that arrives inside the park is therefore lost
*deterministically*, not probabilistically.

**Load sensitivity, which is the whole observed signature:** on a quiet box the window is
≈ 1–2 ms out of a 300 ms tick — ~0.5 % per key, ~3 % per six-key run. Under `jobs 2` with other
4 GB kernel-suite nodes live, the process is descheduled inside that window; a 1 ms nominal park
becomes tens of milliseconds, so the window grows to ~10 % of the tick and
`P(≥1 of 6 keys lost) ≈ 45 %`. That is exactly "green solo, intermittently red in a loaded gate".

### 2.3 Why the same integer twice

`TYPE_KEYS` (`:268`) is `wmctl key …; sleep 0.25` — an effective cadence of
`250 ms + one wmctl process spawn`. The tick is a fixed 300 ms. On a quiet box the spawn costs
~30 ms, so the key cadence is ~280 ms and the key↔tick phase drifts ~20 ms per key: only **one**
of the six keys sits near the danger window, and *which* one is set by the fixed pipeline
(`wmctl wait win` → `sidOf`'s `wmctl list | grep | sed` → `wmctl click`) between page-script time
and key 1.

**Under load the spawn cost grows toward 50 ms, driving the key cadence toward 300 ms — i.e.
toward resonance with the tick.** At resonance the key↔tick phase stops drifting, so the *same*
key sits at the *same* phase every run: the hazard stops being "a random key sometimes" and
becomes "**this** key, either just inside or just outside the window". That is precisely the
"bimodal deterministic state" the ticket's ⭐ note infers from the repeated integers, and it is
the best account I can give for two independent lanes producing byte-identical 285/234.

I flag this as **the weakest link in the chain**: it explains the repeat well, but it is a
timing argument, not a code-read one. §4's ladder settles it by naming the missing glyph.

### 2.4 The competing mechanism, stated fairly

**M2 — the shot sampled before the last repaint.** The ticky leg has **no barrier at either
end**:

```js
'netsurf /root/ticky.html &',
'wmctl wait win NsTicky 30000',    // title set during PARSE — layout not proven
sidOf('TK', 'NsTicky'),
'wmctl click $TK 60 12',           // <-- no settle before the click
...TYPE_KEYS('$TK'),
'wmctl shot $TK /root/x2.ppm',     // <-- no settle after the last key
```

The static control (`:314-322`) brackets the same sequence with `pollStable` on both sides. It
cannot: a page whose timer repaints every 300 ms **never satisfies a whole-frame stability
predicate**, so the author had no barrier available. Under M2 the keystroke *did* reach the
model and the pixel simply was not there yet — every glyph after the shot point is missing, so
the missing glyph is necessarily the **last** one, `'f'`.

**Why I cannot kill M2 from source:** my per-glyph ink estimate is not precise enough to
separate `ink('f') ≈ 51` from `ink('b'/'d') ≈ 51`. Both are in range.

**Which I'd bet on: M1.** Three reasons: (a) M1 is an unguarded correctness hole the code shows
plainly, and it is load-sensitive in exactly the shape observed; (b) M1 loses *state*, which is
the ticket's own reading of a repeated integer ("the ticking path is probably losing one specific
mutation, not rendering late"); (c) under M2 the 250 ms post-key sleep would have to be
*routinely* insufficient, yet the same 250 ms is enough for the five earlier keys in the same
run.

**The single observation that separates them** — §4, trigger D1 — is one extra `wmctl shot`.

---

## 3. 🔴 THE CONTROLLED TRIGGER

Everything below runs **on a quiet box** (no other lane; the heavy lock is the guard) and from
**inside a worktree** (`0341` refuses main-tree absolute paths with exit 4). All of it is edits
to `tests/kernel/test_netsurf_mutation_e2e.js` + a run of that one file through the runner:

```
node tests/kernel/run.js --filter=test_netsurf_mutation_e2e
```

Never `node tests/kernel/test_netsurf_mutation_e2e.js` bare — see §6.

### D1 — the discriminator (run this first; ~1 test run, one added line)

Add a second, settled shot to the ticky leg and print both:

```js
  'wmctl shot $TK /root/x2.ppm && echo shot-x2-ok',
  'sleep 2',                          /* several more ticks; the FIELD band is
                                         static once typing stops (only the
                                         `tick N` div below it repaints) */
  'wmctl shot $TK /root/x3.ppm && echo shot-x3-ok',
```

and report `fieldInk(x2)` and `fieldInk(x3)` unconditionally.

| observation | verdict |
|---|---|
| `x2 = 234`, **`x3 = 285`** | **M2** — paint lag. A *test* defect: the assertion needs a barrier. |
| `x2 = 234`, **`x3 = 234`** | **M1** — the keystroke never reached the model. A *product* defect. |
| `x2 = 285` (no repro) | inconclusive this run — go to D2 to force it. |

This cannot be satisfied vacuously: if the run is green, `x2 == x3 == 285` and it says nothing;
the verdict is only claimed on a failing run.

### D2 — the forcing trigger for M1 (the high-value one)

**Make the re-conversion window wide on purpose.** `convert_xml_to_box` yields to the scheduler
every `max_processed_before_yield = 10` elements
(`content/handlers/html/box_construct.c:1239,1314`), and each yield costs one loop iteration
including a ~1 ms park — which is why `logs/2026-07-26/netsurf-lane-b.md:40-42` measured
**152 ms at 1508 elements, "dominated by `convert_xml_to_box` yielding to the scheduler every 10
nodes, not by layout compute"**. The focus is surrendered for that **entire** duration.

Add a third page, `ticky-big.html` — the *same* `typingPage(true)` markup with `PAD` filler
divs appended **after** `<div id="d">` (they must not perturb the input's geometry, or the ink
budget in §1 moves):

```js
const typingPageBig = (n, periodMs) => /* typingPage(true) with:
     - `setInterval(..., periodMs)`
     - n filler `<div class=p></div>` rows appended after #d
     - .p { height: 1px; }  so the page is tall but the FIELD BAND is untouched */
```

Run three arms and print all three ink numbers:

| arm | page | expectation if **M1 is real** | expectation if **M1 is wrong** |
|---|---|---|---|
| **T** (trigger) | `n = 3000`, `period = 300` | ink **collapses toward 52** (most/all keys lost) | **285** |
| **C1** (size control) | `n = 3000`, **no `setInterval`** | **285** | 285 |
| **C2** (period control) | `n = 3000`, `period = 5000` (longer than the whole typing sequence) | **285** | 285 |

- **PASS shape** (M1 killed): `T = C1 = C2 = 285`.
- **FAIL shape** (M1 confirmed): `T ≪ 285`, trending to `52`, while `C1 = C2 = 285`.
- **Distinguishable**: the two controls are what make it a trigger rather than a slow page. C1
  proves size alone is innocent; C2 proves the tick alone is innocent; only `size × ticking` —
  i.e. a wide re-conversion window — moves the number.

`n = 3000` ⇒ ~300 elements-worth of yields ≈ 300 ms of window per 300 ms tick, so the page is
**continuously mid-re-conversion** and every key is lost. `n = 1500` (≈152 ms window, ~50 % duty)
is the gentler dial if a graded response is wanted: it should lose ~1–3 of the 6 keys, i.e. land
between 234 and ~130.

⚠️ **`n = 3000` also demonstrates a product concern worth naming even if 0386 turns out to be
M2**: a page that mutates faster than it can re-box (`reconvert_pending` re-arming forever)
becomes permanently un-typeable. That is not a test artefact.

### D3 — name the missing glyph (settles §2.3 and the ink table)

On the ticky leg, shot after **each** key (`x2_1 … x2_6`) and print `fieldInk` for each. The
step that fails to grow names the lost key, and the six deltas give the **per-glyph ink table**
that retro-explains 51 and every future count. If the missing key is **`b` or `d`, M2 is dead
outright** (M2 can only ever lose the trailing key).

### D4 — the direct M2 trigger (cheap, one word)

Keep the *small* ticky page; change `TYPE_KEYS`' `sleep 0.25` to `sleep 0.02` for the ticky leg
only. If the ink drops, the leg is genuinely sampling before the paint lands and the missing
barrier is real regardless of M1. If it does *not* drop at 20 ms, M2 needs a 250 ms paint lag to
be true, which is a strong argument against it.

### What the trigger costs

One kernel-suite file, ~11 s per run in-gate (three arms ⇒ ~30–40 s), on a quiet box, no bake
(it uses `freshImage` + the cached fixture). This is small enough to run under `--repeat 5` for a
rate rather than a yes/no.

---

## 4. Fix shape

### 4.1 Is this test deterministic-able, or honestly load-tolerant?

**Deterministic-able.** Both live mechanisms have a *barrier*-shaped fix, not a *tolerance*-shaped
one, and lane B already measured the deterministic answer: **285 vs 285, byte-identical**
(`logs/2026-07-26/netsurf-lane-b.md:78`). A test whose correct answer is exact equality does not
need a tolerance.

🔴 **The existing `* 0.9` slack is itself a finding.** `tickyInk >= staticInk * 0.9` = 256.5.
Losing one **ascender** glyph (51 px, 18 %) trips it; losing one **x-height** glyph
(~33 px, 12 %) **does not**. So the assertion as written **already accepts a dropped keystroke
silently, roughly half the time.** Whatever else changes, that tolerance should tighten to
equality once the barrier is right — the direction is *narrower*, not wider. This is exactly the
"widening a threshold destroys the signal" trap the ticket's step 3 warns about, arriving from
the other side.

### 4.2 If D1/D2 say **M1** — the product fix (recommended shape)

**Move the focus surrender from the start of `html__reconvert()` to the swap in
`html_reconvert_box_done()`.**

The bridge's own stated invariant is *build-then-swap*: "the old box tree stays alive — still
serving redraw and input — until the new tree atomically replaces `htmlc->layout`"
(`logs/2026-07-26/netsurf-lane-b.md:17-19`, and the header comment on `html__reconvert`). Focus
is **the one piece of interaction state that violates that invariant**: it is surrendered at
teardown-start even though the box it points at is alive until the swap. Selection, drag and
gadget `->box` back-pointers are reset early for a defensible reason (construction re-binds
them, and a gadget that never gets a new box must not keep a stale one). Focus is different
because it is not just a pointer — **it is the input routing table**, and dropping it has an
observable behaviour: keystrokes vanish.

Concretely:

- keep `focus_type` / `focus_owner` **valid across the whole `dom_to_box` run** (the old box is
  alive; `box_textarea_keypress` on it edits the *gadget's* textarea, and `TEXT_MODIFIED` →
  `form_gadget_update_value` puts the character into `gadget->value`, which survives the re-box
  by design);
- take the `reconvert_focus_node` / `reconvert_focus_caret` snapshot **at the swap**, not at the
  start, so a focus change *during* the window is carried across rather than thrown away;
- `html__redraw_a_box`'s NULL guard already covers the mid-window `ctl->box == NULL` redraws.

**Generality (the point, not an extra).** The rule this states is:
> **Interaction state that routes input must stay valid for the whole build-then-swap interval
> and be re-bound at the swap — not surrendered at teardown-start.**

That single rule covers focus, covers the click case in `todos/0400`, and is the correct level
for the next thing that hangs off the box tree (an IME composition, a drag in progress, a
scroll-anchored element). A per-symptom patch ("queue keypresses while `reconverting`") would fix
typing and leave the class open; it is the fallback only if keeping the old focus box live turns
out to be unsafe for a reason this reading missed.

**The one thing a later lane must verify before committing to it**: that `box_textarea_keypress`
on an old-tree box is genuinely safe for the whole window — in particular that the gadget's
`data.text.ta` being *replaced* mid-construction (`box_textarea_create_textarea` releases and
recreates it, per lane B's leak fix) does not leave the old box pointing at a destroyed textarea.
If it does, the fallback (defer-and-replay at the swap) is the answer.

### 4.3 If D1 says **M2** — the test fix, at the right generality

The gap is real and general: **`pollStable` compares whole PPMs, so no page with a live timer can
ever be settled on.** Every future netsurf/paint e2e with an animating element hits this.

The general seam: **give `wmctl shot` an optional crop rectangle** —
`wmctl shot SID FILE [X Y W H]` — so `cmp -s` on two cropped PPMs becomes a *region*-scoped
stability predicate, and `pollStable` generalises to `pollStableRegion` with no new comparison
machinery at all.

Verified before proposing: `wmctl shot` today takes only `SID [FILE]`
(`os/wmctl.c:588-591` → `do_shot` → `shot_to_ppm`), and `shot_to_ppm` already has the full RGBA
buffer in userspace before writing the PPM — **so the crop is a change to `os/wmctl.c` alone; no
kernel or WMP change is required.** (A kernel-side crop would save bandwidth and mirror the
existing `WMP_THUMB` downsample path, but it is not needed for correctness and should not be
bundled.)

With that in place the ticky leg becomes symmetric with its static control: settle on the *field
band* before the click, and settle on the *field band* after the last key. The A/B then asserts
exact equality, and the leg is deterministic by construction.

### 4.4 Both fixes are wanted regardless of the verdict

- Under M1, the test still lacks a barrier and will stay fragile under load once the product is
  fixed — the region-settle is owed anyway.
- Under M2, the focus window is still an unguarded input-loss hole for real users typing on a
  live page — the product fix is owed anyway, just not as *this* ticket's root cause.

D1/D2 decide which is 0386's root cause and therefore which lands under 0386; the other should be
filed rather than folded.

---

## 5. Image bump

`grep version os/image.json` → **186** today. The rule (todos/CLAUDE.md): docs/tests/todos/logs
owe no bump; baked binaries do.

| change | owes a bump? |
|---|---|
| this document, the ticket edit, `todos/0400` | **no** — `todos/` only |
| **D1–D4 triggers** and any fix confined to `tests/kernel/test_netsurf_mutation_e2e.js` | **no** — `tests/` only |
| **§4.2 product fix** in `vendor/netsurf/patches/netsurf.diff` (or `vendor/netsurf/gucos/`) | 🔴 **YES** — `/usr/bin/netsurf` is a baked `system` entry (`os/image.json:124-126`, `project: vendor/netsurf/gucos/bin.json`), so the blob changes and a persistent browser OPFS image only re-fetches on a version bump |
| **§4.3 `wmctl shot` crop** in `os/wmctl.c` | 🔴 **YES** — `wmctl` is baked |

⇒ **a test-only outcome owes no bump; either fix shape owes one.** Per the estate convention the
number itself is the integrating owner's to assign (lane B declined to pick one for exactly this
reason, `logs/2026-07-26/netsurf-lane-b.md:192-195`).

---

## 6. The bare-invocation cap (ticket item 4) — one correction

The ticket says a bare invocation "carries **NO cap at any layer**". For **this file** that is
overstated in a way that matters to the design: `driveBoot` passes its own `spawnSync` timeout
(`tests/kernel/lib/drive.js:71`), and this test asks for **420 000 ms** on session A
(`:331`) and the 300 000 ms default on session B. So a bare run is bounded at roughly
**12 minutes of boot time** — the observed 3 m 21 s sat comfortably inside it, which is consistent
with the follow-up finding that it **exited on its own** rather than hanging.

What is genuinely missing is the **per-file** cap: the runner's table
(`tests/kernel/run.js:134` — this file takes the bare `IMG` entry, i.e. the 600 000 ms default at
`:176`) is bypassed entirely, so anything *outside* a `driveBoot` call — the image bake, the PPM
parse, the two-session sequence as a whole — is uncapped. That is the real gap, it is the same
shape as `0369`'s finding that `tests/run.js` / `tests/host/run.js` / `tests/todos/run.js` are
bare `spawnSync` with no cap at any layer, and the ticket is right to cross-reference rather than
fold. **Recommendation: design item 4 inside `0369`'s survey, not here**, and have 0386 record
only the correction above.

---

## 7. Second defect found, filed not folded

**`todos/0400` (P0, filed by this pass)** — a click that lands inside the re-conversion window
can leave `focus_owner.textarea` pointing into freed memory.

`html_reconvert_box_done` frees the old tree **unconditionally and first**:

```c
    if (c->reconvert_old_bctx != NULL) { talloc_free(c->reconvert_old_bctx); ... }
    ...
    if (c->reconvert_focus_node != NULL) { /* re-bind */ }     /* CONDITIONAL */
```

If nothing was focused when the pass started, `reconvert_focus_node == NULL` and the re-bind
block is skipped entirely. But a click *during* the window routes through the still-live old
tree and can set `focus_type = HTML_FOCUS_TEXTAREA` with an **old-tree box** — which the
`talloc_free` above then releases. The next keypress dereferences it.

Honest scoping, in the ticket: the window is narrower than it first looks, because once
construction reaches that input the gadget's textarea is rebound to the **new** box and a click
after that point focuses a surviving box. It is source-derived and **needs a repro before a fix**.
It shares 0386's root cause (interaction state vs. the reconvert window) and §4.2's general rule
would fix it too — which is an argument for that shape, not for folding the ticket.

---

## 8. What I could not settle, and what would settle it

- **M1 vs M2**: not separable from source. **D1** (one extra settled shot) separates them in one
  run.
- **Which glyph carries the 51 px**: needs a render. **D3** measures it, and the answer
  additionally kills M2 if it is `b` or `d`.
- **Why the integers repeat exactly**: §2.3's near-resonance argument is a timing model, not a
  code read. **D3** confirms or refutes it by naming the same glyph twice.
