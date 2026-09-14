# #784 Objective-C callback identity after table mutation

Independent review of the UI prerequisite b1853235 found that its Objective-C
wrapper lookup followed the original slot number even after the slot changed.
The reviewer reproduced [1,1] where CALLBACKS.md requires [1,2] on explicit
re-registration, in both JSPI and synchronous modes. Review thread:
01a09ec3-af01-78c5-8179-7a47bcf66949, metadata verified codex/gpt-6-astra.

The regression was reproduced locally and committed before the fix (27c19208).
The host now records original function-to-exception-wrapper associations just
after instantiation, before onReady, constructors or main can change the table.
Registration reads the current table entry and captures its corresponding guard.
Pending callbacks retain their captured callable; explicit re-registration
observes mutation without discarding Objective-C uncaught-exception handling.
No compiler or wire ABI change is needed.

Executed in isolated c-compiler-ui-callback-fix:
- tests/host/test_callback_capture.js: JSPI and sync pass, including C mutation,
  Small direct references, Objective-C mutation before registration, frame and
  timer re-registration, and moved-function uncaught exception (exit 134).
- tests/host/test_async_lifecycle.js: JSPI and sync pass.
- tests/host/test_frame_lifecycle.js: pass.
- tests/host/test_objc_exceptions.js: 230 JSPI checks pass.
- git diff --check: pass.

The new diagnostic assertion initially stringified byte output as comma-separated
numbers; decoding the bytes fixed the test reader. The application had already
reported the expected uncaught exception and exit code.

Independent re-review and mapped integration gates remain required. These are
focused Node runtime checks, not graphical, full-release or deployment evidence.
Lifecycle #789 and the rest of the UI/Swing rollout remain separate active work.
