# #545 — gucman upgrade: why a staged replacement, not remove+install

The ticket scoped "an upgrade that is atomic" and suggested remove+install.
Three things that landed after it was filed make a literal remove+install
route wrong, and they shaped the whole mechanism:

1. **#624** made `remove` refuse while dependents exist. An upgrade built on
   remove would either refuse for every srclib-shaped package (libpng under
   netsurf) or pass `--force` internally, silently disarming a guard the
   user deliberately gets. The upgrade never consults the guard at all: the
   name never leaves the system, so dependents stay satisfied by
   construction.
2. **#419** tombstones are written BEFORE the DB record goes, and
   `sync-defaults` skips a tombstoned name forever. A remove+install upgrade
   that dies between its halves leaves a defaultPackage permanently
   uninstalled and un-restorable by the defaults path — and
   `defaultPackages` is four packages now. The upgrade never writes a
   tombstone: not in the happy path, not in the crash window, not even in
   the failure path (a failed upgrade uninstalls honestly but leaves
   sync-defaults free to restore a default on the next boot — that is the
   correct outcome, not a bug).
3. **#630** claim transfer composes with the replay unchanged: the upgrade
   reuses the same `gm_replay_plant` (factored out of `cmd_remove`), so a
   shared tier kept on ENOTEMPTY migrates its claim to a survivor exactly as
   a remove does, and the re-plant's `gm_tier_mkdir` correctly declines to
   double-claim a transferred dir. One asymmetry, accepted: during the
   replay the package's own OLD record still exists on disk, so
   `gm_dir_claimed` can see a self-claim and skip adoption of a tier that is
   about to be orphaned by the record replacement — the next srclib
   install/upgrade adopts it (the #630 healing path).

## The crash contract

The DB record is only ever atomically REPLACED (`gm_write_file_atomic` over
the same path), never absent. Ordering: download → sha256 → gunzip → tar
validation → extract to staging → control/script validation (all abortable
with the old install intact) → old prerm (`argv[1]="upgrade"`, non-fatal) →
`gm_replay_plant` of the old record → sweep + rename → plant → new postinst
(`"upgrade"`) → record replace → positional-line reconcile. A SIGKILL
anywhere leaves "installed at the old version" and a re-run of `upgrade`
converges (the crashed-remove precedent: the replay is ENOENT-tolerant).
The e2e pins this LIVE: it SIGKILLs gucman while the new postinst is parked
on a flag file, asserts no tombstone + old record intact, and re-runs to
convergence.

Convergence after a crash relies on plant names being STABLE across
versions (the universal case). A version that RENAMES its bin/menu entries
and crashes mid-upgrade re-runs into the plant's refuse-on-exists and
degrades to the honest-uninstall path — the same residue class a crashed
plain install already has (planted links with no record refuse the
re-install). Not widened here.

## Version semantics: converge, both directions

There is no ordering over version strings — they are opaque labels, and
`list --all`'s `(update)` marker was already bare `strcmp` inequality. So
"differs from the index" IS the upgrade condition, in both directions: the
repository is the single authority, and a publisher rolling back a bad
release must reach installs the same way a release does. The banner prints
the exact move ("upgrading X 2.0 -> 1.0") and claims no direction.
Inventing a dotted-numeric comparator was considered and rejected: it would
misfire on non-numeric labels and buys nothing in a single-repo,
single-published-version ecosystem.

`update` stays free for #73 (apt-style index fetch/cache). `install` on an
installed package stays an offline no-op (the storefront and script
callers keep their semantics) but now names the upgrade path — the silent
`return 0` was half the reported bug. Deps of a named target are not
upgraded transitively; bare `gucman upgrade` converges everything.

## Positional /etc lines — the subtle preserve

`/etc/cmdalt` claim order IS the dispatch default (first claim wins), and
`/etc/fonts/fallback` is priority order. A replay-then-replant would move
the upgraded package's lines to the END — with two claimants on one name,
upgrading the default holder would silently flip the default to the other
package. So: the upgrade replay SKIPS both families,
`gm_cmdalt_set`/`gm_fontline_set` adds became idempotent IN PLACE (an
existing identical line leaves the file untouched — strictly better for
plain installs too), and claims/faces the new version dropped are
reconciled away after the new record lands. The e2e's red control is a
second claimant installed after the target: pre-#545 mechanics would flip
the first line to it.

Desktop shortcuts are preserved by PRESENCE (measured before the replay
unlinks them), ignoring the current toggle in both directions: present
stays present with the toggle off; a user-deleted icon does not resurrect
with it on.

## Incidentals

- **Pre-existing UAF fixed**: `gm_install_one`'s db-write-failure path
  called `gm_unwind` after `cJSON_Delete(db)` — the undo arrays are db's
  children, so the unwind replayed freed memory. Unwind now precedes the
  delete.
- **Test lore**: a bare `wait` after `pkill -9 gucman` hangs — the killed
  gucman's parked postinst child reparents to pid 1, which in a driveBoot
  session IS the driving shell, so `wait` adopts and blocks on it. Bounded
  `pgrep` polls instead.
- `packages/netsurf.json` 3.12 → **3.12-2** (packaging revision — the
  upstream core is still NetSurf 3.12; the kickoff suggested 3.13, but that
  would claim an upstream release we don't ship, and strcmp-converge is
  format-agnostic). #177/#365 now reach existing installs through the verb.
- gucman.c is a bake input → image.json 253 → 254, fat image resealed.
