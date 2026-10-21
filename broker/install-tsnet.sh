#!/bin/bash
# Execute only from a frozen, independently approved root-owned release.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
set -euo pipefail
[[ $(/usr/bin/id -u) == 0 ]] || { echo 'Administrator authorization required'; exit 1; }
RESUME=false
if [[ ${1:-} == --resume ]]; then RESUME=true; shift; fi
[[ $# == 2 ]] || { echo 'Expected current muxpad HTTPS URL and agent account name'; exit 1; }
MUXPAD_UI=$1
SUDO_USER=$2
AGENT_UID=$(/usr/bin/id -u "$SUDO_USER")
[[ $AGENT_UID -ne 0 ]] || { echo 'Agent OS account must be unprivileged'; exit 1; }
SOURCE=$(cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
DEST=/Library/muxpad-broker
ACCOUNT=_muxbroker
RUNTIME="$SOURCE/runtime/node"
if [[ $RESUME == false ]]; then
 [[ ! -e $DEST && ! -L $DEST ]] || { echo 'Setup exists. Rerun this same verified installer with --resume before the two arguments.'; exit 1; }
 [[ ! -e /Library/LaunchDaemons/org.muxpad.broker.plist ]] || { echo 'Broker daemon already exists'; exit 1; }
fi
[[ $(/usr/bin/uname -m) == arm64 ]] || { echo 'This release supports Apple Silicon only'; exit 1; }
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
check_path "$SOURCE/install-tsnet.sh"
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
check_binary "$SOURCE/muxpad-tsnet"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$RUNTIME" --input-type=module - "$MUXPAD_UI" <<'JS'
const u = new URL(process.argv[2]);
if(u.protocol !== 'https:' || u.username || u.password || u.hash) throw Error('Use your existing muxpad HTTPS URL');
const [major,minor] = process.versions.uv.split('.').map(Number);
if(process.platform !== 'darwin' || major<1 || (major===1 && minor<52)) throw Error('Incompatible runtime');
JS
if [[ $RESUME == true ]]; then
 check_path "$DEST/setup.pending"
 [[ $(/bin/cat "$DEST/setup.pending") == $(/usr/bin/shasum -a 256 "$SOURCE/install-tsnet.sh" | /usr/bin/awk '{print $1}') ]] || { echo 'Resume requires the exact original verified installer'; exit 1; }
 if /bin/launchctl print system/org.muxpad.broker >/dev/null 2>&1; then echo 'Broker is already running; refusing to reset setup'; exit 1; fi
 BROKER_UID=$(/usr/bin/id -u "$ACCOUNT")
 [[ $(/usr/bin/stat -f '%u:%Lp' "$DEST/state") == "$BROKER_UID:700" ]] || { echo 'Unexpected broker state ownership or permissions'; exit 1; }
 check_binary "$DEST/runtime/node"
 check_binary "$DEST/muxpad-tsnet"
 check_path "$DEST/code/protected-path.mjs"
 # Preserve the enrolled tsnet identity and every existing private state file.
 # Refuse recovery of a paired deployment even if its daemon is stopped.
 /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$BROKER_UID" <<'JS'
import {assertProtectedPath} from "/Library/muxpad-broker/code/protected-path.mjs";
assertProtectedPath("/Library/muxpad-broker/state",[0,Number(process.argv[2])],{mode:0o700});
import {existsSync,readFileSync} from 'node:fs';
const p='/Library/muxpad-broker/state/state.json';
if(existsSync(p)) assertProtectedPath(p,[0,Number(process.argv[2])],{mode:0o600});
if(existsSync(p) && JSON.parse(readFileSync(p,'utf8')).humanPaired) throw Error('Already paired; use administrative maintenance instead');
JS
else
if /usr/bin/dscl . -read /Users/$ACCOUNT >/dev/null 2>&1; then echo 'Broker account already exists; reconcile prior installation first'; exit 1; fi
BROKER_UID=450
while /usr/bin/dscl . -search /Users UniqueID "$BROKER_UID" | /usr/bin/grep -q .; do BROKER_UID=$((BROKER_UID + 1)); done
/usr/bin/dscl . -create /Users/$ACCOUNT
/usr/bin/dscl . -create /Users/$ACCOUNT UniqueID "$BROKER_UID"
/usr/bin/dscl . -create /Users/$ACCOUNT PrimaryGroupID 20
/usr/bin/dscl . -create /Users/$ACCOUNT UserShell /usr/bin/false
/usr/bin/dscl . -create /Users/$ACCOUNT NFSHomeDirectory /var/empty
/usr/bin/dscl . -create /Users/$ACCOUNT IsHidden 1
/usr/bin/dscl . -create /Users/$ACCOUNT Password '*'
/usr/bin/install -d -o root -g wheel -m 755 "$DEST" "$DEST/code" "$DEST/runtime"
/usr/bin/install -d -o "$ACCOUNT" -g staff -m 700 "$DEST/state"
/usr/bin/install -o root -g wheel -m 755 "$RUNTIME" "$DEST/runtime/node"
/usr/bin/install -o root -g wheel -m 644 "$SOURCE/runtime/LICENSE" "$DEST/runtime/LICENSE"
/usr/bin/install -o root -g wheel -m 755 "$SOURCE/muxpad-tsnet" "$DEST/muxpad-tsnet"
for file in core.mjs device-auth.mjs device-client.mjs http.mjs main.mjs slack.mjs human-session.mjs protected-path.mjs state-store.mjs socket-listener.mjs page.html client.js shell.html shell.js shell.css; do
 /usr/bin/install -o root -g wheel -m 644 "$SOURCE/$file" "$DEST/code/$file"
done
/bin/cp -R "$SOURCE/node_modules" "$DEST/code/node_modules"
/usr/sbin/chown -R root:wheel "$DEST/code"
/bin/chmod -RN "$DEST"
/usr/bin/find "$DEST/code" -type d -exec /bin/chmod 755 {} +
/usr/bin/find "$DEST/code" -type f -exec /bin/chmod 644 {} +
(cd "$DEST/code" && /usr/bin/sudo -u "$ACCOUNT" -- /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty "$DEST/runtime/node" --input-type=module -e 'await Promise.all(["core.mjs","http.mjs","slack.mjs","human-session.mjs","protected-path.mjs","state-store.mjs","socket-listener.mjs"].map(name=>import("./"+name)))')
 /usr/bin/shasum -a 256 "$SOURCE/install-tsnet.sh" | /usr/bin/awk '{print $1}' > "$DEST/setup.pending"
 /bin/chmod 600 "$DEST/setup.pending"
fi
# Enrollment is shown ONLY in this trusted setup terminal. The existing Mac
# Tailscale identity is never read, reconfigured or logged out.
echo 'Authorize the new muxpad-secure Tailscale device using the link below on your private device.'
/usr/bin/sudo -u "$ACCOUNT" -- /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty "$DEST/muxpad-tsnet" --enroll-only
# Read the assigned hostname from the helper-owned private output, not Host headers.
ORIGIN=$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'import{readFileSync}from"node:fs";console.log(readFileSync("/Library/muxpad-broker/state/origin","utf8"))')
umask 077
read -r -s -p 'New Slack user OAuth token (input hidden): ' TOKEN; echo
[[ $TOKEN == xoxp-* ]] || { echo 'Expected a user OAuth token'; exit 1; }
printf '%s' "$TOKEN" > "$DEST/state/slack-token"; unset TOKEN
/usr/sbin/chown "$ACCOUNT":staff "$DEST/state/slack-token"
# Ask Slack directly for the team ID; never ask the user to discover it.
TEAM=$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const token = readFileSync('/Library/muxpad-broker/state/slack-token','utf8').trim();
const response = await fetch('https://slack.com/api/auth.test', {method:'POST',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
const data = await response.json();
if(!response.ok || !data.ok || !/^T[A-Z0-9]+$/.test(data.team_id)) throw Error('Slack credential validation failed');
console.log(data.team_id);
JS
)
PAIRING=$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'import{randomBytes}from"node:crypto";console.log(randomBytes(32).toString("base64url"))')
BOOTSTRAP_HASH=$(printf '%s' "$PAIRING" | /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'import{createHash}from"node:crypto";let s="";for await(const c of process.stdin)s+=c;console.log(createHash("sha256").update(s).digest("base64url"))')
if [[ ! -e "$DEST/state/state.json" ]]; then printf '{}' > "$DEST/state/state.json"; fi
/usr/sbin/chown "$ACCOUNT":staff "$DEST/state/state.json"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$ORIGIN" "$MUXPAD_UI" "$TEAM" "$BOOTSTRAP_HASH" > "$DEST/config.json" <<'JS'
const [origin,muxpadURL,teamID,bootstrapHash]=process.argv.slice(2);const u=new URL(origin);const ui=new URL(muxpadURL);
if(u.protocol!=='https:' || u.origin!==origin || !u.hostname.endsWith('.ts.net') || u.hostname===ui.hostname) throw Error('Invalid isolated hostname');
console.log(JSON.stringify({transport:'tsnet',originPath:'/Library/muxpad-broker/state/origin',socketPath:'/Library/muxpad-broker/state/broker.sock',origin,rpID:u.hostname,muxpadURL,teamID,bootstrapHash,approvalMode:'session',autoRead:false,channels:[],tokenPath:'/Library/muxpad-broker/state/slack-token',statePath:'/Library/muxpad-broker/state/state.json'},null,2));
JS
/bin/chmod 644 "$DEST/config.json"
/bin/chmod -RN "$DEST"
for file in "$DEST/state/slack-token" "$DEST/state/state.json" "$DEST/state/origin" "$DEST/state/tailscale"; do
 if /usr/bin/sudo -u "$SUDO_USER" -- /bin/test -r "$file"; then echo 'Agent can read protected state; refusing activation'; exit 1; fi
done
for file in "$DEST" "$DEST/code" "$DEST/runtime/node" "$DEST/muxpad-tsnet" "$DEST/config.json"; do
 if /usr/bin/sudo -u "$SUDO_USER" -- /bin/test -w "$file"; then echo 'Agent can modify protected installation; refusing activation'; exit 1; fi
done
/bin/cat > /Library/LaunchDaemons/org.muxpad.broker.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>org.muxpad.broker</string>
<key>UserName</key><string>$ACCOUNT</string>
<key>ProgramArguments</key><array><string>$DEST/muxpad-tsnet</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>$DEST/state/broker.log</string>
<key>StandardErrorPath</key><string>$DEST/state/broker.err</string>
</dict></plist>
PLIST
/bin/chmod -N /Library/LaunchDaemons/org.muxpad.broker.plist
/bin/chmod 644 /Library/LaunchDaemons/org.muxpad.broker.plist
check_path /Library/LaunchDaemons/org.muxpad.broker.plist
/bin/launchctl bootstrap system /Library/LaunchDaemons/org.muxpad.broker.plist
/bin/rm "$DEST/setup.pending"
echo
echo "Open this NEW protected muxpad address in your private browser: $ORIGIN"
echo "Pairing secret (one use, private): $PAIRING"
unset PAIRING
echo "Configure ordinary muxpad's MUXPAD_SLACK_BROKER_URL=$ORIGIN after its code is integrated."
echo 'Finish the private-browser and OS isolation acceptance checks before sending real messages.'
