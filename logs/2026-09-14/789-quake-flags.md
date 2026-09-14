# #789 Quake FLAGS assertion correction

Test-only follow-up based on e7d18dc2. The immutable corrected mapped gate
reported Quake geometry/scale failures despite the expected geometry because
both regexes still required eight FLAGS characters. wmctl now emits nine;
the last slot is requested-hidden H. Add a literal trailing dash in both
full-field patterns, preserving geometry, DST, focus, relative-mode and all
other existing checks. No shared parser, runtime change or timeout change.

Audit: inspected tracked tests/os/tools JS, MJS, C, H and shell consumers for
wmctl/rec_flags/FLAGS, tab-delimited literal flag patterns and fixed-length
flag access. The two Quake patterns were the remaining stale full-field
matches found. WM-service already asserts f---R----. Other consumers use
column splitting, individual flag positions/membership or variable-width
fields; no further stale fixed width was found by this audit.

Validation executed: node --check tests/browser/os-quake.mjs; git diff --check;
17 nonboot checks extracting both actual regexes from source. Positive rows
pass; eight-character, H-set ninth, ten-character, unfocused and resizable
rows fail. Scaled geometry, position and DST negative rows fail; unscaled
position captures remain72/76. These are synthetic regex checks, not browser
or installed acceptance. No shared parsing introduced.

Independent exact-tip review requested separately. Browser reproduction and
flake remain pending dispatcher49031 completion and explicit slot release.
The unchanged900s boot-timeout diagnosis remains separately blocking. No
old/current candidate edits, bake, boot, browser, heavy tests or deployment.
