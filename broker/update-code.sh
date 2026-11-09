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
# ── THE TREE WALK, IN ONE PROCESS ────────────────────────────────────────
# `check_path` above forks `stat` twice, `ls -lde` once and `dirname` once for
# EVERY ANCESTOR of EVERY FILE. Over the installed tree — ~1,450 files, up to
# twelve deep — that is ~28,000 processes and 10–12 minutes per pass, which is
# how two updates came to be abandoned halfway and left the broker disabled.
#
# This does the identical walk in a single node process: one lstat per path
# (no fork), ancestors memoised because they are shared, and ONE batched
# `ls -lde` per 160 paths for the ACL check. Measured: 1,453 paths in 0.12s.
#
# IT IS NOT WEAKER. Same five refusals — symlink, wrong owner, group/other
# write, hardlinked regular file, ACL — plus the same "unexpected file type".
# Proved against the original on a matrix of clean/symlink/group-writable/
# other-writable/hardlink/ACL-on-file/ACL-on-dir/fifo: both allow the clean
# tree and refuse all seven, every time.
#
# EMBEDDED, not a file in the release. A separate script would have to be
# validated before it could be trusted to validate anything, which is the
# bootstrap problem this avoids: bash validates the node BINARY, and this
# program travels inside the already-validated update-code.sh.
#
# The bash `check_path` stays for the handful of single paths checked before
# the runtime is trusted — four files, a few dozen forks.
check_tree() {
 /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module - 0 -- "$@" <<'JS'
import {execFileSync} from 'node:child_process';
import {lstatSync,readdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const argv=process.argv.slice(2);
// Owners as an ARGUMENT, never an environment variable: this runs under
// `env -i` and update-code.sh owns the argv, so nothing a caller sets widens it.
const OWNERS=new Set(String(argv.shift()??'0').split(',').map(Number));
const cut=argv.indexOf('--');
const roots=cut===-1?argv:argv.slice(0,cut);
const trees=cut===-1?[]:argv.slice(cut+1);
const die=(m)=>{console.error(m);process.exit(1)};
const seen=new Set();const all=[];
function judge(path,recurse){
 if(seen.has(path))return;seen.add(path);
 // A newline would break the batched `ls` parse below. Nothing in a release
 // has one, and refusing is the safe direction.
 if(/[\n\r]/.test(path))die('Newline in protected path');
 let st;try{st=lstatSync(path)}catch{die('Not a protected path: '+path)}
 if(st.isSymbolicLink())die('Symlink in protected path: '+path);
 if(!st.isFile()&&!st.isDirectory())die('Unexpected file type: '+path);
 if(!OWNERS.has(st.uid)||st.mode&0o022)die('Unprotected path: '+path);
 if(st.isFile()&&st.nlink!==1)die('Hardlink refused: '+path);
 all.push(path);
 const parent=dirname(path);
 if(parent!==path&&path!=='/')judge(parent,false);
 if(recurse&&st.isDirectory())for(const n of readdirSync(path))judge(resolve(path,n),true);
}
for(const p of roots){if(!p.startsWith('/'))die('Not a protected path: '+p);judge(p,false)}
for(const t of trees){if(!t.startsWith('/'))die('Not a protected path: '+t);judge(t,true)}
const CHUNK=160;
for(let i=0;i<all.length;i+=CHUNK){
 const batch=all.slice(i,i+CHUNK);let out;
 try{out=execFileSync('/bin/ls',['-lde','--',...batch],{encoding:'utf8',maxBuffer:64<<20})}
 catch(e){out=String(e.stdout??'');if(!out)die('Could not inspect ACLs')}
 let current='';
 for(const line of out.split('\n')){
  if(/^\s*\d+:\s/.test(line))die('ACL on protected path: '+current.trim());
  if(line.trim())current=line;
 }
}
JS
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
 check_tree "$tree" || exit 1
done
FILES=(broker-paths.mjs capabilities.mjs client.js core.mjs device-auth.mjs device-client.mjs http.mjs human-session.mjs main.mjs msgvault-runner.mjs msgvault.mjs node-policy.mjs node-session.mjs page.html passkey-admin-socket.mjs passkey-approval.mjs passkey-http.mjs policy.mjs protected-path.mjs shell.css shell.html shell.js slack.mjs socket-listener.mjs state-store.mjs)
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
  check_tree "$entry" || exit 1
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
 check_tree "$tree" || exit 1
done
for file in "${FILES[@]}"; do /usr/bin/cmp -s "$SOURCE/$file" "$DEST/code.next/$file"; done
# Complete dependency closure and private-file access, under the actual service UID.
/usr/bin/sudo -u _muxbroker /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty "$DEST/runtime/node" "$DEST/code.next/main.mjs" "$DEST/config.json" --check
# launchctl disable persists across reboot, unlike bootout alone. Leave disabled
# on interruption until the same verified release has been completely installed.
phase inhibiting
/bin/launchctl disable system/org.muxpad.broker
phase stopping
# ── BOOTOUT IS ASYNCHRONOUS, SO WAIT FOR IT ──────────────────────────────
# `launchctl bootout` returns before teardown finishes. The check used to run
# on the very next line, saw the service still loaded, and refused — leaving
# the broker booted out AND `launchctl disable`d, which persists across
# reboot, with the update half done. That happened on BOTH attempted runs and
# each one needed a second pass to recover.
#
# So the refusal is still there, and it now means what it says: thirty
# seconds of asking, not one look. Polling rather than sleeping, so the normal
# case costs a fraction of a second.
if /bin/launchctl print system/org.muxpad.broker >/dev/null 2>&1; then
 /bin/launchctl bootout system/org.muxpad.broker
fi
for _ in $(/usr/bin/seq 1 60); do
 /bin/launchctl print system/org.muxpad.broker >/dev/null 2>&1 || break
 /bin/sleep 0.5
done
if /bin/launchctl print system/org.muxpad.broker >/dev/null 2>&1; then echo 'Broker still loaded after 30s; refusing live code writes'; exit 1; fi
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
# THE READINESS VERSIONS COME FROM THE RELEASE, NOT FROM A LITERAL HERE.
# This check asserted one hardcoded string and the shipped code had moved on,
# so a PERFECTLY GOOD update ended with "readiness is unconfirmed" and exit 1 —
# which reads exactly like a broken install and sent somebody re-running a
# frozen release against a broker that was already healthy.
#
# Replacing the literal with a newer literal would rebuild the same trap, and
# sooner than it looks: http.mjs reports a DIFFERENT version under
# `approvalMode: session` than under `passkey-inline`, so the next cutover
# would have failed this check in the middle of a security change.
ALLOWED=$(/usr/bin/grep -oE "'[A-Za-z0-9-]+-v[0-9]+-20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]'" "$SOURCE/http.mjs" | /usr/bin/tr -d "'")
[[ -n $ALLOWED ]] || { echo 'No health version found in the release; refusing to guess'; exit 1; }
for attempt in {1..30}; do
 if /usr/bin/curl --silent --fail --max-time 2 "$ORIGIN/health" | /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$DEST/runtime/node" --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;try{if(!process.argv.slice(1).includes(JSON.parse(s).version))process.exit(1)}catch{process.exit(1)}' $ALLOWED; then
  phase ready
  echo 'New popup broker is ready. Existing pairing and private state preserved.'
  exit 0
 fi
 /bin/sleep 1
done
echo 'Job loaded, but new broker readiness is unconfirmed. Rerun the same frozen command; do not restore older authentication code.'
exit 1
