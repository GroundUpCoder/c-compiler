# #771 / #746 — retire stale capability claims

The audit found OS.md's July status table describing fullscreen-only SDL,
Canvas2D composition and an unwired GUI editor. Current source has windowed
SDL, a WebGPU compositor and a seeded sedit editor. The replacement table
points at source/registries instead of copying test counts, compiler line
counts or unsupported percentages. It describes local source, not a deployed
image or a fresh full-gate verdict. Language boundaries and deferred AF_INET
remain explicit. Historical roadmap sections are labeled as history where
implementation already exists.

The conformance remainder still called exp2, fma/fmaf and multichar packing
unimplemented. Source and existing tests contradict those claims. Retired
them with implementation/test references and clarified that historical
unstruck findings still need re-derivation. This is not a claim that every
remaining historical finding was re-tested or that libm is complete.

#746 already owns the baked packages.md claim that three unsupported options
are ignored. Actual createCcDriver calls for --allow-old-c, --gc-spill-locals
and --allow-zero-length-arrays all return exit1 naming the option (evidence:
build/status-fixes/746-refusals.json). The recipe now says to omit them and
report a build that requires them; its existing -I/-D translation stays.
This directly serves the game's learn-modify-rebuild workflow and is within
the user's audit-doc correction scope. Image287 picks up the baked text.

Executed: fma unit1/1, multichar unit1/1, and the audit's runtime exp2 probe
prints2.000. Evidence in build/status-fixes/771-*. The standard flake, fresh
full run and final manual sessions remain campaign requirements.
