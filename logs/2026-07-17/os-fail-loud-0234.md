# gucOS fail-loud batch (todos/0234 — code-debt scan CD2-log/CD3/CD6/CD7)

One theme, one bake: a failure the user (or a future debugger) can't see is a
bug even when the code "handles" it. Four spots in the os/ runtime C swallowed
errors; all now report, none change behavior on the success path.

## CD3 — registry hive writes silently lost (advapi32.c)

`hive_save` returned void and ignored fopen/fprintf/fclose/rename failure, and
`hive_flush` cleared `g_dirty` regardless — so on EROFS or a full disk winmine
best-times / notepad settings evaporated with zero trace, while the in-memory
values kept answering reads as if all was well. Now `hive_save` returns int
(ferror + fclose + rename all checked; the partial tmp is swept, the old hive
kept — errno preserved across the sweep), and `hive_flush` KEEPS the dirty bit
(the next RegCloseKey/atexit retries) and warns once on stderr. The
malloc/strdup calls in key_add/hive_load/RegSetValueExW are NULL-checked —
proper ERROR_NOT_ENOUGH_MEMORY instead of a null-deref.

## CD6 — wm.c had 26 bare exit(1)s

The desktop's central service dying silently is doubly hidden: the kernel's
chrome fallback keeps the system usable, so the only symptom is "the taskbar
vanished". Every fatal path now goes through one `die(what)` helper (stderr:
what + strerror). The mechanical replacement names the event/reply at each
site (`wm: EV_SNAP_DROP read: ...`), so a future protocol drift points at
itself. Two supporting choices:

- `wmp_read_all` (wm_proto.h) sets `errno = ECONNRESET` on EOF — read() at
  EOF leaves errno stale, and the dominant fatal case IS the endpoint going
  away, so without this the strerror text would be noise exactly when it
  matters. Client-side only; framing untouched (kernel.js unaffected).
- main's early `return 1` subscribe paths and the `return 2` window-create
  paths got messages too — the non-errno "unexpected subscribe reply" case
  prints the type/plen instead of pretending errno explains it.

## CD7 — config-store writes: four callers, three disciplines

sv_set/ow_set/snd_set_mute all return 0/-1, but only the ctlpanel Sounds
checkbox checked (revert, silently) and open.c checked (message, no errno).
The Screen Saver radios/timeout and fileman's "Always" openwith checkbox
ignored the return — on a read-only/full home they pretended success. Now one
discipline everywhere: check → revert the control to the STORED state → say
why. ctlpanel grew `store_fail` (MessageBox + strerror) and `saver_sync`
(extracted from WM_CREATE — the revert IS a re-read of the store, so the two
can't drift); fileman reuses its existing `op_error` and still performs the
one-shot open after a failed persist (that part works regardless).

## CD2 — spawn-failure logging ONLY

wm.c/fileman.c `spawn_path` counted successes with no else — a double-click
whose spawn fails did NOTHING. Both now log `spawn <path>: strerror(rc)`
(posix_spawn returns the error code, not -1/errno). **Deliberately deferred:**
the launch-path dedup (spawn_path/reap_kids/activate consolidation into a
shared header à la fileops.h) is a separate, bigger item — this batch only
adds the diagnostic.

## Gate

Image bake v105 (sealed, 18.6 MiB), kernel suite 75/0, browser sweep 27/27.
No compiler.js changes.
