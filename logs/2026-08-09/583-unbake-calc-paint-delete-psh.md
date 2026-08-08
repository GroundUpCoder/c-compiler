# #583 — unbake calc/paint; delete psh

`calc` and `paint` moved from `os/image.json` into ordinary gucman package
definitions. Both remain in `defaultPackages`, preserving the current
networked-boot experience while separating their payload/release lifecycle
from the base image. Paint's `bmp` association now arrives as a package claim
in `/etc/openwith`; calc carries its `.res` sidecar in its package payload.

This reduces every base-image bake and blob download by the two application
payloads, but does not reduce total networked first-boot traffic: default
package synchronization still downloads them. The gain is base-image weight
and independent package release cadence.

The unused prototype shell was removed outright, including
`os/protoshell.c`. Busybox hush remains `/bin/sh` and pid 1; no boot-path code
referenced `psh`. Historical `logs/**` and `todos/done/**` references were
left unchanged.

The first full gate exposed a lifecycle gap hidden while calc/paint shortcuts
were raw user-image entries: package `desktop` was opt-in, so a default-package
sync did not preserve those built-in shortcuts. The package declarations now
mark that status-quo surface explicitly with `desktop.default: true`, and
`gucman sync-defaults` plants only shortcuts carrying that bit. This applies
both to a downloaded default and its folded twin. Plain desktop eligibility
remains opt-in: in particular, doom gains no boot-time shortcut.
