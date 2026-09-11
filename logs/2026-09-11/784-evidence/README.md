# #784 primary-author execution evidence

Original mapped gate: `node tests/run.js --diff HEAD` in the isolated
c-compiler-small-callbacks checkout, base 0845ad42. Exit 1; see diff-summary.json.
The host product hash in gated-source-pins.json still matches the final product.
The final callback test strengthens only the drain assertion; callback-final.log
is its fresh JSPI/sync result. The broad gate was not repeated for that test edit.

These preload/probe scripts are exact historical execution artifacts, with
absolute checkout and /tmp paths. They are not portable test entry points.
To reproduce at another location, adjust those paths explicitly. Their baseline
input was produced with `git show 0845ad42:host.js > /tmp/784-before-host.js`.
The baseline is retained in git, not duplicated here. The logged SHA256 is
1b3e631cc442eafb1e813db1e2b7241580829ba1d055b6c18a516fab8a9465db.

Commands actually run, sequentially after the gate released its lock:

```sh
node -r /tmp/784-baseline-preload.cjs tests/kernel/test_cmdalt_e2e.js
NODE_OPTIONS='-r /tmp/784-browser-baseline-preload.cjs' node tests/browser/os-sedit.mjs
node tests/browser/os-sedit.mjs
node -r /tmp/784-baseline-preload.cjs -r /tmp/784-stat-diag-preload.cjs tests/kernel/test_cmdalt_e2e.js
python3 /tmp/784-repeat-sedit.py
node tests/host/test_callback_capture.js
```

The Node baseline loader logs worker thread IDs and source hashes. The browser
loader redirects only the server's host.js file response and logs each source
hash; it does not change test assertions or product files. The stat diagnostic
adds a compiled C observation after the original shadow file is created;
cmdalt-baseline.log is the separate unmodified-test control.

#785 tracks the confirmed cross-volume file-identity defect. #786 tracks the
intermittent editor failure (mechanism unresolved). Preserve the initial red
logs independently of successful replays. No fix to either is included here.
