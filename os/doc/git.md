# git inside gucOS

The `git` package provides `/usr/local/bin/git`, built on libgit2.
Install it with `gucman install git`. It implements a working subset of
git. Unknown options are errors, never ignored.

General form: `git [-C PATH] COMMAND [ARGS...]`.

## Implemented commands

**Read:**

| Command | Notes |
|---|---|
| `log [-n N] [REV]` | One rev at most. Dates print as unix seconds. |
| `show REV` | Commit, tree, or blob. |
| `diff FROM TO` | Prints a file-change list (A/D/M/R/C) only — never patch text. Two revs required; no worktree diff. |
| `status` | Two-column codes; untracked as `??`. |
| `rev-list [-n N] [REV]`, `rev-parse REV`, `cat-file -p OBJ` | |
| `ls-tree [-r] [-t] [REV]` | No pathspec arguments. |

**Write:**

| Command | Notes |
|---|---|
| `init [-q] [--bare] [-b NAME] [DIR]` | |
| `add [-A\|-u] [--] PATH...` | Stages deletions like git 2.x. No `-f`. |
| `commit -m MSG [-a] [--allow-empty]` | `-m` is required — there is no editor. |
| `branch [NAME [START]] [-d\|-D NAME]` | |
| `checkout BRANCH \| -b NAME [START] \| [REV] -- PATH...` | |
| `config [--global] KEY [VALUE]` | `--global` writes `$HOME/.gitconfig`. |

**Network:**

| Command | Notes |
|---|---|
| `clone [-q] URL [DIR]` | |
| `fetch [REMOTE]` | Default `origin`. |
| `pull [REMOTE]` | Fast-forward only. A diverged branch is a loud error. |
| `push [REMOTE [REFSPEC]]` | Default: current branch to the same name. `+` forces. |
| `remote [-v] \| add NAME URL \| remove NAME` | |

## Not implemented

`merge`, `rebase`, `reset`, `restore`, `revert`, `rm`, `mv`, `stash`,
`tag`, `cherry-pick`, `blame`, `grep`, and the rest refuse with a clear
message. Because there is no `merge`, keep your branch fast-forwardable:
pull before you commit, or push to your own branch.

## Set your identity once

```sh
git config --global user.name "Your Name"
git config --global user.email you@example.com
```

A commit without an identity fails and names this fix.

## Credentials for push

Warning: never print a credential to the terminal or into an agent
transcript.

Put one line per remote host in `/root/.git-credentials` (or
`$HOME/.config/git/credentials`):

```
https://USERNAME:TOKEN@github.com
```

A GitHub personal access token works in the TOKEN position. The file
uses git's standard credential-store format; `#` starts a comment. git
reads it in-process on a 401 and never echoes it. A URL of the form
`https://user:token@host/...` also works directly.

## Network requirements

The protocol is smart HTTP (`https://` URLs) only.

- A repository on the OS's own web origin is always reachable — clone
  and push need no setup.
- Any other host (for example `github.com`) needs the HTTP bridge when
  gucOS runs in a browser tab. Start the bridge program on the host
  machine, then turn it on inside gucOS: Control Panel > Network, or set
  `bridge on` in `/root/.config/net`. Without it, off-origin requests
  fail and the error names this fix.
- Recent Chrome asks for a "local network" permission the first time the
  page reaches the bridge. Grant it.
- A headless boot (`node os/boot.js` on the host) reaches the network
  directly. No bridge is needed there.

The bridge caps one request body at 32 MB. A push whose pack exceeds
that fails loudly with HTTP 413. Source pushes stay far under the cap.
