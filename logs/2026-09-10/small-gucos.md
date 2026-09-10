# Small uses the gucOS C process host

User-requested integration: make Small a sibling compiler available inside gucOS,
automatically imported from a valid ../small checkout during image assembly.
This enables Small application development inside gucOS. There is no deployment
or language/widget-library redesign in this change.

The shared boundary is the existing C process host, not a parallel OS runtime.
Small exports its existing linear memory and wrappers over its allocator for
startup and temporary host buffers; it retains Wasm GC object/string values.
Small string helpers come from its compiler's self-contained host factory,
snapshotted into the image. String output encodes UTF-8 and calls the existing
C write import so descriptor ownership, pipes, errors and redirection are shared.
Arguments, environment and errno use the C startup hooks. Small's entry validator
rejects incompatible main signatures before writing an output binary.

The image imports compiler, runtime and library bytes together and records a
SHA-256 content identity. The Node build paths compare this identity rather than
relying on sibling mtimes, which cannot detect deletions or removal. Browser
OPFS reuse also checks the expected snapshot from adjacent image metadata;
image content is checked before installation. Missing/inconsistent metadata
forces regeneration on Node serving/fixture paths. The current image manifest requires metadata; absence refuses browser boot.
Legacy manifests without that requirement retain version-based browser refresh. Publish image and metadata together.

Validation stopped on insufficient disk space (about 2.3 GiB free; harness
minimum 3 GiB). Small's 284 tests and 3 editor tests passed; installed-host,
real kernel compile/run/pipe, and initial real Chromium compile/run/pipe probes
passed. The later browser publication cases have source-review approval but
remain unexecuted. Independent external Astra review thread:
01a08ae9-2cb9-72d1-a1e1-99696cc0b5e3 (Codex executor/model verified).

The mandatory diff gate ran todos (3/3), unit (849 pass, 3 skip), host (ONE
failing file, test_heavylock_gate), BlockFS (15 pass), and part of the Python
consumer batch before it was stopped. Full kernel/sweep and flake validation
remain. No fresh run-level completion artifact exists. Do not treat this as a
green gate or a deployment record. The failed preflight was reproduced directly;
automatic fixture cleanup could not restore the required disk headroom.

Follow-up: the user freed disk space; 27 GiB is now available. The integration
is being checkpointed separately from unrelated sedit files at the user’s
request. Regression validation will be rerun against the checkpoint parent;
this commit does not claim a completed gate or deployment.
