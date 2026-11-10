#!/bin/bash
#
# KEEP MUXPAD'S MSGVAULT GRANT ALIVE.
#
# msgvault agent grants are held IN MEMORY: "valid until revoked or until its
# optional expiry, or until the daemon restarts" (msgvault agent-token --help).
# So every daemon restart and every reboot invalidated muxpad's token, and the
# only symptom was `agent authentication failed` on EVERY connector call,
# reads included. That is what the "agent disconnected"-shaped msgvault
# failures were.
#
# Installed as /usr/local/libexec/muxpad/msgvault-agent-token-heal.sh and run
# by /Library/LaunchDaemons/org.muxpad.msgvault-agent-token.plist every 120s.
# Silent when healthy; one line per re-issue.
#
#   sudo install -o root -g wheel -m 755 \
#     scripts/msgvault-agent-token-heal.sh \
#     /usr/local/libexec/muxpad/msgvault-agent-token-heal.sh
#
set -uo pipefail

HOME_DIR=/usr/local/var/msgvault
BIN=/usr/local/libexec/msgvault/msgvault
TOKEN_FILE=/Library/muxpad-broker/msgvault-agent-token
LOG=/var/log/muxpad-msgvault-token.log
STAMP=/var/run/muxpad-msgvault-token.last
URL=http://127.0.0.1:8787
# Re-issuing is cheap but not free: each one mints a grant the daemon keeps in
# memory until it restarts. A fault that is NOT about authentication must not
# turn this into a token factory, so there is a floor between attempts.
MIN_REISSUE_GAP=300

AS=(sudo -u _msgvault env "MSGVAULT_HOME=$HOME_DIR" "HOME=$HOME_DIR")
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }

# Daemon down? Not this script's problem, and issuing would fail anyway.
curl -sf -m 5 -o /dev/null "$URL/api/ping" || exit 0

# ── IS THE GRANT GOOD? ────────────────────────────────────────────────────
# `stats` is the cheapest call that needs a permission. NOT `stats --json`:
# that is not a flag, and a probe that can never succeed turns this script
# into the token factory described above. (It did, for one afternoon.)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
if [[ -s $TOKEN_FILE ]] && "$BIN" --agent-url "$URL" --agent-token-file "$TOKEN_FILE" \
     --agent-allow-insecure --log-level=error stats >/dev/null 2>"$W/probe"; then
  exit 0
fi

# ── WHY DID IT FAIL? ──────────────────────────────────────────────────────
# Only an AUTHENTICATION failure means the grant died. A timeout, a locked
# database or a half-started daemon are all transient, and re-issuing on them
# would mint a token every two minutes while fixing nothing.
if [[ -s $TOKEN_FILE ]] && ! grep -qiE 'agent authentication failed|invalid or missing api key|token is invalid|unauthorized|401' "$W/probe"; then
  say "probe failed but not with an auth error, leaving the grant alone: $(tail -1 "$W/probe" | cut -c1-160)"
  exit 0
fi

NOW=$(date +%s)
LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
if (( NOW - LAST < MIN_REISSUE_GAP )); then
  say "auth still failing $((NOW - LAST))s after the last re-issue; waiting rather than minting another"
  exit 0
fi
printf '%s' "$NOW" > "$STAMP"

"${AS[@]}" "$BIN" --local --log-level=error list-accounts --json >"$W/acc" 2>"$W/err" || {
  say "FAIL list-accounts: $(tail -1 "$W/err" | cut -c1-160)"; exit 1; }
IDS=$(python3 -c '
import json,sys
rows=json.load(open(sys.argv[1]))
rows=rows if isinstance(rows,list) else rows.get("accounts",rows.get("sources",[]))
ids=[]
for r in rows:
    v=r.get("id") or r.get("source_id") or r.get("email")
    if v and str(v) not in ids: ids.append(str(v))
print(",".join(ids))' "$W/acc" 2>>"$LOG")
[[ -n ${IDS:-} ]] || { say "FAIL no sources in list-accounts output"; exit 1; }

# Reads + drafts. `calendar.write` and `calendar.invite` are deliberately
# absent: an invite mails the attendees, which is sending under the owner's
# name, and muxpad has no verb for it.
"${AS[@]}" "$BIN" --local --log-level=error agent-token issue \
  --label "muxpad agents (read + draft)" --source-ids "$IDS" \
  --permissions search.read,message.read,attachment.read,stats.read,calendar.read,calendar.event.read,draft.create,draft.edit,draft.delete \
  --json >"$W/tok" 2>"$W/err" || {
  # stdout only above: msgvault logs to stderr, and capturing 2>&1 here fed
  # log lines to a JSON parser.
  say "FAIL issue: $(tail -1 "$W/err" | cut -c1-160)"; exit 1; }

# Written to a temp file in the same directory and moved into place, so a
# reader never sees a half-written token.
TMP=$(mktemp /Library/muxpad-broker/.tok.XXXXXX)
if ! ID=$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
t=d.get("token") or d.get("grant_token") or d.get("secret")
if not isinstance(t,str) or len(t)<16: raise SystemExit("no token; keys: "+",".join(d))
open(sys.argv[2],"w").write(t.strip()+"\n")
print(d.get("id","?"))' "$W/tok" "$TMP" 2>>"$LOG"); then
  rm -f "$TMP"; say "FAIL parse (issue stdout was $(wc -c <"$W/tok") bytes)"; exit 1
fi
chown _muxbroker:wheel "$TMP"; chmod 600 "$TMP"; chmod -N "$TMP" 2>/dev/null || true
mv -f "$TMP" "$TOKEN_FILE"
say "re-issued grant $ID"
