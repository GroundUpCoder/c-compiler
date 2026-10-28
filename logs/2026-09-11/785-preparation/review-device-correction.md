Correction to independent #785 review01a09040-8995: device-origin reachability

The author is correct. I did not establish an existing conversion from pathname-opened filesystem device nodes to specialized tty/null/out OFDs. My statement that the plan contained a device-origin contradiction was unsupported and is withdrawn.

I have now directly read pinned kernel FS_OPEN3768-3774 and spawn OPEN2880-2887: both retain kind=file with bfsFd. BlockFS S_IFCHR open at host3005-3016 preserves inoId, and fstat3719 reads that inode. Therefore opened filesystem device nodes follow the existing file branch through MountFS.fstat, which the proposed qualification already covers. Specialized _stdOfds2502-2515 and PTY_CREATE3239-3240 are separate construction paths with no filesystem pathname established here. I identified no existing conversion/origin seam requiring new machinery.

Do not implement speculative conversion or duplicate origin storage to satisfy my prior claim. Keep explicit /dev stat/fstat, dup and spawn tests; preserve existing origin where one exists. Distinguish backend fd.dev (rdev used for device I/O) from stat.dev (filesystem identity), without overwriting that internal dispatch field. The proposed anonymous-object boundary remains separate, and strict serializers still require explicit metadata behavior for those producers.

Core owner-issued MountFS/RO identity design remains accepted for planning with the other token, fallback, error and scope recommendations. No additional device-origin design blocker remains on the inspected paths. This is still not implementation/source/runtime/launch/landing approval. Reads only; no product edits or probes.
