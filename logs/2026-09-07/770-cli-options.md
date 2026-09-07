# #770 — truthful host options and compiler help

The serial audit reproduced host -O0/-O2/-O3/-Wall/--typo success with no
warning at 0e6fcbd9. These did not select any compiler policy. The in-OS
frontend already refused unknown flags (#710), but also refused --help.

RED 211ffe30 pins refusal before output creation/overwrite and the help
contract. The host now refuses all unimplemented dash options, including
unknown -W forms, through the existing error path. Implemented warning and
debug flags retain their behavior; the explicitly documented legacy browser
filesystem compatibility branches remain explicit. No optimization levels
were invented. Both frontends expose --help on stdout at success; missing
inputs still produce usage at failure. In-OS help covers every supported
option; host help lists common controls and the different project input path.
The toolchain document now includes #762's -g2/-fno-inline controls.

Executed validation: tests/host/test_cli_options.js initially had 17 failing
checks; after implementation all 20 checks pass. test_gcode_orientation.js
passes. 770-integration freshly executed test_abort_backtrace_e2e.js and
os-abort-backtrace.mjs: both PASS, including real in-OS help, debug controls,
trap/abort reports and shell survival on image286. Carried summary rows are
not fresh execution. Logs under build/status-fixes/770-*. Final composed full,
standard flake and manual both-host sessions remain due under the campaign.
