# ksvc feasibility spike (FROZEN)

This spike is the committed feasibility record for todos/0275 (design doc
§2) and targets the SEED `ksvc.c` at the design commit (a281719) — the
`ksvc_spike_*` exports it drives were replaced by the real §4 ABI when the
implementation landed. `build.js` still builds the current blob (useful for
dumping the import/export surface); `run.cjs` is kept as the historical
minimal-env instantiation proof and is NOT expected to run against the
real blob. The live smoke test for the real ABI is
`tests/kernel/test_ksvc_e2e.js` + the `os/ksvc.js` wrapper.
