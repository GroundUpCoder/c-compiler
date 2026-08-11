# gcode — the in-OS coding agent

`gcode` is a line-oriented coding assistant that runs inside gucOS. It
speaks the Anthropic Messages API and edits files and runs commands
through tools. Install it with `gucman install gcode` (it is also a
default package on a networked boot).

## Configuration

Set the environment before you start it:

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | The API key (or `ANTHROPIC_AUTH_TOKEN` for a bearer token). |
| `ANTHROPIC_BASE_URL` | Default `https://api.anthropic.com`. |
| `ANTHROPIC_MODEL` | The model id. |

Warning: reaching the API from a browser tab needs the HTTP bridge
(read `git.md`, "Network requirements").

## Flags

```
gcode [-p PROMPT] [--model M] [--system-prompt S]
      [--max-turns N] [--max-tokens N] [--context-tokens N]
      [--resume ID|PATH] [-c|--continue]
      [--no-persist] [--no-context] [--verbose] [--no-color]
```

- `-p PROMPT` runs one prompt and exits (one-shot mode). Without it,
  gcode is an interactive session.
- `--continue` resumes the last session; `--resume ID` a named one.
  Sessions persist unless `--no-persist`.
- `gcode --help` documents the token and context knobs.

## Tools

The agent has: `bash`, `read_file`, `write_file`, `edit_file`,
`list_dir`, `grep`, `glob`. Every tool result is size-capped, so a large
file or a chatty command cannot destroy the context. The bash tool has a
wall-time cap (default 120 s, env `GCODE_BASH_SECS`).

## Context files

gcode appends layered `GCODE.md` files to its system prompt: the baked
`/usr/share/gcode/GCODE.md` (platform facts), then `/etc/gcode`, then
`~/.config/gcode`, then a walk up from the working directory. Put
project facts in a `GCODE.md` at your project root. `--no-context`
disables the layer.

## Long sessions

gcode tracks the context window. It warns at 75% and compacts at 85% —
the oldest rounds fold into a summary and the session continues. Type
`/compact` to fold on demand, `/clear` to start over.
