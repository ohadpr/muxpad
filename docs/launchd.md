# Auto-start under launchd (macOS)

Create `~/Library/LaunchAgents/dev.muxpad.plist` with the content below. Replace `INSTALL_PATH` with the absolute path to your muxpad checkout, and `TAILSCALE_IP` with the bind address (`tailscale ip -4`).

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
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/muxpad.log</string>
  <key>StandardErrorPath</key><string>/tmp/muxpad.err</string>
</dict>
</plist>
```

Bootstrap and start:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.muxpad.plist
launchctl print gui/$UID/dev.muxpad | head    # confirm it's loaded
tail -f /tmp/muxpad.err
```

Stop / remove:

```bash
launchctl bootout gui/$UID/dev.muxpad
```
