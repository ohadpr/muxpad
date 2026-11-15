# Reshooting the README images

Every pixel in `docs/*.webp` and `docs/tour.gif` is staged. A stand-in agent
runner (`fake-runner.mjs`) speaks the real runner protocol to a real, isolated
muxpad and writes real Claude-format transcripts — but every word comes from
`story.mjs`. No model is called, and all companies, channels and numbers are
invented. The sub-chats, cards, publishes and Slack cards are created through
the real server; only the Slack rows are inserted directly (there is no broker).

The scripts assume the scratch dir `/private/tmp/mxd` and a built worktree at
`~/Developer/worktrees/muxpad/readme-reshoot` (see `env.sh`). Never point them
at the live install: `env.sh` sets its own `MUXPAD_DATA_DIR` **and**
`MUXPAD_PTYD_SOCKET`, a fake `HOME`, ports 17877/17878, and `MUXPAD_NO_FUNNEL=1`.

```sh
mkdir -p /private/tmp/mxd && cp -R docs/capture/* /private/tmp/mxd/
cd ~/Developer/worktrees/muxpad/readme-reshoot && pnpm build
# swap the runner for the stand-in (dist is untracked; `pnpm build` undoes it)
cd server/dist/agent-runner && cp /private/tmp/mxd/fake-runner.mjs fake.mjs \
  && mv index.js index.real.js && printf "await import('./fake.mjs');\n" > index.js
# self-signed cert for the invented docs site the link sheet opens
cd /private/tmp/mxd/site && openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem \
  -out cert.pem -days 7 -subj /CN=docs.trellis.localhost \
  -addext subjectAltName=DNS:docs.trellis.localhost
# playwright-core for the capture scripts
mkdir -p /private/tmp/mxd/cap/node_modules && ln -sfn \
  ~/Developer/worktrees/muxpad/readme-reshoot/node_modules/.pnpm/playwright-core@*/node_modules/playwright-core \
  /private/tmp/mxd/cap/node_modules/playwright-core
/private/tmp/mxd/capture-all.sh      # seed, record the tour, take the stills
```

Captures run headless through the pane's own muxpad browser over CDP
(`MUXPAD_API_URL` + `MUXPAD_TAB_ID`), at 2x. Then:

```sh
python3 /private/tmp/mxd/cap/mobile.py
cd /private/tmp/mxd/out && sips -Z 2000 embed.png --out embed.png
for f in chat-light chat-drawer state-rail embed mobile; do
  cwebp -q 55 -m 6 -sharp_yuv $f.png -o $f.webp; done
```

Tear down: `kill $(cat /private/tmp/mxd/{server,ptyd,site}.pid)`.
