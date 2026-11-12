#!/usr/bin/env bash
# Extract one JSON summary per Claude Code session transcript, for extract.py.
#
# Takes the sessions to measure as arguments, so nobody's home directory or
# project names end up in a public repo:
#
#   ./run.sh ~/.claude/projects/*/*.jsonl
#   ./run.sh "$HOME/.claude/projects/-my-project/<session-id>.jsonl"
#
# `nice` because a full corpus is a few minutes of CPU and this is analysis,
# not work anybody is waiting on.
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "usage: ./run.sh <session.jsonl>..." >&2
  exit 1
fi
for f in "$@"; do
  b=$(basename "$f" .jsonl)
  nice -n 10 python3 extract.py "$f" "s_${b:0:8}.json"
done
