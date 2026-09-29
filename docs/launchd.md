# Auto-start under launchd (macOS)

muxpad runs as two processes: `ptyd` owns terminals and is rarely restarted; the
main `muxpad` server owns HTTP, the web bundle, and structural state, and
proxies PTY I/O to ptyd. Installing them as separate launchd jobs means
upgrading the main server doesn't disturb your running terminals.

There is an optional **third** job, `dev.muxpad.tunnel`, which exists for one
reason: to stop the published-artifact hostname rotating on every deploy. It is
the only part of this file that changes behaviour rather than just supervision,
and it has a real trade — read §3 before installing it.

Create the plists below. Replace `INSTALL_PATH` with the absolute path to your
muxpad checkout, and `TAILSCALE_IP` with the bind address (`tailscale ip -4`,
or `127.0.0.1` if you don't use Tailscale). Both of the first two plists must
agree on `MUXPAD_PTYD_SOCKET`.

## 1. ptyd — `~/Library/LaunchAgents/dev.muxpad.ptyd.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.muxpad.ptyd</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>INSTALL_PATH/server/dist/ptyd/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MUXPAD_PTYD_SOCKET</key><string>/Users/YOU/.muxpad/ptyd.sock</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/ptyd.log</string>
  <key>StandardErrorPath</key><string>/tmp/ptyd.err</string>
</dict>
</plist>
```

`ThrottleInterval` caps restart frequency so a crashing ptyd can't spin.

## 2. main server — `~/Library/LaunchAgents/dev.muxpad.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.muxpad</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>INSTALL_PATH/server/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MUXPAD_HOST</key><string>TAILSCALE_IP</string>
    <key>MUXPAD_PORT</key><string>7777</string>
    <key>MUXPAD_PTYD_SOCKET</key><string>/Users/YOU/.muxpad/ptyd.sock</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/muxpad.log</string>
  <key>StandardErrorPath</key><string>/tmp/muxpad.err</string>
</dict>
</plist>
```

## 3. the tunnel — `~/Library/LaunchAgents/dev.muxpad.tunnel.plist` (optional)

**The problem this solves.** Published artifact links are served through a
Cloudflare **quick tunnel**, whose four-word hostname is assigned by Cloudflare
**at connect time**. It cannot be pinned — there is no flag for it, and that is
not a muxpad limitation. The names do not rot on their own (measured spans on
this machine: 19 days, then 8 days), so what actually kills them is **restarts**:
the tunnel runs as the `tunnel` app, its pane is a ptyd child, and therefore
every `muxpad restart --all` and every deliberate ptyd bounce mints a new
hostname and kills every link published since the last one. Three rotations in 26
hours during a week of active development.

**The fix.** Give cloudflared a launchd job of its own. Neither `muxpad restart`
nor `muxpad restart --all` can reach it, so the hostname persists until the
machine reboots or cloudflared itself dies — which the data says is rare.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.muxpad.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>INSTALL_PATH/server/dist/tunnel/index.js</string>
    <string>--port</string>
    <string>7778</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MUXPAD_API_URL</key><string>http://127.0.0.1:7777</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/YOU/.muxpad/tunnel.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.muxpad/tunnel.log</string>
</dict>
</plist>
```

Three details are load-bearing:

- **`--port 7778` is the security-critical value.** It must be the hardened
  public artifact server, never :7777 — the main server has no authentication at
  all and serves a terminal. The runner does not take this on trust: it refuses
  to tunnel anything that does not answer `/` with a 404 carrying a `sandbox`
  CSP, which the main server can never do.
- **`KeepAlive` is a dict, not `true`.** `SuccessfulExit: false` means "restart
  on failure, respect a clean exit". That is what lets the runner shut itself
  down for good when `MUXPAD_PUBLIC_BASE_URL` is set — a real domain makes a
  quick tunnel pointless, and a plain `KeepAlive: true` would crash-loop it
  against a domain that already works.
- **No `MUXPAD_PANE_ID`.** That is the whole point. With no pane the runner
  identifies itself to the server by **pid** instead, and the server checks that
  pid is alive (plus a 90s lease renewed by the 30s heartbeat) before it will
  serve the hostname. Same guarantee as before — a dead name cannot outlive its
  process, and nothing has to run for it to become invalid.

Bootstrap it, and check it:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.muxpad.tunnel.plist
muxpad publish --tunnel      # owner should be "a process muxpad does not supervise"
```

`muxpad publish --tunnel` is the surface that replaces `muxpad app logs tunnel`
and `muxpad app stop tunnel` here: both of those read and kill a *pane*, and this
runner has none, so they would report success and do nothing. It prints the log
path and the `launchctl bootout` line that actually closes the door.

muxpad stands down in front of it automatically — `ensureTunnelApp` sees a live
external owner and refuses to register or start its own tunnel, stopping one that
is already running. You do not have to `muxpad app stop tunnel` first.

### The trade, stated plainly

**A tunnel that survives a muxpad restart is a tunnel muxpad no longer
supervises.** Four consequences, in the order they will bite:

1. **`muxpad app logs/stop tunnel` no longer reach it.** Its log is the plist's
   `StandardOutPath`; its stop is `launchctl bootout gui/$UID/dev.muxpad.tunnel`.
   `muxpad publish --tunnel` prints both.
2. **A stale job can serve :7778 while muxpad is down.** cloudflared keeps the
   hostname and proxies to a port nothing is listening on, so the edge answers
   **502** until muxpad comes back — and then the *same* hostname starts working
   again. That is the behaviour you are buying, not a bug: today the name would
   have died instead.
3. **But "nothing there" can become "something ELSE there".** If another process
   binds 127.0.0.1:7778 while muxpad is down, an unsupervised tunnel would
   happily publish it. So the fingerprint check is **re-run on every 30s
   heartbeat**, not just at startup: nothing listening → keep the tunnel (that is
   case 2); something answering that is not muxpad's public server → retract the
   url, kill cloudflared, exit. The tunnel comes back on launchd's retry once the
   port is muxpad's again, with a new hostname. Safety costs the name.
4. **Upgrades do not reach it either.** `pnpm build` + `launchctl kickstart -k
   gui/$UID/dev.muxpad` leaves this job running the code it started with. That is
   usually what you want (kickstarting it rotates the hostname), but it means a
   fix to `server/src/tunnel/*` does not take effect until you deliberately
   bounce it.

**The permanent fix is a NAMED tunnel on your own domain**, which makes the
hostname something you own rather than something Cloudflare hands you. This job
does not block it or conflict with it: set `MUXPAD_PUBLIC_BASE_URL` in
`dev.muxpad.plist` and the runner is told `wanted: false` on its next announce
and exits cleanly, leaving the domain as the base.

## Bootstrap

Bootstrap ptyd first so the main server's `PtydClient` connects on its first
try instead of emitting a brief `[disconnected]` event while it backs off:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.muxpad.ptyd.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.muxpad.plist
launchctl print gui/$UID/dev.muxpad.ptyd | head    # confirm ptyd loaded
launchctl print gui/$UID/dev.muxpad | head         # confirm main loaded
tail -f /tmp/muxpad.err /tmp/ptyd.err
```

The tunnel job (§3) may be bootstrapped in any order — it waits for the public
server rather than exiting when it is not there yet.

## Upgrading muxpad without killing terminals

After `git pull` + `pnpm -r build`, restart only the main server. ptyd keeps
running, so every terminal pane survives the upgrade:

```bash
launchctl kickstart -k gui/$UID/dev.muxpad
```

`kickstart -k` restarts one job in place; `dev.muxpad.ptyd` is a separate
`KeepAlive: true` job and isn't touched.

If you actually need to restart ptyd (e.g., to pick up a ptyd code change —
rare), do it deliberately, knowing it will kill every running PTY:

```bash
launchctl kickstart -k gui/$UID/dev.muxpad.ptyd
```

`./scripts/muxpad` detects the jobs and routes itself through launchctl, so
you don't have to remember which mode you're in:

| command | launchd-managed | hand-started |
|---|---|---|
| `muxpad status` | reads the job's pid, prints `owner: launchd` | reads the pid file |
| `muxpad start` | `kickstart` (never spawns a rival copy) | `spawn_detached` |
| `muxpad restart [--all]` | `kickstart -k` in place | stop + start |
| `muxpad stop [--all]` | `bootout` (a SIGTERM would just be undone by KeepAlive) | SIGTERM → SIGKILL |

A booted-out job stays down until `muxpad start` or the next login (RunAtLoad).

`dev.muxpad.tunnel` is deliberately absent from that table: `./scripts/muxpad`
does **not** route to it, because being out of reach of `muxpad restart --all` is
the entire reason it exists.

## Stop / remove

```bash
launchctl bootout gui/$UID/dev.muxpad
launchctl bootout gui/$UID/dev.muxpad.ptyd
launchctl bootout gui/$UID/dev.muxpad.tunnel   # if installed — this rotates the hostname
```

Booting the tunnel out hands muxpad its own tunnel back: with no live external
owner, the next publish registers and starts the `tunnel` app again, under a new
hostname.
