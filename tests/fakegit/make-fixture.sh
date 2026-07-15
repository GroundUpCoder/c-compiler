#!/bin/sh
# make-fixture.sh DEST — materialize the deterministic fakegit fixture repo.
#
# The fakegit category used to run against the live c-compiler checkout,
# which pinned every golden to one HEAD and left the category permanently
# red (todos/0183). This script builds a tiny repo whose history is
# byte-stable on any machine: author/committer name, email, date and tz
# are all fixed, and host/global git config is masked out, so the commit
# hashes baked into tests/fakegit/*/expected.txt reproduce everywhere.
#
# DO NOT change any step below (file bytes, messages, dates, order)
# without regenerating every golden:
#   sh tests/fakegit/make-fixture.sh build/tmp/fakegit-fixture
#   for each tests/fakegit/<t>: run the fakegit wasm against the fixture
#   with <t>/args.txt and write stdout to <t>/expected.txt
set -eu
DEST=$1
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

# Mask the host's git config entirely — a global commit.gpgsign or
# core.autocrlf would change the hashes.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME="Fixture Author" GIT_AUTHOR_EMAIL="author@fakegit.test"
export GIT_COMMITTER_NAME="Fixture Committer" GIT_COMMITTER_EMAIL="committer@fakegit.test"

git -c init.defaultBranch=main init -q .

# commit N MESSAGE — stage everything and commit at a fixed per-commit date.
commit() {
    GIT_AUTHOR_DATE="$((1700000000 + $1 * 60)) +0000"
    GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
    export GIT_AUTHOR_DATE GIT_COMMITTER_DATE
    git add -A
    git commit -q -m "$2"
}

printf 'fakegit fixture repo\n' > README.md
printf 'hello\n' > hello.txt
commit 1 "c1: seed README and hello"

mkdir src
printf 'int main(void) { return 0; }\n' > src/main.c
printf 'fakegit fixture repo\nnow with a src tree\n' > README.md
commit 2 "c2: add src/main.c, grow README"

mkdir docs
printf 'guide v1\n' > docs/guide.txt
git rm -q hello.txt
commit 3 "c3: add docs/guide.txt, drop hello.txt"

printf 'int main(void) { return 42; }\n' > src/main.c
printf 'int util(void) { return 7; }\n' > src/util.c
commit 4 "c4: rework main, add util"

printf 'fakegit fixture repo\nnow with a src tree\nfinal line\n' > README.md
commit 5 "c5: final README touch"

# Working-tree state for the status test: one modified tracked file, one
# untracked file, one untracked directory.
printf 'guide v1\nunstaged edit\n' > docs/guide.txt
printf 'untracked\n' > notes.txt
mkdir scratch
printf 'scratch\n' > scratch/junk.txt
