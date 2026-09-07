# #769 — loop conditions are exempt from errexit

Found while validating #752's 40-module build. A simple `sh -ec 'i=0; while
[ $i -lt 1 ]; do i=1; done; echo AFTER'` exits 1 without AFTER in gucOS; native
/bin/sh prints AFTER. An if-condition discriminator already worked.

POSIX Shell Command Language's set-e exception includes the condition lists
following while/until as well as if/elif:
https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html

At 0bcce1ee, run_list's errexit_depth guard in
vendor/busybox/src/shell/hush.c:9915 exempted IF/ELIF but omitted WHILE/UNTIL.
The generic errexit check happens before normal false-loop-condition handling,
so it exited instead of ending the loop. Add the two reserved words to that
existing guard, behind ENABLE_HUSH_LOOPS; no new shell state. Version 282 ships
the seeded BusyBox fix, and the vendor patch ledger records it.

Local git blame dates the defective guard to initial vendor commit f2cc759ab.
A pristine upstream comparison was attempted but NOT completed: official
busybox.net download timed out and the attempted GitHub mirror tag URL returned 404.
The finding/fix is verified against the actual vendored source and POSIX, not
attributed to a particular upstream fix or release.

RED e56a3dd6, fresh kernel execution 769-red: while, until and both multiple
condition-command cases fail; failing loop bodies and later failures already
match native sh. The shared fixture is executed by native /bin/sh for the
oracle, then by real gucOS shells in both hosts. It protects against suppressing
all errexit failures as well as against the original premature exits.

Fresh 769-green: both kernel files and both browser files pass, including the
40-module build and forced startup-failure regression on v282. Fresh 769-flake:
the new kernel and browser shell tests each pass 3/3 under load10. Carried rows
are historical and excluded from these execution counts. The standard flake
run, aggregate fresh full gate and final manual compiler/OS use remain campaign
obligations.
No merge/deploy occurred.
