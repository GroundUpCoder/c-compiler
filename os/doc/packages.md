# Packages: gucman, sources packages, and rebuilds

`gucman` is the package manager. It installs packages from the package
repository into `/opt`, and plants their commands in `/usr/local/bin`.

## Commands

| Command | Effect |
|---|---|
| `gucman install NAME` | Install NAME and its dependencies. Already installed: no-op. |
| `gucman remove NAME [--force]` | Remove NAME. Refuses while another installed package depends on it. |
| `gucman upgrade [NAME]` | Converge NAME (or everything installed) on the repository version. |
| `gucman list` | List installed packages. No network. |
| `gucman list --all` | List the full catalog, with install state. |
| `gucman info NAME` | Show catalog fields, install state, and every planted file. |
| `gucman index` | Print the repository index (raw JSON). |

There is no `search` command. Use `gucman list --all`.

The repository URL is the first line of `/etc/gucman/repos` if that file
exists, else the baked `/usr/share/gucman/repos`. The baked default is
`/packages` on the serving origin.

## What an install does

gucman downloads the payload, verifies its sha256 against the index, and
extracts it to a staging directory. The verified tree then appears
atomically at `/opt/NAME`. gucman then plants the package's declared
surface: command symlinks in `/usr/local/bin`, file associations in
`/etc/openwith`, menu entries in `/etc/menu`, and source/header links
(see below). The record `/var/lib/gucman/NAME.json` is written last —
its existence means "installed". Read it to see everything the package
planted.

A package can declare a `minBase`. gucman refuses to install it on an
older system image.

## Sources packages

Every buildable package and every system binary has a companion
`NAME-sources` package. It carries the complete compile closure of the
binary: every `.c` file, every header, and the project description files
(`bin.json`, `lib.json`). With it you can read, modify, and rebuild the
program inside gucOS.

```sh
gucman install gcode-sources
```

The payload installs at `/opt/gcode-sources`. The install also plants
one symlink:

```
/usr/local/src/gcode -> /opt/gcode-sources
```

Under it, the sources keep their repository-relative paths:

```
/usr/local/src/gcode/os/gcode/gcode.c
/usr/local/src/gcode/os/gcode/bin.json
/usr/local/src/gcode/os/curl/lib.json
/usr/local/src/gcode/vendor/cjson/cJSON.c
```

`libc-sources` is special: it carries the compiler's own libc headers
and sources, for reading.

## bin.json and lib.json

A `bin.json` describes one program. A `lib.json` describes a library it
uses. The fields that matter for a rebuild:

| Field | Meaning |
|---|---|
| `sources` | Source files, relative to the json file's directory. |
| `deps` | Paths of other project json files. Expand them recursively. |
| `includes` | Include directories → `-I` flags. |
| `compilerArgs` | Extra `-D` and `-I` flags. |
| `srcRoots` | Source-root namespaces for `__require_source`. Already satisfied by `/usr/local/src` — you can ignore it. |

## How to rebuild a binary from its sources package

There is no project build command yet. Translate the json files into
one `cc` command by hand:

1. Open the program's `bin.json`.
2. Walk every `deps` entry, recursively. Collect every json file once.
3. From each json file, collect its `sources`. Resolve each path
   against that json file's own directory.
4. From each json file, collect its `includes` and its `compilerArgs`
   `-I` entries. Turn each into a `-I` flag.
5. Collect each `compilerArgs` `-D` entry.
6. Run `cc` with every collected source, every `-I`, every `-D`, and
   `-o` your output path.

Warning: `compilerArgs` can also carry `--allow-old-c`,
`--gc-spill-locals`, or `--allow-zero-length-arrays`. The in-OS `cc`
ignores them. If the build fails without them, report it.

### Worked example: rebuild gcode

```sh
gucman install gcode-sources
cd /usr/local/src/gcode
cat os/gcode/bin.json
```

The json names two sources (`gcode.c`, `../../vendor/cjson/cJSON.c`),
one include directory (`../../vendor/cjson`), and two deps:
`../curl/lib.json` and `../../vendor/busybox/lineedit.json`. Open each
dep and repeat. The curl lib adds `os/curl/libcurl.c` and
`-Ios/curl/include`. The lineedit lib adds the busybox line-editing
sources and one more dep, `libbb-core.json`, with its own sources,
includes, and defines. The full walk yields about 47 source files, 5
include directories, and 3 defines. Then:

```sh
cc os/gcode/gcode.c vendor/cjson/cJSON.c os/curl/libcurl.c \
   ...the-remaining-collected-sources... \
   -Ivendor/cjson -Ios/curl/include ...the-remaining--I-and--D-flags... \
   -o /root/gcode-new
/root/gcode-new --help
```

A clean rebuild of gcode takes a few seconds. Verify your build runs
before you replace anything.

## What you cannot do yet

- `cc` has no `--project bin.json` mode. The hand translation above is
  the current practice.
- gucman cannot build a `.pkg.tar.gz` inside gucOS, and cannot install
  from a local file. To ship a change, publish the source — read
  `publish.md`.
