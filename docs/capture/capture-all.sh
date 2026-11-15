#!/bin/bash
# The whole capture, from nothing: seed, record the tour, then the stills.
set -e
/private/tmp/mxd/seed.sh >/dev/null 2>&1
cd /private/tmp/mxd/cap
T_END=5000 node tour.mjs | tail -2
source /private/tmp/mxd/env.sh; source /private/tmp/mxd/ids.sh
"${MXENV[@]}" MUXPAD_API_URL=http://127.0.0.1:17877 $WT/scripts/muxpad agent send $ci_pane "Yes, rerun it 20x." >/dev/null
sleep 3
node stills.mjs
STATS=full FPS=10 COLORS=80 LOSSY=80 MINPX=400 CAP=0.8 python3 gif.py /private/tmp/mxd/out/tour.gif
