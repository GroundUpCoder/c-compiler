#!/bin/zsh
N=${1:-50}; shift
HERE=${0:A:h}
declare -A counts
for i in $(seq 1 $N); do
  line=$(node "$@" "$HERE/build-once-orig.js")
  sha=${line%% *}
  counts[$sha]=$(( ${counts[$sha]:-0} + 1 ))
  printf "%3d/%d  %s\n" "$i" "$N" "$line"
done
echo "----- tally (node args: $*) -----"
for k v in ${(kv)counts}; do printf "%6d  %s\n" "$v" "$k"; done
echo "distinct SHAs: ${#counts}"
