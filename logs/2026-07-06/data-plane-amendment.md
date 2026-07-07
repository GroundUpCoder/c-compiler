# Amending the data-plane decision: the kernel owns the fds (todos/0009)

Triggered by planning todos/0003 "fully correctly": the difficulty analysis
showed 0003's hardest 40% (fd_action translation across private fd tables,
the permanent shared-offset deviation, select wakeup plumbing) was all
*induced* by the settled "fs data plane stays in-process" rule. Digging at
the owner's prompt ("should browser file IO go through the kernel?")
exposed that the rule predates true multi-process and doesn't survive it:

- OPFS `createSyncAccessHandle()` is exclusive per file — N workers can't
  each open the store; `readwrite-unsafe` mode is Chromium-only territory.
- The read-through coherence invariant was validated for two instances in
  ONE thread (an external embedder). Truly parallel workers interleave multi-step
  metadata RMW — correctness would need a global cross-worker fs lock.
- SIGKILL (worker.terminate) tears metadata ops, or worse, kills a lock
  holder. Phase 1 quietly punted the whole question by giving each process
  a PRIVATE in-memory fs.

So "keep it in-process" was not the cheap option — its real price (fs lock
+ crash recovery + portability gamble) was simply unpriced, and it kept the
POSIX warts forever. Emscripten's WasmFS reached the same conclusion for
the same substrate (OPFS backend = proxy-to-one-worker).

**Amendment** (KERNEL.md "The fd/data-plane amendment"): for the OS, the
kernel owns per-process fd tables → system-wide open file descriptions →
the ONE BlockFS instance in the kernel worker; fs syscalls are RPCs on the
existing kernel-page transport (raw-byte payloads for read/write via a new
KP_RPC_KIND word). Standalone pages keep the in-process path — two
transports, one BlockFS implementation. One move dissolves: fd_action
translation, shared offsets on inherited fds, cross-process
unlink-while-open, the SIGKILL fd/inode leak, the OPFS handle problem, and
select/poll unification. The measured price is syscall latency — 0009
carries a benchmark gate (stdio buffering amortizes; Atomics.waitAsync is
the recorded pure-SAB upgrade path if postMessage round-trips ever hurt).

Also a process lesson worth keeping: the "don't re-litigate settled
decisions without new evidence" rule worked as intended — the evidence
here was real (multi-process reality vs single-process validation), and
the re-litigation happened in design docs before any code was written
against the wrong plan. Queue resequenced: 0009 before 0003; 0003 shrinks.
