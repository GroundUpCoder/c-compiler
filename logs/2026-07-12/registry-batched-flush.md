# Registry hive: batch the write-back (notepad's slow close)

Found chasing a report that **Notepad takes a long time to close** in the OS
(browser build), while other windows close instantly. Measured it in headless
Chromium (click the window's [x] → time until the body pixels clear to the
desktop):

- **notepad close: ~720–860 ms**
- winbox close: ~16–26 ms  (control: same click, same measurement)

So the ~0.8 s is **notepad-specific**, not the compositor/WM (both ~20 ms). It
is not a recent regression and not a local-vs-deployed difference — the running
OS code is byte-identical to what's deployed; the cost is inherent to notepad's
teardown.

## Cause — O(N) write amplification in the registry hive

`vendor/notepad/main.c` `WM_DESTROY` calls `NOTEPAD_SaveSettingsToRegistry()`,
which writes **27 values** (whole `LOGFONT`, wrap/statusbar flags, margins,
window placement, header/footer, search/replace) as a burst of `RegSetValueEx`
inside one `RegCreateKeyEx … RegCloseKey`.

`os/win32/advapi32.c` (the file-backed hive) called `hive_save()` on **every**
mutation, and `hive_save()` rewrites the **entire** hive to a temp file and
renames it. So one notepad close = **27 full-hive rewrites + 27 renames**, each
a round trip through the OPFS-backed FS (~30 ms apiece). It also serialises
*every* app's keys each time, so it gets worse as the hive grows (calc, winmine,
notepad …). winmine (~15 values) had the same problem; calc (few values) less so.

### The consistency model that makes the fix safe

`hive_load()` is guarded by `g_loaded` — it loads **once per process** and never
re-reads. So there is **no live cross-process consistency**: a running process
never sees another's writes. The file is a *handoff medium between process
lifetimes* — an app persists its settings so the **next** launch reads them. The
per-mutation write-through therefore bought exactly one property: surviving a
SIGKILL mid-burst (of value only to a *future* process). `RegSetValueEx`'s
contract — and Windows itself — only guarantees the value is set **in memory**;
the hive is flushed lazily (`.LOG` + lazy flusher in the real Config Manager),
`RegCloseKey` does not force a flush. Our per-set disk write was *more* eager
than Windows.

## Fix — mark dirty, flush once (advapi32.c)

- `g_dirty` flag; `hive_flush()` writes the hive **only if dirty**, then clears.
- The three mutation sites (`RegCreateKeyExW`, `RegSetValueExW`,
  `RegDeleteValueW`) now set `g_dirty = 1` instead of calling `hive_save()`.
- `RegCloseKey` calls `hive_flush()` → notepad's 27 writes collapse to **one**
  `tmp+rename`. `atexit(hive_flush)` (registered once in `hive_load`) is the
  backstop for any caller that mutates and exits without closing.

Atomicity is unchanged (still one `tmp+rename`, never a torn hive). The only
property traded away — surviving SIGKILL *between* two mid-burst mutations —
is nearly worthless under load-once (a crashed writer only ever benefits a
future process, and losing a half-written burst just keeps the previous
settings; never corruption). The invariant that matters is preserved: the
on-disk hive is current whenever the process is quiescent / exiting, which is
the only moment anyone reads it (the next startup's load).

## Verified (headless Chromium, real OS)

| | before | after |
|---|---|---|
| notepad close | 719 / 788 / 845 ms | **43 / 50 / 44 ms** |
| notepad relaunch (reads back settings) | — | 44 ms, boots |
| winmine close | ~same class | 54 / 57 ms |
| settings persisted to hive | ✓ | ✓ (`lfFaceName`, `Difficulty` present) |

~17× faster, down to winbox-class, with settings still round-tripping across
relaunch. No image version bump needed (behaviour identical; only the flush
cadence changed) — the seeded veneer binaries did change, so a rebake picks it
up via the normal input-mtime gate.

## Follow-up

Filed **todos/0162** — consider a proper storage backend (SQLite is already
vendored) if the registry ever needs to become a real *shared, consistent*
store across processes (which would also require fixing the load-once
`hive_load`). Not needed for performance — this fix handles that — so 0162 is a
"do we want a real registry?" design question, not a bug.
