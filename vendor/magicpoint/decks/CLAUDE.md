# magicpoint-slides — the deck workshop

This folder is the **magicpoint-slides** cc project. Your job here is to
**author and edit MagicPoint decks** (`.mgp` files) — nothing else. The heavy
machinery (the C compiler, gucOS, the magicpoint renderer source) lives above
this folder; you touch it only if a deck needs it.

## Where you are

- **cwd / project root:** `~/git/wt-mgp-workshop/vendor/magicpoint/decks`
  (this folder), inside the **`wt-mgp-workshop`** git worktree of the
  `c-compiler` repo.
- **Branch:** `mgp-workshop`. All workshopping commits land here; the branch is
  **merged back to `c-compiler` `main` later** — so keep commits deck-focused
  and clean.
- **The repo is bigger than this folder.** Git operations act on the whole
  worktree (`~/git/wt-mgp-workshop`), not just `decks/`. Scope your commits to
  the deck files you actually changed.

## The decks

- `talks/posix-on-wasm.mgp` — the **"POSIX on WebAssembly"** talk deck (the
  primary workshop target).
- `tutorial/01…10-*.mgp` — the 10-part learn-MagicPoint tutorial series.
- `align · backgrounds · bullets · colors · effects · images · text .mgp` —
  single-topic feature-demo decks.
- Scratch/WIP lives in `~/git/wt-mgp-workshop/workshop/` (untracked) — use it
  for throwaway experiments so it never pollutes a commit.

`.mgp` is plain-text MagicPoint source: directive lines start with `%`
(`%page`, `%size`, `%center`, `%fore`, `%image`, `%cont`, …); everything else is
slide body text. Read a sibling deck before inventing directives — match the
idioms already in use.

## Workflow

1. Edit the `.mgp` file(s) directly.
2. Commit with a deck-scoped message (`git -C ~/git/wt-mgp-workshop add <deck>`
   then commit). Keep unrelated files out of the commit.
3. Merge back to `main` is a **later, deliberate step** — do not push to `main`
   from here. When it's time, it's a deck-only merge/cherry-pick onto
   `c-compiler` `main`.
4. Rendering a deck to check it: the magicpoint sources are at
   `~/git/wt-mgp-workshop/vendor/magicpoint/` (there's a `build-native.sh` +
   native reference build if that commit is present on this branch). Don't build
   toolchains ad hoc for a text edit — only render when you actually need to
   eyeball layout.

## cc-meta — talking to other threads

`cc-meta` is on your PATH (run it with Bash, no setup). Output is JSON; all
timestamps are epoch millis. You are one thread among many; `cc-meta` is how you
see and coordinate with the others. Full reference: `cc-meta help`.

```bash
cc-meta whoami                        # YOUR {chatId, projectId} — who am I
cc-meta projects                      # all project ids/names/working dirs
cc-meta list                          # your inbox, newest first
cc-meta list --filter running         # who's mid-turn right now
cc-meta list --filter all --project <projectId> --limit 50
cc-meta thread <chatId>               # one thread's state / cost / running info
cc-meta messages <chatId>             # recent messages (capped; truncation marked)
cc-meta msg <chatId> <messageId>      # one full message
cc-meta last <chatId>                 # final answer + what prompted it
cc-meta envoy <chatId> "question"     # ask ABOUT a thread — answered server-side
                                      #   over the FULL transcript. PREFER this to
                                      #   reading a long thread into your context.
cc-meta search "query"                # substring search across recent threads
```

**Messaging / spawning other threads** (each starts a turn — costs from a shared
6/min budget):

```bash
cc-meta send <chatId> "message" --note "why"        # message a thread
cc-meta new <projectId> "kickoff" --name "title" --note "why"   # fresh thread
cc-meta stop <chatId> --note "why"                  # abort a misdirected turn
```

**Waiting — prefer async, then END YOUR TURN** (never build a polling loop):

```bash
cc-meta wait --async <chatId> --note "why" [--ttl 3600]
#   Registers a one-shot wake: when <chatId> next goes idle, cc starts a NEW
#   turn on YOUR thread with the outcome. Fires ONCE — re-register to keep
#   watching. {"alreadyIdle": true} => it already finished; just read it now.
cc-meta wait <chatId> --last          # short BLOCKING wait (~110s) — inside a turn only
cc-meta waits                         # your wake handles (check for missed/expired)
```

**Inbox hygiene:** `archive` / `star` / `rename` / labels
(`labels`, `label-new`, `label-add`, `label-rm`) — tidy threads you spawn once
their outcome is reported.

### Rules of the road

- **Refusals are answers, not errors.** `running` → the target is mid-turn:
  `wait` then retry. `churn` → a todo-run owns it: hands off. `rate` → you hit
  the 6/min cap: slow down. `self` → you targeted your own thread.
- **Long kickoff/message text goes via a file, not an inline arg** — backticks
  and `$()` in an inline `cc-meta … "…"` argument get shell-substituted and
  corrupt the message.
- **Blocked on a user decision → notify + end your turn.** If you're waiting on
  the user (e.g. "merge this deck to main y/n?"), surface it via the
  `PushNotification` tool with a one-line ask, then stop — don't idle.
- **Waiting on async work → register a wake and end your turn.** Never spin a
  background shell or a foreground poll loop to babysit another thread.

## Scope discipline

This is a **deck-authoring** context. If a task turns out to need real code
changes to the magicpoint renderer, the compiler, or gucOS — that's other
projects' work. Note it, and coordinate rather than reaching up out of this
folder to do it here.
