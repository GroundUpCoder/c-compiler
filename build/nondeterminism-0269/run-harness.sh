#!/bin/zsh
# Loop the fresh-process SameBoy build N times, tally distinct SHAs.
# Usage: run-harness.sh N [extra-node-args...]
N=${1:-50}; shift
HERE=${0:A:h}
declare -A counts
first=""
for i in $(seq 1 $N); do
  line=$(node "$@" "$HERE/build-once.js")
  sha=${line%% *}
  counts[$sha]=$(( ${counts[$sha]:-0} + 1 ))
  [[ -z "$first" ]] && first=$line
  printf "%3d/%d  %s\n" "$i" "$N" "$line"
done
echo "----- tally (node args: $*) -----"
echo "length line0: $first"
for k v in ${(kv)counts}; do
  printf "%6d  %s\n" "$v" "$k"
done
echo "distinct SHAs: ${#counts}"
