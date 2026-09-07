# Serial audit fixes: taskbar recovery and callback lifecycle

Authorized campaign continues from 01a07994-43a5-7166-b39b-3c3508baa59f in
real successor 01a07a05-7ece-771e-af0b-9a79d927ab7c. Implementation remains
serial, in one checkout. No internal or external worker was delegated work.
Every item serves the C/SDL game developer's build/run/diagnose loop. The
remaining campaign checklist is preserved in build/status-fixes/STATE.md.

## #740 — reuse the existing ownership fix

Read the lane/740 diff against the current tree. At 9c9087e4,
user32.c:2889 still classified every #32770 as transient regardless of owner;
MessageBox, dlg_create and comdlg32 still discarded owner arguments. Reused
3f92262c, 74859cf8 and 07682f81, preserving their authorship and historical
log. Those historical test claims are not fresh validation.

Fresh red on the reused test-only commit: Calculator FLAGS=-------U and
cycle did not recover it. The initial test also falsely treated unchanged
focus on Statistics as a cycle visit when no second app existed; the reused
implementation commit already corrects this by opening Notepad first.
Fresh green: four kernel files executed and passed (taskbar_owner, calc,
notepad, user32). Added direct dirty-close transient/taskbar eligibility
assertions to Notepad. The runner's 171 carried rows are not our execution.
Image 281 is baked. Evidence: build/status-fixes/740-{red,green}.log and
corresponding dispatcher summaries. Full gate and final manual use pending.

## #764 — reject the frame run through its caller

Current host.js:13837 used a resolve-only promise while its async doFrame
re-threw faults into an unobserved callback invocation. The new host test
reproduced a Node unhandled RuntimeError and process exit 1, despite an
ordinary catch around runModule. Red committed before implementation.

The frame promise now has a reject path. Callback lookup, execution and
arming the next frame share that catch, so scheduler failures cannot escape
as unhandled async rejections either. Non-ExitStatus faults retain their
backtrace and original error. A finally around the awaited loop drains GPU
work before either successful completion or rejection to the process worker.
A drain failure cannot mask the initiating trap. Rejection skips the clean C
exit/atexit tail; the existing worker rejection handler tells the kernel to
reap the crashed process. MainLive was already reset before entering this loop.

The host test injects an asynchronous gpuDrain as an order probe; this is not
a real GPU device test. It covers trap, rejecting drain, explicit exit(23),
and SDL_Quit. Existing backtrace leg H now asserts settled rejection and no
longer installs a global handler expecting the known-broken unhandled fault.
Both host files pass. Kernel/browser external tests and real GPU checks are
next; no full-gate claim is made. An in-frame explicit exit still has the
pre-existing Dawn caveat: the C EXIT handshake precedes post-callback drain;
this change does not redesign that separate path.
