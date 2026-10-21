#!/bin/bash
# Run ONLY from an independently verified root-controlled staging artifact.
# Never sudo a script in an agent-writable checkout, even after source review.
# See broker/README.md for the external digest verification/bootstrap procedure.
# Enter using /usr/bin/env -i as documented: BASH_ENV can execute before a
# script starts, so sanitizing inside the script is not a substitute for that.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
set -euo pipefail
[[ $(/usr/bin/id -u) == 0 ]] || { echo 'Run this installer with sudo in your own terminal.' >&2; exit 1; }
[[ $# == 6 ]] || { echo 'Expected NODE ORIGIN TEAM CERT KEY MUXPAD_URL; use the verified-stage clean-environment command in README.md'; exit 1; }
RUNTIME=$1 ORIGIN=$2 TEAM=$3 CERT=$4 KEY=$5 MUXPAD_UI=$6
SOURCE=$(cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
DEST=/Library/muxpad-broker
ACCOUNT=_muxbroker
[[ ! -e $DEST && ! -L $DEST ]] || { echo 'Existing broker installation path; refusing to overwrite it'; exit 1; }
[[ ! -e /Library/LaunchDaemons/org.muxpad.broker.plist ]] || { echo 'Existing broker LaunchDaemon; refusing to overwrite it'; exit 1; }

# The runtime and every non-system linked library must be protected, including
# ancestor directories. Homebrew's user-owned paths deliberately fail this check.
check_path() {
  local path=$1 owner mode listing
  [[ $path == /* && -e $path && ! -L $path ]] || { echo "Not a protected absolute path: $path"; exit 1; }
  while [[ $path != / ]]; do
    [[ ! -L $path ]] || { echo "Symlink in protected path: $path"; exit 1; }
    owner=$(/usr/bin/stat -f '%u' "$path"); mode=$(/usr/bin/stat -f '%Lp' "$path")
    [[ $owner == 0 ]] && (( (8#$mode & 0022) == 0 )) || { echo "Root ownership and no group/world write required: $path"; exit 1; }
    listing=$(/bin/ls -lde "$path") || exit 1
    if printf '%s\n' "$listing" | /usr/bin/grep -Eq '^[[:space:]]*[0-9]+:'; then
      echo "ACL on protected path; refusing: $path"; exit 1
    fi
    path=$(/usr/bin/dirname "$path")
  done
}
# These checks are defense in depth AFTER independent verification of the
# staged artifact. A mutable installer cannot authenticate its own source.
check_path "$SOURCE/install.sh"
check_path "$SOURCE"
check_path /Library
check_path /Library/LaunchDaemons
[[ -n ${SUDO_USER:-} && $SUDO_USER != root ]] || { echo 'Install with sudo from the actual agent OS account so its effective access can be checked'; exit 1; }
while IFS= read -r -d '' staged; do
  [[ ! -L $staged && ( -f $staged || -d $staged ) ]] || { echo 'Non-regular staged artifact entry'; exit 1; }
  check_path "$staged"
  if [[ -f $staged && $(/usr/bin/stat -f '%l' "$staged") != 1 ]]; then echo 'Hardlinked staged artifact entry'; exit 1; fi
done < <(/usr/bin/find "$SOURCE" -print0)
SEEN=''
check_binary() {
  local bin=$1 dep libraries
  [[ "|$SEEN|" == *"|$bin|"* ]] && return
  SEEN="${SEEN}|${bin}"
  check_path "$bin"
  libraries=$(/usr/bin/otool -L "$bin") || { echo "Cannot inspect runtime libraries: $bin"; exit 1; }
  while IFS= read -r dep; do
    [[ -z $dep || $dep == /usr/lib/* || $dep == /System/* ]] && continue
    [[ $dep == /* ]] || { echo "Unresolved dynamic library $dep; install a protected Node runtime"; exit 1; }
    check_binary "$dep"
  done < <(printf '%s\n' "$libraries" | /usr/bin/tail -n +2 | /usr/bin/awk '{print $1}')
}
check_binary "$RUNTIME"
check_path "$CERT"; check_path "$KEY"
# Reject a bad hostname configuration before creating an account or writing secrets.
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module - "$ORIGIN" "$MUXPAD_UI" <<'JS'
const [origin, muxpadURL] = process.argv.slice(2); const broker = new URL(origin); const ui = new URL(muxpadURL);
if (broker.protocol !== 'https:' || broker.origin !== origin || broker.username || broker.password || ui.protocol !== 'https:' || ui.hostname === broker.hostname || ui.username || ui.password || ui.hash) throw Error('Use two different HTTPS hostnames; the broker origin must have no path');
JS
[[ -d $SOURCE/node_modules/@simplewebauthn/server ]] || { echo 'First run npm ci --ignore-scripts --prefix broker as your normal user'; exit 1; }
if /usr/bin/dscl . -read /Users/$ACCOUNT >/dev/null 2>&1; then
  echo 'Broker account already exists. Refusing to overwrite an installed trust boundary.'; exit 1
fi
BROKER_UID=450
while /usr/bin/dscl . -search /Users UniqueID "$BROKER_UID" | /usr/bin/grep -q .; do BROKER_UID=$((BROKER_UID + 1)); done
/usr/bin/dscl . -create /Users/$ACCOUNT
/usr/bin/dscl . -create /Users/$ACCOUNT UniqueID "$BROKER_UID"
/usr/bin/dscl . -create /Users/$ACCOUNT PrimaryGroupID 20
/usr/bin/dscl . -create /Users/$ACCOUNT UserShell /usr/bin/false
/usr/bin/dscl . -create /Users/$ACCOUNT NFSHomeDirectory /var/empty
/usr/bin/dscl . -create /Users/$ACCOUNT IsHidden 1
/usr/bin/dscl . -create /Users/$ACCOUNT Password '*'
/usr/bin/install -d -o root -g wheel -m 755 "$DEST" "$DEST/code"
/usr/bin/install -d -o "$ACCOUNT" -g staff -m 700 "$DEST/state"
for file in core.mjs device-auth.mjs device-client.mjs http.mjs main.mjs slack.mjs human-session.mjs protected-path.mjs state-store.mjs socket-listener.mjs page.html client.js shell.html shell.js shell.css; do /usr/bin/install -o root -g wheel -m 644 "$SOURCE/$file" "$DEST/code/$file"; done
# Refuse dependency symlinks before copying code into the protected boundary.
[[ -z $(/usr/bin/find "$SOURCE/node_modules" -type l -print -quit) ]] || { echo 'Unexpected dependency symlink'; exit 1; }
/bin/cp -R "$SOURCE/node_modules" "$DEST/code/node_modules"
/usr/sbin/chown -R root:wheel "$DEST/code"
/bin/chmod -RN "$DEST"
/usr/bin/find "$DEST/code" -type d -exec /bin/chmod 755 {} +
/usr/bin/find "$DEST/code" -type f -exec /bin/chmod 644 {} +
check_path "$DEST/code"
# Prove the dedicated UID can traverse dependencies and load the actual module
# before asking for any credential or attempting daemon activation.
(cd "$DEST/code" && /usr/bin/sudo -u "$ACCOUNT" -- /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module -e 'await Promise.all(["core.mjs","http.mjs","slack.mjs","human-session.mjs","protected-path.mjs","state-store.mjs","socket-listener.mjs"].map(name=>import("./"+name)))')
umask 077
read -r -s -p 'New Slack user OAuth token (input hidden): ' TOKEN; echo
[[ $TOKEN == xoxp-* ]] || { echo 'Expected xoxp user token'; exit 1; }
printf '%s' "$TOKEN" > "$DEST/state/slack-token"; unset TOKEN
read -r -s -p 'Choose a random one-use device pairing secret (input hidden): ' BOOTSTRAP; echo
[[ ${#BOOTSTRAP} -ge 32 ]] || { echo 'Use at least 32 characters'; exit 1; }
BOOTSTRAP_HASH=$(printf '%s' "$BOOTSTRAP" | /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module -e 'import{createHash}from"node:crypto";let s="";for await(const c of process.stdin)s+=c;console.log(createHash("sha256").update(s).digest("base64url"))'); unset BOOTSTRAP
printf '{}' > "$DEST/state/state.json"
/usr/sbin/chown "$ACCOUNT":staff "$DEST/state/"*
# Copy the TLS material into a directory agents cannot traverse.
/usr/bin/install -o "$ACCOUNT" -g staff -m 600 "$KEY" "$DEST/state/tls.key"
/usr/bin/install -o "$ACCOUNT" -g staff -m 600 "$CERT" "$DEST/state/tls.crt"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module - "$ORIGIN" "$TEAM" "$BOOTSTRAP_HASH" "$MUXPAD_UI" > "$DEST/config.json" <<'JS'
const [origin, teamID, bootstrapHash, muxpadURL] = process.argv.slice(2); const u = new URL(origin); const ui = new URL(muxpadURL);
if (u.protocol !== 'https:' || origin !== u.origin || ui.protocol !== 'https:' || ui.hostname === u.hostname || ui.username || ui.password || ui.hash) throw Error('Use an HTTPS origin without a path');
console.log(JSON.stringify({ origin, rpID:u.hostname, teamID, bootstrapHash, approvalMode:'session', muxpadURL, port:9443, autoRead:false, channels:[], tokenPath:'/Library/muxpad-broker/state/slack-token', statePath:'/Library/muxpad-broker/state/state.json', tlsKeyPath:'/Library/muxpad-broker/state/tls.key', tlsCertPath:'/Library/muxpad-broker/state/tls.crt' }, null, 2));
JS
/bin/chmod -RN "$DEST"
/bin/chmod 644 "$DEST/config.json"
/bin/cat > /Library/LaunchDaemons/org.muxpad.broker.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>org.muxpad.broker</string>
<key>UserName</key><string>$ACCOUNT</string>
<key>ProgramArguments</key><array><string>$RUNTIME</string><string>$DEST/code/main.mjs</string><string>$DEST/config.json</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DEST/state/broker.log</string>
<key>StandardErrorPath</key><string>$DEST/state/broker.err</string>
</dict></plist>
PLIST
/bin/chmod -N /Library/LaunchDaemons/org.muxpad.broker.plist
/bin/chmod 644 /Library/LaunchDaemons/org.muxpad.broker.plist
check_path /Library/LaunchDaemons/org.muxpad.broker.plist
# Check effective access as the actual agent UID, not just numeric mode bits.
for private_file in "$DEST/state/slack-token" "$DEST/state/state.json" "$DEST/state/tls.key"; do
  if /usr/bin/sudo -u "$SUDO_USER" -- /bin/test -r "$private_file"; then echo 'Agent account can read protected state; refusing activation'; exit 1; fi
done
for protected_path in "$DEST" "$DEST/code" "$DEST/code/main.mjs" "$DEST/config.json" "$RUNTIME"; do
  if /usr/bin/sudo -u "$SUDO_USER" -- /bin/test -w "$protected_path"; then echo 'Agent account can change the protected installation; refusing activation'; exit 1; fi
done
/bin/launchctl bootstrap system /Library/LaunchDaemons/org.muxpad.broker.plist
echo "Installed. Configure protected forwarding to loopback 9443; then open $ORIGIN yourself in your own device browser."
echo 'Pair once there. That muxpad screen then opens a one-click approval modal automatically.'
echo 'Never pair an agent browser or a browser/profile agents can read or drive.'
