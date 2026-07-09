# The GUI toolkit — Elm/MVU declarative architecture

Decision (2026-07-09, log: `logs/2026-07-09/webgpu-mvu-direction.md`):
the long-run C GUI toolkit for this OS is **Elm/MVU-shaped** —
declarative UI as a pure function of state, reconciled into a retained
tree — built over the 0047 substrate. The earlier "trade up to nuklear
if microui runs out" fallback (0047) is **superseded** by this
direction: the trade-up target is this layer, not another
immediate-mode library.

Queue items: `0047` (microui substrate, unchanged in scope) → `0056`
(the MVU layer). `0048` apps start on microui; notepad's multi-line
editor is the first real retained widget and lands on 0056.

## Why MVU and not React-hooks (the C argument)

Both are "declare the UI from state, diff, patch". React distributes
state per-component and wires events through **closures** — the one
construct C is genuinely bad at. Elm/MVU centralizes:

```
Model   one struct — the entire app state
Msg     tagged union (enum + payload union) — events as DATA
update  (Model*, Msg) -> void      a switch over Msg
view    (Ctx*, const Model*)       pure; emits the UI tree
```

| React needs            | C has                          |
|------------------------|--------------------------------|
| closures capturing state | nothing good                 |
| per-component state slots | awkward (ID-stack hacks)    |
| Msg = tagged union     | `enum` + `union` — native      |
| update = pattern match | a `switch`                     |
| Model = one value      | a struct                       |

An event handler is not code, it's a value: "this button emits
`MSG_SAVE_CLICKED`". The runtime hit-tests, queues the msg, calls
update, calls view, reconciles. No function pointers in the tree, no
userdata threading. (Redux users already know this architecture —
Redux IS the Elm architecture ported to React.)

Two repo-specific wins:

- **Agent drivability**: a Msg stream is inspectable and injectable —
  `wmctl` can eventually post `MSG_*` values straight to an app
  instead of synthesizing pixel clicks (serves OS.md's "good agent
  target: discrete widgets, deterministic layout").
- **Deterministic replay**: log the msg sequence, re-derive every UI
  state bit-exactly — the same golden/fuzzer culture as BlockFS.

## Architecture (the pieces, all few-kloc, all ours)

1. **Declaration**: view() emits the tree via begin/end/attr calls into
   a **flat buffer** — `todos/DOM.md`'s encoding, retargeted at our own
   retained tree instead of the browser DOM. No closures needed; keys
   for identity where siblings reorder.
2. **Reconciler**: keyed diff of old vs new flat buffers → mutations on
   a retained node tree (~500–1000 lines; the well-understood part).
   Pure C, unit-testable headless with no GUI at all.
3. **Layout**: own flexbox subset (~1k lines): row/column, grow/shrink,
   padding, gap, min/max. (Clay is the design reference — declarative
   flexbox in tiny C — but we own the code; Yoga is C++, out.)
4. **Render**: retained tree → the 0047 command list (rect/text/icon/
   clip) → the 0047 renderer: SDL surface + freetype + the Win95 skin.
   The toolkit output is an shm surface like any CPU app; it composites
   through the 0055 WebGPU pass like everything else.
5. **Events**: kernel input ring → hit-test the retained tree → the
   widget's msg value → update → view → reconcile. Repaint only on
   msg/timer — idle apps block on the ring, zero CPU.
6. **Retained widget state** (scroll offset, caret/selection, focus):
   lives in tree nodes keyed by stable identity. App-meaningful state
   belongs in the Model; widget-internal state in the tree — the
   boundary rule. Reusable stateful components use the nested-TEA
   convention (sub-Model field + wrapped Msg range).

## What 0047 contributes (the substrate — permanent, not throwaway)

The command-list renderer, the shared freetype text-draw helper, input
plumbing, and the Win95 skin all carry over verbatim. microui itself
stays for quick immediate-mode tools until the MVU layer reaches
widget parity; the command list is the common currency between them.

## Relationship to DOM.md

Same declaration encoding, different backend. DOM.md's browser-DOM
diffing renderer becomes a possible *alternate backend* for this same
vtree format later — not a competing architecture.

## Open questions (decide during 0056, record here)

- Msg queue depth / coalescing (pointer-move storms).
- Timer/subscription story (tie into 0044 interval timers or an SDL
  timer — decide when the first app needs one).
- Text edit widget scope for notepad v1 (caret+selection+scroll yes;
  undo, IME explicitly later).
- Header/library packaging: single `ui.h` + one C file, image-seeded
  like other libs.
