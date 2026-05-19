# Auto-start under launchd (macOS)

muxpad runs as two processes: `ptyd` owns terminals and is rarely restarted; the
main `muxpad` server owns HTTP, the web bundle, and structural state, and
proxies PTY I/O to ptyd. Installing them as separate launchd jobs means
upgrading the main server doesn't disturb your running terminals.

Create both plists below. Replace `INSTALL_PATH` with the absolute path to your
muxpad checkout, and `TAILSCALE_IP` with the bind address (`tailscale ip -4`,
or `127.0.0.1` if you don't use Tailscale). Both plists must agree on
`MUXPAD_PTYD_SOCKET`.

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

Not using launchd? `./scripts/muxpad restart` (without `--all`) does the same
thing: restart main, leave ptyd alone.

## Stop / remove

```bash
launchctl bootout gui/$UID/dev.muxpad
launchctl bootout gui/$UID/dev.muxpad.ptyd
```
