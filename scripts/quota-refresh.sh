#!/bin/bash
# Redraw the subscription quota card. NO AGENT INVOLVED.
#
# This was a muxpad cron that sent a prompt into a chat, so the card could only
# be redrawn by a model turn — and the moment it matters most is exactly when
# no turn can run, because a subscription is exhausted. It went stale precisely
# when it had news. The schedule now drives the scripts and the chat is never
# involved.
#
# Usage:  quota-refresh.sh [--tab=<tabId>]
# The tab defaults to $MUXPAD_TAB_ID, which is set inside a pane and is NOT set
# under a scheduler — so a scheduled copy must name the tab it writes to.
set -uo pipefail

# A SCHEDULER HANDS A JOB ALMOST NO ENVIRONMENT. launchd gives PATH=/usr/bin:/bin
# and little else, which is how the first run outside a terminal died: the CLI
# needs `jq` (homebrew), and the card script shelled out to a bare `muxpad`.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
export MUXPAD_BIN="$ROOT/scripts/muxpad"
export MUXPAD_API_URL="${MUXPAD_API_URL:-http://127.0.0.1:${MUXPAD_PORT:-7777}}"

for arg in "$@"; do
  case "$arg" in
    --tab=*) MUXPAD_TAB_ID="${arg#--tab=}" ;;
    *) echo "usage: quota-refresh.sh [--tab=<tabId>]" >&2; exit 2 ;;
  esac
done
export MUXPAD_TAB_ID="${MUXPAD_TAB_ID:-}"
stamp() { date "+%Y-%m-%dT%H:%M:%S%z"; }

if [ -z "$MUXPAD_TAB_ID" ]; then
  echo "$(stamp) fail:  no tab — pass --tab=<tabId> (a scheduler has no MUXPAD_TAB_ID)" >&2
  exit 2
fi
if ! curl -fsS --max-time 5 -o /dev/null "$MUXPAD_API_URL/api/workspaces"; then
  # Worth distinguishing from a card failure: the server being down is not a
  # reason to think the card logic broke.
  echo "$(stamp) fail:  no muxpad server at $MUXPAD_API_URL" >&2
  exit 3
fi

# THE TWO STEPS ARE NOT CHAINED. The probe asks each LIVE account how full it
# is and fails, correctly, for one being refused. The card does not need it:
# the pool's cooldown row already says "full until <time>", which is the whole
# answer for a dead subscription. Running the card only `&&` after a successful
# probe is what kept a stale card on screen all day.
node "$ROOT/scripts/quota-probe.mjs" 2>&1 | sed "s/^/$(stamp) probe: /"
probe=${PIPESTATUS[0]}
node "$ROOT/scripts/quota-card.mjs" 2>&1 | sed "s/^/$(stamp) card:  /"
card=${PIPESTATUS[0]}

[ "$probe" -eq 0 ] || echo "$(stamp) note:  probe exited $probe (expected while a subscription is refused)"
# The CARD's exit code is the job's.
exit "$card"
