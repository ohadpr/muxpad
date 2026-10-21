import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaging is unprivileged. The printed digest is NOT approval or a signature.
// An independent trusted reviewer must approve this exact archive out of band.
const tsnetRelease = process.argv[2] === '--tsnet';
const output = resolve(process.argv[tsnetRelease ? 3 : 2] || 'muxpad-broker-review.tar');
const helperPath = tsnetRelease ? resolve(process.argv[4] || '') : null;
const nodeDirectory = tsnetRelease ? resolve(process.argv[5] || '') : null;
if (tsnetRelease && (!process.argv[4] || !process.argv[5]))
  throw Error('Expected --tsnet OUTPUT COMPILED_HELPER OFFICIAL_NODE_DIRECTORY');
if (existsSync(output)) throw Error('Refusing to overwrite an existing review artifact');
const source = fileURLToPath(new URL('.', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'muxpad-broker-review-'));
const stage = join(temporary, 'broker');
function copy(from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink !== 1))
    throw Error('Release inputs must be regular non-hardlinked files or directories');
  if (st.isDirectory()) {
    mkdirSync(to, { mode: 0o755 });
    for (const name of readdirSync(from)) copy(join(from, name), join(to, name));
  } else copyFileSync(from, to);
}
try {
  mkdirSync(stage, { mode: 0o755 });
  for (const name of [
    'install.sh',
    'update-code.sh',
    'core.mjs',
    'device-auth.mjs',
    'device-client.mjs',
    'http.mjs',
    'main.mjs',
    'slack.mjs',
    'human-session.mjs',
    'protected-path.mjs',
    'state-store.mjs',
    'socket-listener.mjs',
    'page.html',
    'client.js',
    'shell.html',
    'shell.js',
    'shell.css',
    'package.json',
    'package-lock.json',
    'node_modules',
  ])
    copy(join(source, name), join(stage, name));
  if (tsnetRelease) {
    copy(join(source, 'install-tsnet.sh'), join(stage, 'install-tsnet.sh'));
    copy(join(source, 'tsnet'), join(stage, 'tsnet-source'));
    copy(helperPath, join(stage, 'muxpad-tsnet'));
    mkdirSync(join(stage, 'runtime'), { mode: 0o755 });
    copy(join(nodeDirectory, 'bin/node'), join(stage, 'runtime/node'));
    copy(join(nodeDirectory, 'LICENSE'), join(stage, 'runtime/LICENSE'));
  }

  execFileSync('/usr/bin/tar', ['-cf', output, '-C', temporary, 'broker'], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  console.log(`UNAPPROVED review artifact: ${output}`);
  console.log(`SHA-256: ${createHash('sha256').update(readFileSync(output)).digest('hex')}`);
  console.log('Do not install until an independent trusted channel approves this exact digest.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
