Independent #785 V3 Node runtime evidence review — scoped acceptance

Read FULL AUTHOR-AUDIT.md and author-audit.json, verified author-evidence-pins.json, raw case/fixture/compiler/module/outcome records, grant/config/claim/launch, supervisor, source checks and terminal inspector. Performed read-only file/hash/JSON/offline assertions and cc-meta queries only. No compiler, entrypoint, worker/runtime, repair, retry, product edit or cleanup executed by reviewer.

Run /Users/jku/git/c-compiler-land783/build/trap783/durable-run-gate-86r0_bd2. Verified audit markdown52c921cb481b74640dc364aa31414fe292cc1dbbb1b68752f31e78bcffb8048f, audit JSONf412221c539442b7338e2718d6697428436e44c1f8630adc0ffbad22de1a7520, evidence-pins161256f53fa242fc2504a956e56b945eb36df6365c4140cbab3862957149b442. All62 evidence entries match. All23 archived payloads match originals and recorded copy hashes; all9 generated volume images match pre-guest fixture records. Compiled Wasm d9a70ba131917c79baaef21f22fcae5ddb1cbf8a79b8b921823f3ce61c1f00d6 matches module manifest and fresh compiler provenance.

Actual coordinator grant01a09086-59d4-7d7c-b957-ff9d13b895a1 was read from ticket and matches authorization text exactly. Claim and launch bind this fresh directory; plan9d4f2ef97dda98c6afae91ed1eaef6d16e6e825ce8af71fbd45edbe69fda30e8 and config094eb66d354fa9691d0737928ed83e633d0f67548c058f15eb8f662f91b0774c match sealed values and exact allowed template substitutions. Inner launch agrees. Resource/lock preflight is retained; no automatic follow-on is authorized.

Current16 prepared/26 source/5 absolute pins match. Product input cached patch remains9d1759f4431bb6cca76361912f7a6a27ad6307ce0604cad05550a346defad277 for accepted2403c16c on aacbd167; hostfbe30fe0/kernel2efb7afd/worker345c96d1 unchanged. Inner source-after maps and all five outer source-check maps agree with plan; final inspector reports pins unchanged. All38 original V2 RED pins, including its consumed grant/config/claim, remain unchanged.

Independently rechecked raw current-attempt records against exact expected op/path multisets and retained owner values, not merely author pass flags:
- leaf-local:15 rows, /usr descriptor dev2/leaftrue, zero enumerated read/stat/open/close/dup RPCs.
- leaf-broker:15 rows, absent RO descriptor,27 enumerated FS RPCs; exact output rows equal the local case.
- leaf-inherit:3 distinct parent-fd/child-path/child-fd0 rows, two actual worker records and3 enumerated FS RPCs; identity2:8 preserved.
- nested-broker:15 rows, whole RO descriptor absent and27 enumerated FS RPCs. Nested file3:8 and nested-only3:9 are observed; /usr/into follows3:8 while lstat retains2:12. DATA is88/87/88 as owner oracle records.
All48 rows match, including DATA and symlink distinctions. These are generated witness fixtures; no current cmdalt inode pair was measured.

Each case records numeric bootPid1, boot settled, guest halt observed with status0, no primary error/stderr, and actual native completion. All five worker callbacks report exitCode1 with kernelTerminationRequested true, cleanupTerminationRequested false and timestamps before finalization. This is expected kernel-requested worker termination and is distinct from normal guest0 or native parent0; it is not rewritten as worker native0. No failure cleanup was attempted. Conditional outcome requires and records all four completed obligations with no artifact errors.

Native compiler30525 status0/signalnull; direct Node30501 signed returncode0/signalnull at12:52:52.936203Z; supervisor30495 intended0 and independently retained pane30495 dead1/status0 agree. No supervisor signals, deadline, escalation, archive or finalization errors are recorded. Outer stdout/stderr are empty; guest output is retained in case results. Inspector observes tmux30494 retained and no supervisor/direct-child rows, both locks absent. First inspection is terminal: no cross-turn live-survival or exhaustive descendant-history inference. No retained server/socket cleanup performed.

Disposition: ACCEPT this fresh four-case Node runtime evidence at the exact reviewed pins. This resolves the bounded Node witness obligation; the historical V2 attempt remains RED. Success does not exercise failure-cleanup branches, and no such runtime validation is claimed. No repeat is requested solely to reproduce this accepted success.

Browser positive-RO/warm/alias and current cmdalt evidence remain separate pending work and require their own concrete reviewed instrument/serialized scope. Current cmdalt pair remains unmeasured. This is not broad gate, #785 completion, batch landing, commit, deployment or further-launch approval. Preserve all original failures and the existing focused-batch cadence.
