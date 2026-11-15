#!/bin/bash
# Fresh isolated instance + invented workspaces and chats.
source /private/tmp/mxd/env.sh
bash /private/tmp/mxd/up.sh
pkill -f "/private/tmp/mxd/site/server.mjs" 2>/dev/null
nohup "${MXENV[@]}" node /private/tmp/mxd/site/server.mjs > /private/tmp/mxd/site.log 2>&1 &
echo $! > /private/tmp/mxd/site.pid
M() { "${MXENV[@]}" MUXPAD_API_URL=http://127.0.0.1:17877 $WT/scripts/muxpad "$@"; }
API=http://127.0.0.1:17877
W=/private/tmp/mxd/home/work
mkdir -p $W/market-scan/teardown $W/ledgerkit
cat > $W/market-scan/teardown/index.html <<'H'
<!doctype html><meta charset=utf-8><title>Vendor teardown</title><h1>Vendor teardown</h1><p>Five invented vendors, priced.</p>
H
echo "<!doctype html><meta charset=utf-8><title>Entry cost</title><h1>Real entry cost by vendor</h1>" > $W/market-scan/entry-cost.html
cd /tmp
ws1=$(M workspace new --name="Market scan" | grep -oE '[0-9A-Z]{26}' | head -1)
ws2=$(M workspace new --name="Ledgerkit" | grep -oE '[0-9A-Z]{26}' | head -1)
: > /private/tmp/mxd/ids.sh
echo "ws1=$ws1; ws2=$ws2" >> /private/tmp/mxd/ids.sh
A() { # ws cwd name icon var message
  local out tab pane slug
  out=$(M agent new --workspace=$1 --cwd=$2 --name="$3" --mode=chat "$6")
  tab=$(echo "$out" | awk '/tab:/{print $2}'); pane=$(echo "$out" | awk '/pane:/{print $2}')
  url=$(echo "$out" | awk '/url:/{print $2}')
  curl -s -X PATCH $API/api/tabs/$tab -H 'content-type: application/json' -d "{\"icon\":\"$4\"}" >/dev/null
  echo "${5}_tab=$tab; ${5}_pane=$pane; ${5}_url=$url" >> /private/tmp/mxd/ids.sh
  sleep 0.6
}
A $ws2 $W/ledgerkit "ci flakes" "🧪" ci "Find the flaky tests in the ledger suite and tell me why they flake."
A $ws2 $W/ledgerkit "invoice pdf export" "🧾" inv "Invoice PDFs render the euro sign as a box. Fix it."
A $ws2 $W/ledgerkit "oauth device flow" "🔑" oauth "Implement the OAuth device flow for the CLI login."
A $ws1 $W/market-scan "competitor report" "📝" rep "Draft the competitor report from the teardown notes."
A $ws1 $W/market-scan "switching costs" "🚪" sw "What does it cost to leave each vendor once we're on it?"
A $ws1 $W/market-scan "vendor shortlist" "📋" sl "Keep a running shortlist as the teardown comes in."
A $ws1 $W/market-scan "pricing teardown" "💰" pt "Here's the vendor list for the teardown: Brightbill, Ottoline, Ferro, Casewell, Trellis."
sleep 2
source /private/tmp/mxd/ids.sh
M agent send $inv_pane "Re-render INV-20415 for Brasswork Labs and check the total before it goes out." >/dev/null
sleep 2
cat /private/tmp/mxd/ids.sh
