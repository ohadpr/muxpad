#!/bin/bash
# Run only from a reviewed release frozen in a root-owned directory.
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED
set -euo pipefail
[[ $(/usr/bin/id -u) == 0 ]] || { echo 'Administrator authorization required'; exit 1; }
[[ $# == 0 || ( $# == 1 && $1 == --locked ) ]] || { echo 'Invalid arguments'; exit 1; }
umask 077
SOURCE=$(cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
DEST=/Library/muxpad-broker
check_path() {
 local path=$1 owner mode listing
 [[ $path == /* && -e $path && ! -L $path ]] || { echo "Not a protected path: $path"; exit 1; }
 while [[ $path != / ]]; do
  [[ ! -L $path ]] || { echo 'Symlink in protected path'; exit 1; }
  owner=$(/usr/bin/stat -f '%u' "$path"); mode=$(/usr/bin/stat -f '%Lp' "$path")
  [[ $owner == 0 ]] && (( (8#$mode & 0022) == 0 )) || { echo "Unprotected path: $path"; exit 1; }
  listing=$(/bin/ls -lde "$path")
  if printf '%s\n' "$listing" | /usr/bin/grep -Eq '^[[:space:]]*[0-9]+:'; then echo 'ACL on protected path'; exit 1; fi
  path=$(/usr/bin/dirname "$path")
 done
}
check_path "$SOURCE/update-code.sh"
check_path "$DEST/code"
check_path "$DEST/runtime/node"
check_path /Library/LaunchDaemons/org.muxpad.broker.plist
if [[ -e $DEST/code-update.lock || -L $DEST/code-update.lock ]]; then
 check_path "$DEST/code-update.lock"
 [[ $(/usr/bin/stat -f '%l' "$DEST/code-update.lock") == 1 ]] || { echo 'Hardlinked lock refused'; exit 1; }
fi
if [[ $# == 0 ]]; then
 exec /usr/bin/lockf -k -t 0 "$DEST/code-update.lock" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash --noprofile --norc "$SOURCE/update-code.sh" --locked
fi
# Validate existing runtime/code and the source before any service interruption.
for tree in "$SOURCE" "$DEST/code"; do
 while IFS= read -r -d '' entry; do
  [[ ! -L $entry && ( -f $entry || -d $entry ) ]] || { echo 'Unexpected file type'; exit 1; }
  check_path "$entry"
  if [[ -f $entry && $(/usr/bin/stat -f '%l' "$entry") != 1 ]]; then echo 'Hardlink refused'; exit 1; fi
 done < <(/usr/bin/find "$tree" -print0)
done
FILES=(core.mjs device-auth.mjs device-client.mjs http.mjs main.mjs slack.mjs human-session.mjs protected-path.mjs state-store.mjs socket-listener.mjs page.html client.js shell.html shell.js shell.css)
for file in "${FILES[@]}"; do
 [[ -f $SOURCE/$file ]] || { echo "Missing release file: $file"; exit 1; }
done
# The update marker pins retries to the same exact source contents.
RELEASE=$(for file in "${FILES[@]}" update-code.sh; do /usr/bin/shasum -a 256 "$SOURCE/$file"; done | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')
MARKER="$DEST/code-update"
# BEGIN COMPLETED RELEASE ROLLOVER
archive_completed_update() {
 local old_release archive part entry
 check_path "$MARKER"
 [[ $(/usr/bin/stat -f '%l' "$MARKER") == 1 ]] || { echo 'Hardlinked marker refused'; exit 1; }
 old_release=$(/usr/bin/sed -n '1p' "$MARKER")
 [[ $old_release =~ ^[0-9a-f]{64}$ ]] || { echo 'Invalid update marker'; exit 1; }
 if [[ $old_release == "$RELEASE" ]]; then return; fi
 [[ $(/usr/bin/sed -n '2p' "$MARKER") == ready ]] || { echo 'Unfinished update belongs to a different frozen release'; exit 1; }
 # Preserve completed backups instead of deleting/reusing them. Move the marker
 # last: interruption during either directory move resumes this same rollover.
 if [[ ! -e $DEST/completed-updates && ! -L $DEST/completed-updates ]]; then /bin/mkdir -m 700 "$DEST/completed-updates"; fi
 check_path "$DEST/completed-updates"
 archive="$DEST/completed-updates/$old_release"
 if [[ ! -e $archive && ! -L $archive ]]; then /bin/mkdir -m 700 "$archive"; fi
 check_path "$archive"
 [[ -d $archive && ! -e $archive/marker && ! -L $archive/marker ]] || { echo 'Conflicting completed update archive'; exit 1; }
 for part in code.previous code.next; do
  if [[ -e $DEST/$part || -L $DEST/$part ]]; then
   [[ ! -e $archive/$part && ! -L $archive/$part ]] || { echo 'Conflicting completed update tree'; exit 1; }
   entry="$DEST/$part"
  else
   entry="$archive/$part"
  fi
  [[ -d $entry ]] || { echo 'Missing completed update tree'; exit 1; }
  while IFS= read -r -d '' entry; do
   [[ ! -L $entry && ( -f $entry || -d $entry ) ]] || { echo 'Unexpected completed file type'; exit 1; }
   check_path "$entry"
   [[ ! -f $entry || $(/usr/bin/stat -f '%l' "$entry") == 1 ]] || { echo 'Hardlinked completed file refused'; exit 1; }
  done < <(/usr/bin/find "$entry" -print0)
  if [[ -e $DEST/$part ]]; then /bin/mv "$DEST/$part" "$archive/$part"; fi
 done
 /bin/mv "$MARKER" "$archive/marker"
}
if [[ -e $MARKER || -L $MARKER ]]; then archive_completed_update; fi
# END COMPLETED RELEASE ROLLOVER
if [[ ! -e $MARKER ]]; then
 [[ ! -e $DEST/code.previous && ! -L $DEST/code.previous ]] || { echo 'Previous backup exists without update marker; reconcile manually'; exit 1; }
 [[ ! -e $DEST/code.next && ! -L $DEST/code.next ]] || { echo 'Staging exists without update marker; reconcile manually'; exit 1; }
fi
phase() {
 /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "$MARKER" "$RELEASE" "$1" <<'JS'
import {openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
const [path, release, phase] = process.argv.slice(2);
const temporary = `${path}.${process.pid}`;
const fd = openSync(temporary, 'wx', 0o600);
try { writeFileSync(fd, `${release}\n${phase}\n`); fsyncSync(fd); } finally { closeSync(fd); }
renameSync(temporary,path);
const dir = openSync(dirname(path),'r');
try { fsyncSync(dir); } finally { closeSync(dir); }
JS
}
PHASE=$([[ -f $MARKER ]] && /usr/bin/sed -n '2p' "$MARKER" || echo preparing)
trap 'echo "Update incomplete. Rerun the SAME frozen update command to finish forward; do not restore older authentication code."' ERR
if [[ $PHASE == preparing ]]; then
 phase preparing
 # Partial backup/staging from interruption can be completed before any live writes.
 /usr/bin/ditto "$DEST/code" "$DEST/code.previous"
 /usr/bin/ditto "$DEST/code" "$DEST/code.next"
 for file in "${FILES[@]}"; do
  /usr/bin/install -o root -g wheel -m 644 "$SOURCE/$file" "$DEST/code.next/$file"
 done
 /bin/chmod -RN "$DEST/code.next"
 phase prepared
fi
# Validate all staged paths even during retry. No symlinks/hardlinks accepted.
for tree in "$DEST/code.previous" "$DEST/code.next"; do
 check_path "$tree"
 while IFS= read -r -d '' entry; do
  [[ ! -L $entry && ( -f $entry || -d $entry ) ]] || { echo 'Unexpected staged file type'; exit 1; }
  check_path "$entry"
  [[ ! -f $entry || $(/usr/bin/stat -f '%l' "$entry") == 1 ]] || { echo 'Hardlink refused'; exit 1; }
 done < <(/usr/bin/find "$tree" -print0)
done
for file in "${FILES[@]}"; do /usr/bin/cmp -s "$SOURCE/$file" "$DEST/code.next/$file"; done
# Complete dependency closure and private-file access, under the actual service UID.
/usr/bin/sudo -u _muxbroker /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty "$DEST/runtime/node" "$DEST/code.next/main.mjs" "$DEST/config.json" --check
# launchctl disable persists across reboot, unlike bootout alone. Leave disabled
# on interruption until the same verified release has been completely installed.
phase inhibiting
/bin/launchctl disable system/org.muxpad.broker
phase stopping
if /bin/launchctl print system/org.muxpad.broker >/dev/null 2>&1; then
 /bin/launchctl bootout system/org.muxpad.broker
fi
if /bin/launchctl print system/org.muxpad.broker >/dev/null 2>&1; then echo 'Broker still loaded; refusing live code writes'; exit 1; fi
phase installing
# Keep the fixed code directory present. An interrupted copy is completed by retry,
# while the daemon remains unloaded. Never automatically downgrade device state.
for file in "${FILES[@]}"; do
 /usr/bin/install -o root -g wheel -m 644 "$DEST/code.next/$file" "$DEST/code/$file"
done
for file in "${FILES[@]}"; do /usr/bin/cmp -s "$DEST/code.next/$file" "$DEST/code/$file"; done
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - "${FILES[@]}" <<'JS'
import {openSync,fsyncSync,closeSync} from 'node:fs';
const base='/Library/muxpad-broker/code';
for(const path of [...process.argv.slice(2).map(name=>`${base}/${name}`),base]) {
 const fd=openSync(path,'r');
 try { fsyncSync(fd); } finally { closeSync(fd); }
}
JS
phase installed
# Only complete, compared and durably written code may run after reboot.
phase starting
/bin/launchctl enable system/org.muxpad.broker
/bin/launchctl bootstrap system /Library/LaunchDaemons/org.muxpad.broker.plist
ORIGIN=$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - <<'JS'
import {readFileSync} from 'node:fs';
const c=JSON.parse(readFileSync('/Library/muxpad-broker/config.json','utf8'));
const origin=c.transport==='tsnet'?readFileSync(c.originPath,'utf8').trim():c.origin;
const u=new URL(origin);
if(u.protocol!=='https:'||u.origin!==origin||!u.hostname.endsWith('.ts.net'))throw Error('Invalid readiness origin');
console.log(origin);
JS
)
for attempt in {1..30}; do
 if /usr/bin/curl --silent --fail --max-time 2 "$ORIGIN/health" | /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;try{if(JSON.parse(s).version!=="full-slack-v1-2026-10-19")process.exit(1)}catch{process.exit(1)}'; then
  phase ready
  echo 'New popup broker is ready. Existing pairing and private state preserved.'
  exit 0
 fi
 /bin/sleep 1
done
echo 'Job loaded, but new broker readiness is unconfirmed. Rerun the same frozen command; do not restore older authentication code.'
exit 1
