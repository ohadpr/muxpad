import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  existsSync,
  mkdirSync,
  readdirSync,
  chmodSync,
  chownSync,
  copyFileSync,
  readSync,
  writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maintenanceHistory } from './maintenance-history.mjs';
import { reconnect, selectReconnect } from './reconnect.mjs';
import { completeSetup } from './setup-enrollment.mjs';
const ROOT = '/Library/muxpad-broker',
  JOB = 'system/org.muxpad.broker',
  PLIST = '/Library/LaunchDaemons/org.muxpad.broker.plist';
const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/var/empty' };
const hash = (b) => createHash('sha256').update(b).digest('hex');
export function releasePath(name) {
  return (
    typeof name === 'string' &&
    /^[@A-Za-z0-9_.-]+(?:\/[@A-Za-z0-9_.-]+)*$/.test(name) &&
    !name.split('/').some((x) => x === '.' || x === '..')
  );
}
export function appOrigin(s) {
  const u = new URL(s);
  if (
    u.protocol !== 'https:' ||
    u.origin !== s ||
    u.username ||
    u.password ||
    !/[a-z]/i.test(u.hostname) ||
    !/^[a-z0-9.-]+$/i.test(u.hostname)
  )
    throw Error('Use the normal HTTPS muxpad hostname, without a path');
  return u.origin;
}
export function makeConfig(origin, ui, team) {
  appOrigin(ui);
  const u = new URL(origin);
  if (
    u.origin !== origin ||
    u.protocol !== 'https:' ||
    !u.hostname.endsWith('.ts.net') ||
    u.hostname === new URL(ui).hostname ||
    !/^T[A-Z0-9]+$/.test(team)
  )
    throw Error('Invalid protected service identity');
  return {
    transport: 'tsnet',
    authMode: 'paired',
    approvalMode: 'passkey-inline',
    autoRead: false,
    channels: [],
    origin,
    originPath: ROOT + '/state/origin',
    socketPath: ROOT + '/state/broker.sock',
    rpID: u.hostname,
    muxpadURL: ui,
    passkeyOrigin: ui,
    passkeyRPID: new URL(ui).hostname,
    passkeyGeneration: randomUUID(),
    bootstrapHash: createHash('sha256').update(randomBytes(32)).digest('base64url'),
    passkeyEnrollmentExpires: 0,
    teamID: team,
    tokenPath: ROOT + '/state/slack-token',
    statePath: ROOT + '/state/state.json',
  };
}
export function requireResume(plan, { release, origin, uid, loaded, processes }) {
  if (!plan || plan.release !== release || plan.origin !== origin || plan.agentUID !== uid)
    throw Error('Different setup transaction; refuse overwrite');
  if (plan.stateMayHaveChanged && (!loaded || !processes))
    throw Error('Started setup requires live read-only reconciliation; refusing restart');
  return plan;
}
export function protectedPath(path, { owner = 0, mode, optional = false } = {}) {
  if (optional && !existsSync(path)) return;
  for (let p = path; ; p = dirname(p)) {
    const s = lstatSync(p);
    if (
      s.isSymbolicLink() ||
      (!s.isFile() && !s.isDirectory()) ||
      s.mode & 0o022 ||
      (s.isFile() && s.nlink !== 1) ||
      (s.uid !== 0 && s.uid !== owner)
    )
      throw Error('Unprotected setup path');
    if (p === path && mode !== undefined && (s.mode & 0o777) !== mode)
      throw Error('Unexpected setup permissions');
    const acl = execFileSync('/bin/ls', ['-lde', p], { encoding: 'utf8', env });
    if (/^\s*\d+:/m.test(acl)) throw Error('ACL on setup path');
    if (p === '/') break;
  }
}
const cmd = (bin, args, options = {}) =>
  execFileSync(bin, args, { encoding: 'utf8', env, timeout: 15000, ...options });
function atomic(path, bytes, mode = 0o600, uid = 0) {
  const temp = path + '.next-' + randomUUID();
  const fd = openSync(temp, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chownSync(temp, uid, 20);
  chmodSync(temp, mode);
  renameSync(temp, path);
  const d = openSync(dirname(path), 'r');
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
}
function line(prompt, max = 4096, hidden = false) {
  const fd = openSync('/dev/tty', 'r+');
  let out = '';
  try {
    if (hidden) cmd('/bin/stty', ['-echo'], { stdio: [fd, 'ignore', 'ignore'] });
    writeSync(fd, prompt);
    const b = Buffer.alloc(1);
    while (Buffer.byteLength(out) <= max) {
      if (readSync(fd, b, 0, 1, null) !== 1) throw Error('Terminal input ended');
      if (b[0] === 10) return out.trim();
      out += b.toString('utf8');
    }
    throw Error('Input too long');
  } finally {
    if (hidden) {
      cmd('/bin/stty', ['echo'], { stdio: [fd, 'ignore', 'ignore'] });
      writeSync(fd, '\n');
    }
    closeSync(fd);
  }
}
export function missingServiceError(error) {
  return (
    [3, 113].includes(error?.status) &&
    !error?.signal &&
    error?.code !== 'ETIMEDOUT' &&
    /Could not find service "org\.muxpad\.broker" in domain for system/.test(
      String(error?.stderr || ''),
    )
  );
}
function loaded() {
  try {
    cmd('/bin/launchctl', ['print', JOB]);
    return true;
  } catch (error) {
    if (missingServiceError(error)) return false;
    throw Error('Service job status is unknown; refusing shutdown/restart');
  }
}
function processes(uid) {
  try {
    return !!cmd('/usr/bin/pgrep', ['-u', String(uid)]).trim();
  } catch (e) {
    if (e.status === 1) return false;
    throw Error('Cannot verify broker processes');
  }
}
async function stop(uid) {
  if (loaded()) cmd('/bin/launchctl', ['bootout', JOB]);
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    if (!loaded() && !processes(uid)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('Broker still loaded; no code or credential writes performed');
}
async function slackIdentity(token) {
  if (!token.startsWith('xoxp-')) throw Error('Use a Slack user OAuth token');
  const r = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  let b;
  try {
    b = await r.json();
  } catch {
    throw Error('Slack token check failed');
  }
  if (!r.ok || !b.ok || !/^T[A-Z0-9]+$/.test(b.team_id))
    throw Error('Slack token check failed; check the user token in Slack');
  return b.team_id;
}
function privateRPC(method, path, body) {
  if (
    ![
      ['GET', '/status'],
      ['POST', '/begin-enrollment'],
      ['POST', '/confirm-enrollment'],
    ].some((x) => x[0] === method && x[1] === path)
  )
    throw Error('Unknown private operation');
  const args = [
    '-q',
    '--silent',
    '--show-error',
    '--fail',
    '--max-time',
    '5',
    '--unix-socket',
    ROOT + '/state/passkey-admin.sock',
    '-X',
    method,
  ];
  if (body) args.push('-H', 'content-type: application/json', '--data-binary', '@-');
  args.push('http://localhost' + path);
  const raw = cmd('/usr/bin/curl', args, {
    input: body ? JSON.stringify(body) : undefined,
    maxBuffer: 16384,
  });
  return JSON.parse(raw);
}
async function health(origin) {
  const r = await fetch(origin + '/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw Error('Service not responding');
  return r.json();
}
function installTree(from, to) {
  const st = lstatSync(from);
  if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink !== 1))
    throw Error('Unsafe release input');
  if (st.isDirectory()) {
    if (!existsSync(to)) mkdirSync(to, { mode: 0o755 });
    chmodSync(to, 0o755);
    protectedPath(to);
    for (const n of readdirSync(from)) installTree(join(from, n), join(to, n));
  } else {
    copyFileSync(from, to);
    chownSync(to, 0, 0);
    chmodSync(to, 0o644);
  }
}
export async function run(source, ui, agent, action = 'install') {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.getuid?.() !== 0)
    throw Error('Run the reviewed Apple Silicon Mac command in an administrator Terminal');
  appOrigin(ui);
  if (!['install', 'enroll', 'connect'].includes(action)) throw Error('Unknown setup action');
  protectedPath(source);
  protectedPath(source + '/MANIFEST.json');
  // The verified stage is inside a root-private cache: no ordinary UID can traverse it.
  protectedPath(dirname(source), { mode: 0o700 });
  const manifest = JSON.parse(readFileSync(source + '/MANIFEST.json', 'utf8'));
  for (const row of manifest) {
    if (!releasePath(row.file)) throw Error('Unsafe release manifest');
    const p = source + '/' + row.file;
    const staged = lstatSync(p);
    if (
      !staged.isFile() ||
      staged.isSymbolicLink() ||
      staged.uid !== 0 ||
      staged.nlink !== 1 ||
      staged.mode & 0o022
    )
      throw Error('Unsafe staged file');
    if (hash(readFileSync(p)) !== row.sha256) throw Error('Frozen release changed');
  }
  const release = hash(readFileSync(source + '/MANIFEST.json')),
    agentUID = Number(cmd('/usr/bin/id', ['-u', agent]).trim());
  if (!agentUID || !Number.isInteger(agentUID))
    throw Error('Use the actual unprivileged muxpad Mac account');
  const account = '_muxbroker';
  let uid;
  try {
    uid = Number(cmd('/usr/bin/id', ['-u', account]).trim());
  } catch {}
  const fresh = !existsSync(ROOT);
  if (fresh) {
    if (action !== 'install' || uid || existsSync(PLIST))
      throw Error('Existing account/service requires administrative reconciliation');
    uid = 450;
    while (true) {
      try {
        if (!cmd('/usr/bin/dscl', ['.', '-search', '/Users', 'UniqueID', String(uid)]).trim())
          break;
      } catch {
        throw Error('Cannot select broker account');
      }
      uid++;
    }
    cmd('/usr/bin/dscl', ['.', '-create', '/Users/' + account]);
    for (const [k, v] of Object.entries({
      UniqueID: String(uid),
      PrimaryGroupID: '20',
      UserShell: '/usr/bin/false',
      NFSHomeDirectory: '/var/empty',
      IsHidden: '1',
      Password: '*',
    }))
      cmd('/usr/bin/dscl', ['.', '-create', '/Users/' + account, k, v]);
    mkdirSync(ROOT, { mode: 0o755 });
    chmodSync(ROOT, 0o755);
    mkdirSync(ROOT + '/setup-admin', { mode: 0o700 });
    mkdirSync(ROOT + '/state', { mode: 0o700 });
    chownSync(ROOT + '/state', uid, 20);
    atomic(
      ROOT + '/setup-admin/plan.json',
      JSON.stringify({ release, origin: ui, agentUID, stateMayHaveChanged: false }) + '\n',
    );
  }
  protectedPath(ROOT);
  protectedPath(ROOT + '/setup-admin', { mode: 0o700, optional: action !== 'install' });
  if (!uid || uid === agentUID) throw Error('Separate protected broker account required');
  if (action !== 'install')
    maintenanceHistory(
      ROOT + '/member-update-history',
      ROOT + '/member-update-active.json',
      protectedPath,
    );
  const planPath = ROOT + '/setup-admin/plan.json',
    fault = ROOT + '/setup-admin/storage-uncertain';
  if (existsSync(fault))
    throw Error('Observed storage uncertainty requires administrative reconciliation; no restart');
  let plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : null;
  let config = existsSync(ROOT + '/config.json')
    ? JSON.parse(readFileSync(ROOT + '/config.json', 'utf8'))
    : null;
  if (action === 'install') {
    plan = requireResume(plan, {
      release,
      origin: ui,
      uid: agentUID,
      loaded: loaded(),
      processes: processes(uid),
    });
    if (!plan.stateMayHaveChanged) {
      if (loaded() || processes(uid)) throw Error('Existing broker process; refuse overwrite');
      installTree(source + '/code', ROOT + '/code');
      installTree(source + '/runtime', ROOT + '/runtime');
      copyFileSync(source + '/muxpad-tsnet', ROOT + '/muxpad-tsnet');
      chownSync(ROOT + '/muxpad-tsnet', 0, 0);
      chmodSync(ROOT + '/muxpad-tsnet', 0o755);
      chmodSync(ROOT + '/runtime/node', 0o755);
      // Official binaries must link only protected system libraries.
      for (const binary of [ROOT + '/muxpad-tsnet', ROOT + '/runtime/node']) {
        const libs = cmd('/usr/bin/otool', ['-L', binary])
          .split('\n')
          .slice(1)
          .map((x) => x.trim().split(' ')[0])
          .filter(Boolean);
        if (libs.some((x) => !x.startsWith('/usr/lib/') && !x.startsWith('/System/')))
          throw Error('Non-system runtime dependency refused');
      }
      console.log(
        'Authorize the independent Slack service on Tailscale using the URL below. This does not log out your Mac.',
      );
      cmd(
        '/usr/bin/sudo',
        [
          '-u',
          account,
          '--',
          '/usr/bin/env',
          '-i',
          'PATH=' + env.PATH,
          'HOME=/var/empty',
          ROOT + '/muxpad-tsnet',
          '--enroll-only',
        ],
        { timeout: 0, stdio: 'inherit' },
      );
      protectedPath(ROOT + '/state/origin', { owner: uid, mode: 0o600 });
      const origin = readFileSync(ROOT + '/state/origin', 'utf8').trim();
      let token;
      if (existsSync(ROOT + '/state/slack-token')) {
        protectedPath(ROOT + '/state/slack-token', { owner: uid, mode: 0o600 });
        token = readFileSync(ROOT + '/state/slack-token', 'utf8').trim();
      } else
        token = line(
          'Paste Slack USER OAuth token (hidden; never paste in muxpad/chat): ',
          4096,
          true,
        );
      const team = await slackIdentity(token);
      atomic(ROOT + '/state/slack-token', token, 0o600, uid);
      token = '';
      config = config || makeConfig(origin, ui, team);
      if (config.teamID !== team || config.passkeyOrigin !== ui || config.origin !== origin)
        throw Error('Setup identity changed');
      atomic(ROOT + '/config.json', JSON.stringify(config, null, 2) + '\n', 0o644);
      if (!existsSync(ROOT + '/state/state.json'))
        atomic(ROOT + '/state/state.json', '{}\n', 0o600, uid);
      const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>org.muxpad.broker</string><key>UserName</key><string>_muxbroker</string><key>ProgramArguments</key><array><string>/Library/muxpad-broker/muxpad-tsnet</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>/Library/muxpad-broker/state/broker.log</string><key>StandardErrorPath</key><string>/Library/muxpad-broker/state/broker.err</string></dict></plist>\n`;
      atomic(PLIST, plist, 0o644);
      for (const f of [ROOT + '/state/slack-token', ROOT + '/state/state.json']) {
        try {
          cmd('/usr/bin/sudo', ['-u', agent, '--', '/bin/test', '-r', f]);
          throw Error('Muxpad account can read protected state');
        } catch (e) {
          if (e.status !== 1) throw e;
        }
      }
      for (const f of [
        ROOT,
        ROOT + '/code',
        ROOT + '/runtime/node',
        ROOT + '/muxpad-tsnet',
        ROOT + '/config.json',
      ]) {
        try {
          cmd('/usr/bin/sudo', ['-u', agent, '--', '/bin/test', '-w', f]);
          throw Error('Muxpad account can modify protected files');
        } catch (e) {
          if (e.status !== 1) throw e;
        }
      }
      atomic(planPath, JSON.stringify({ ...plan, stateMayHaveChanged: true }) + '\n');
      cmd('/bin/launchctl', ['bootstrap', 'system', PLIST]);
    }
  }
  if (!config) throw Error('Install the protected service first');
  protectedPath(ROOT + '/config.json');
  if (
    config.tokenPath !== ROOT + '/state/slack-token' ||
    config.statePath !== ROOT + '/state/state.json'
  )
    throw Error('Unexpected protected credential paths');
  if (
    config.approvalMode !== 'passkey-inline' ||
    config.authMode !== 'paired' ||
    config.passkeyOrigin !== ui
  )
    throw Error('Existing service needs a compatible reviewed update, not a new installation');
  if (action === 'connect') {
    if (!existsSync(ROOT + '/setup-admin')) mkdirSync(ROOT + '/setup-admin', { mode: 0o700 });
    const tx = ROOT + '/setup-admin/reconnect.json';
    const readState = () => {
      protectedPath(ROOT + '/state/state.json', { owner: uid, mode: 0o600 });
      const state = JSON.parse(readFileSync(ROOT + '/state/state.json', 'utf8'));
      const c = state.inlinePasskey;
      if (!c) return { unregistered: true };
      if (c.revoked)
        throw Error('Existing passkey is revoked; use explicit administrator recovery');
      return { id: c.id, publicKey: c.publicKey, generation: c.generation, counter: c.counter };
    };
    const sameKey = (want) => {
      const now = readState();
      if (want.unregistered) {
        if (!now.unregistered) throw Error('Passkey changed during connection repair');
        return;
      }
      if (
        now.unregistered ||
        now.id !== want.id ||
        now.publicKey !== want.publicKey ||
        now.generation !== want.generation ||
        now.counter < want.counter
      )
        throw Error('Existing passkey changed; refuse restart');
    };
    const checkFault = () => {
      if (existsSync(fault)) throw Error('Observed storage uncertainty; no restart');
    };
    // If live, observe and latch faults before any shutdown. A stopped revoked-token
    // service has no admin endpoint; protected config/code/state are checked instead.
    let observed;
    try {
      observed = privateRPC('GET', '/status');
    } catch {
      if (loaded() || processes(uid))
        throw Error(
          'Existing live service status is unavailable. Refusing shutdown; administrator must reconcile the failed service first.',
        );
    }
    if (observed?.storageFault) {
      atomic(fault, 'Observed storage uncertainty\n');
      throw Error('Observed storage uncertainty; no restart');
    }
    checkFault();
    for (const p of [
      ROOT + '/runtime/node',
      ROOT + '/muxpad-tsnet',
      ROOT + '/code/main.mjs',
      ROOT + '/code/passkey-approval.mjs',
    ])
      protectedPath(p);
    cmd('/usr/bin/sudo', [
      '-u',
      account,
      '--',
      '/usr/bin/env',
      '-i',
      'PATH=' + env.PATH,
      'HOME=/var/empty',
      ROOT + '/runtime/node',
      ROOT + '/code/main.mjs',
      ROOT + '/config.json',
      '--check',
    ]);
    await reconnect({
      load: async () => {
        protectedPath(tx, { optional: true });
        if (!existsSync(tx)) return null;
        const p = JSON.parse(readFileSync(tx, 'utf8'));
        if (p.phase === 'ready') {
          const answer = line(
            'Previous connection repair completed. Press Return to verify it, or type REPLACE TOKEN for a different replacement: ',
            40,
          );
          const chosen = selectReconnect(p, answer);
          if (!chosen) {
            atomic(tx + '.completed-' + p.id, JSON.stringify(p) + '\n');
            return null;
          }
        }
        return p;
      },
      prepare: async () => {
        checkFault();
        let token = line('Paste replacement Slack USER OAuth token (hidden): ', 4096, true);
        const team = await slackIdentity(token);
        if (team !== config.teamID) throw Error('Different Slack workspace; no credential changed');
        const id = randomUUID(),
          secretPath = ROOT + '/setup-admin/reconnect-token-' + id;
        atomic(secretPath, token);
        const p = {
          version: 1,
          id,
          release,
          origin: ui,
          teamID: team,
          agentUID,
          secretPath,
          targetHash: hash(Buffer.from(token)),
          oldHash: hash(readFileSync(ROOT + '/state/slack-token')),
          phase: 'prepared',
          stateMayHaveChanged: false,
        };
        token = '';
        atomic(tx, JSON.stringify(p) + '\n');
        return p;
      },
      validate: async (p) => {
        checkFault();
        if (
          p.version !== 1 ||
          p.release !== release ||
          p.origin !== ui ||
          p.agentUID !== agentUID ||
          p.teamID !== config.teamID ||
          !/^[-a-f0-9]{36}$/.test(p.id) ||
          p.secretPath !== ROOT + '/setup-admin/reconnect-token-' + p.id ||
          !['prepared', 'stopped', 'installed', 'starting', 'ready'].includes(p.phase) ||
          (p.phase !== 'prepared' && p.stateMayHaveChanged !== true)
        )
          throw Error('Different connection repair transaction');
        if (!['installed', 'starting', 'ready'].includes(p.phase)) {
          protectedPath(p.secretPath, { mode: 0o600 });
          if (hash(readFileSync(p.secretPath)) !== p.targetHash)
            throw Error('Frozen replacement credential changed');
        }
      },
      save: async (p) => atomic(tx, JSON.stringify(p) + '\n'),
      disable: async () => cmd('/bin/launchctl', ['disable', JOB]),
      stop: async () => stop(uid),
      captureCredential: async () => readState(),
      requireStopped: async () => {
        checkFault();
        if (loaded() || processes(uid)) throw Error('Broker still loaded; no credential write');
      },
      install: async (p) => {
        sameKey(p.credential);
        protectedPath(ROOT + '/state/slack-token', { owner: uid, mode: 0o600 });
        const current = hash(readFileSync(ROOT + '/state/slack-token'));
        if (![p.oldHash, p.targetHash].includes(current))
          throw Error('Credential changed outside this transaction');
        protectedPath(p.secretPath, { mode: 0o600 });
        const secret = readFileSync(p.secretPath);
        if (hash(secret) !== p.targetHash) throw Error('Frozen replacement changed');
        atomic(ROOT + '/state/slack-token', secret, 0o600, uid);
      },
      verifyInstalled: async (p) => {
        checkFault();
        sameKey(p.credential);
        if (hash(readFileSync(ROOT + '/state/slack-token')) !== p.targetHash)
          throw Error('Installed replacement credential mismatch');
      },
      running: async () => ({ loaded: loaded(), processes: processes(uid) }),
      enable: async () => cmd('/bin/launchctl', ['enable', JOB]),
      start: async () => cmd('/bin/launchctl', ['bootstrap', 'system', PLIST]),
      ready: async (p) => {
        const until = Date.now() + 45000;
        while (Date.now() < until) {
          try {
            const h = await health(config.origin);
            if (typeof h.version !== 'string' || !h.version.startsWith('inchat-'))
              throw Error('Unexpected service');
            const status = privateRPC('GET', '/status');
            if (status.storageFault) {
              atomic(fault, 'Observed storage uncertainty\n');
              throw Error('Observed storage uncertainty; no restart');
            }
            checkFault();
            sameKey(p.credential);
            if (
              !p.credential.unregistered &&
              (!status.registered ||
                status.credentialID !== p.credential.id ||
                status.generation !== p.credential.generation)
            )
              throw Error('Existing passkey not confirmed');
            return;
          } catch {
            checkFault();
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        throw Error('Service readiness unconfirmed; resume same command without deleting state');
      },
      forgetSecret: async (p) => {
        if (existsSync(p.secretPath)) {
          protectedPath(p.secretPath, { mode: 0o600 });
          cmd('/bin/rm', [p.secretPath]);
        }
      },
    });
    console.log(
      'Slack connection restored; existing passkey retained. Return to Settings and run Test Slack.',
    );
    return;
  }
  // No silent restarts after first start; reconcile the running process only.
  const until = Date.now() + 45000;
  let live = false,
    privateState;
  while (Date.now() < until) {
    try {
      const h = await health(config.origin);
      if (h.version === 'inchat-slack-capabilities-v2-2026-10-20') {
        privateState = privateRPC('GET', '/status');
        live = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!live)
    throw Error(
      'Service readiness unconfirmed. Stop and use Check setup in muxpad; no automatic restart',
    );
  if (privateState?.storageFault) {
    if (!existsSync(ROOT + '/setup-admin')) mkdirSync(ROOT + '/setup-admin', { mode: 0o700 });
    atomic(fault, 'Observed storage uncertainty\n');
    throw Error('Observed storage uncertainty; no restart');
  }
  atomic(
    ROOT + '/setup-public.json',
    JSON.stringify({ version: 1, brokerURL: config.origin, appOrigin: ui }) + '\n',
    0o644,
  );
  const status = privateRPC('GET', '/status');
  if (status.storageFault) {
    if (!existsSync(ROOT + '/setup-admin')) mkdirSync(ROOT + '/setup-admin', { mode: 0o700 });
    atomic(fault, 'Observed storage uncertainty\n');
    throw Error('Storage uncertainty; no retry/restart');
  }
  if (status.registered && action !== 'install') {
    console.log(
      'Existing passkey is active and was not replaced. Return to Settings and run Test Slack.',
    );
    return;
  }
  if (!existsSync(ROOT + '/setup-admin')) mkdirSync(ROOT + '/setup-admin', { mode: 0o700 });
  await completeSetup({
    tx: ROOT + '/setup-admin',
    mode: config,
    transport: async (...args) => {
      const s = privateRPC(...args);
      if (s.storageFault) {
        atomic(fault, 'Observed storage uncertainty\n');
        throw Error('Storage uncertainty');
      }
      return s;
    },
    progress: console.log,
    validate: (p, o) => protectedPath(p, o),
    atomic,
  });
  console.log('Setup complete. Return to Settings → Integrations → Slack and run Test Slack.');
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  run(
    dirname(dirname(fileURLToPath(import.meta.url))),
    process.argv[2],
    process.argv[3],
    process.argv[4],
  ).catch((error) => {
    console.error(
      error instanceof Error &&
        /^(Use |Invalid protected |Different setup |Started setup |Existing |Separate |Service readiness|Observed storage|Slack token check|Different Slack workspace)/.test(
          error.message,
        )
        ? error.message
        : 'Setup step failed; no secret details displayed.',
    );
    console.error(
      'Slack setup did not complete. Keep this Terminal open; use Check setup in muxpad. Do not delete service state or retry a Slack send.',
    );
    process.exitCode = 1;
  });
