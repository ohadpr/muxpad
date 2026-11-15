#!/bin/bash
# Tear down and rebuild the isolated demo instance from nothing.
source /private/tmp/mxd/env.sh
for p in server ptyd; do [ -f /private/tmp/mxd/$p.pid ] && kill $(cat /private/tmp/mxd/$p.pid) 2>/dev/null; done
sleep 1
pkill -f "readme-reshoot/server/dist/agent-runner" 2>/dev/null
rm -rf /private/tmp/mxd/data /private/tmp/mxd/home/.claude /private/tmp/mxd/fake-runner.log
mkdir -p /private/tmp/mxd/data
cd /private/tmp/mxd
nohup "${MXENV[@]}" node $WT/server/dist/ptyd/index.js > /private/tmp/mxd/ptyd.log 2>&1 &
echo $! > /private/tmp/mxd/ptyd.pid
for i in $(seq 1 30); do [ -S /private/tmp/mxd/data/ptyd.sock ] && break; sleep 0.2; done
nohup "${MXENV[@]}" node $WT/server/dist/index.js > /private/tmp/mxd/server.log 2>&1 &
echo $! > /private/tmp/mxd/server.pid
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:17877/ && break; sleep 0.3; done
curl -s -X PUT http://127.0.0.1:17877/api/prefs/theme -H 'content-type: application/json' -d '{"value":"riso"}' >/dev/null
echo up
