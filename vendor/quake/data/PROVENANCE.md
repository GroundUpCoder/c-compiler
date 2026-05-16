# Provenance of the shareware Quake data

The contents of this directory are the **first-episode shareware** data
that id Software has freely redistributed since June 1996.

## What's here

| File | Size | SHA-256 |
|---|---:|---|
| `id1/pak0.pak` | 18,689,235 | `35a9c55e5e5a284a159ad2a62e0e8def23d829561fe2f54eb402dbc0a9a946af` |
| `SHAREWARE-LICENSE.txt` | 10,036 | id's `SLICNSE.TXT` — the actual end-user agreement |
| `LICENSE-INFO.txt` | 9,311 | id's `LICINFO.TXT` — license summary |

## Source

Downloaded from Internet Archive item
[`msdos_Quake106_shareware`](https://archive.org/details/msdos_Quake106_shareware):

- File: `msdos_Quake106_shareware.zip`
- Size: 9,050,608 bytes (compressed)
- SHA-1 (zip): `58cd0c811ab428ebe916ee9fb61d91d867be92c9`

This is id's v1.06 shareware release (June 1996), the canonical
free-to-distribute episode. `pak0.pak` here is the unmodified
`ID1/PAK0.PAK` from inside that zip.

## License grant

Quoting `SHAREWARE-LICENSE.txt` §6 (verbatim, line-wrap normalized):

> ID grants to you, the end-user, the limited right to distribute,
> free of charge only, the Software as a whole.

Free redistribution is explicitly granted; commercial distribution is
prohibited. We comply: this repo (including this `data/` directory) is
open-source and free to download. We are not selling Quake; the
shareware data is bundled solely so the engine has something to load
during local development and the Playwright runtime test.

Note that the GPL-2.0 license at `vendor/quake/gnu.txt` applies only
to the **engine source code** under `vendor/quake/src/`. The data
files in this directory remain id Software's proprietary content
under the shareware-license terms above; they are NOT under GPL.

## To get the full game

The shareware data covers episode 1 only. For the full game (episodes
2–4, additional weapons, more monsters), purchase the registered
version on GOG, Steam, or the Quake remaster. Drop the registered
`pak1.pak` next to this `pak0.pak` and the engine will pick it up.
