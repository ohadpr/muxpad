import { readFileSync } from 'node:fs';
import { createServer as createHTTPServer } from 'node:http';
import { createServer } from 'node:https';
import { Broker } from './core.mjs';
import { handler } from './http.mjs';
import { HumanSessions, validateHumanConfig } from './human-session.mjs';
import { readNodePolicy } from './node-policy.mjs';
import { NodeSessions } from './node-session.mjs';
import { listenPasskeyAdmin } from './passkey-admin-socket.mjs';
import { inlineMode } from './passkey-approval.mjs';
import { passkeyAdminHandler } from './passkey-http.mjs';
import { BROKER_ROOT, brokerPath } from './broker-paths.mjs';
import { assertProtectedPath } from './protected-path.mjs';
import { msgvaultRunner } from './msgvault-runner.mjs';
import { slackClient } from './slack.mjs';
import { listenPrivateSocket } from './socket-listener.mjs';
import { saveState } from './state-store.mjs';

// On macOS libuv 1.52+ uses mach_continuous_time for hrtime, including sleep.
// Refuse runtimes where timed authorization could pause during suspension.
const [uvMajor, uvMinor] = process.versions.uv.split('.').map(Number);
// macOS and Linux. The libuv floor is the load-bearing half of this check and
// it is NOT platform trivia: 1.52 is where the timer clock stops pausing while
// the machine is suspended, and an approval window that pauses with the lid is
// an approval that outlives the moment the human was shown. The platform half
// is now just "is there a protected tree here" — see broker-paths.mjs.
if (!BROKER_ROOT || uvMajor < 1 || (uvMajor === 1 && uvMinor < 52))
  throw new Error(
    `Broker requires macOS or Linux and libuv 1.52+ for suspend-inclusive expiry (have ${process.platform}, libuv ${process.versions.uv})`,
  );

if (process.getuid?.() === 0) throw new Error('Run as the dedicated unprivileged broker user');
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node main.mjs /protected/config.json');
assertProtectedPath(configPath, [0]);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.transport === 'tsnet') {
  if (
    config.originPath !== brokerPath('state', 'origin') ||
    config.socketPath !== brokerPath('state', 'broker.sock')
  )
    throw Error('Invalid protected transport paths');
  assertProtectedPath(config.originPath, [0, process.getuid()], { mode: 0o600 });
  config.origin = readFileSync(config.originPath, 'utf8').trim();
  config.rpID = new URL(config.origin).hostname;
  if (!config.rpID.endsWith('.ts.net')) throw Error('Invalid assigned Tailscale origin');
}

const origin = new URL(config.origin);
if (
  origin.protocol !== 'https:' ||
  origin.hostname !== config.rpID ||
  origin.origin !== config.origin ||
  !config.teamID ||
  !config.bootstrapHash
)
  throw new Error('Invalid protected configuration');
validateHumanConfig(config);
if (config.authMode === 'tailnet-peer') readNodePolicy();
const protectedRead = (path) => {
  assertProtectedPath(path, [0, process.getuid()], { mode: 0o600 });
  return readFileSync(path, 'utf8');
};
const state = JSON.parse(protectedRead(config.statePath));
const token = protectedRead(config.tokenPath).trim();
if (!token.startsWith('xoxp-')) throw new Error('Use a Slack user OAuth token');
// Validate complete module/config/private-file access as the broker UID without Slack calls.
if (process.argv[3] === '--check') process.exit(0);
const slack = slackClient(token, config.teamID, config.channels);
await slack.verify();
const save = (next) => saveState(config.statePath, next);

const sessions =
  config.authMode === 'tailnet-peer'
    ? new NodeSessions({ config, state, save })
    : new HumanSessions({ config, state, save });
const broker = new Broker({
  config,
  state,
  save,
  ...(config.authMode === 'tailnet-peer'
    ? {
        sessionLive: (s) => sessions.isLive(s),
        ownerAuthorized: (s) => sessions.ownerAuthorized(s),
      }
    : {}),
  slack: (action, payload, upload) => slack.run(action, payload, upload),
  // Built unconditionally and cheap to hold: it reads the declaration per
  // call, so a machine with no archive declared simply refuses at dispatch,
  // and one that gains an archive needs no restart.
  msgvault: msgvaultRunner(),
});
const requestHandler = handler(broker, config.origin, {
  config,
  sessions,
});
if (inlineMode(config)) {
  const admin = createHTTPServer(passkeyAdminHandler(broker));
  admin.requestTimeout = 5000;
  admin.headersTimeout = 4000;
  await listenPasskeyAdmin(admin, brokerPath('state', 'passkey-admin.sock'));
}
const server =
  config.transport === 'tsnet'
    ? createHTTPServer(requestHandler)
    : createServer(
        { key: protectedRead(config.tlsKeyPath), cert: protectedRead(config.tlsCertPath) },
        requestHandler,
      );
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
if (config.transport === 'tsnet') {
  await listenPrivateSocket(server, config.socketPath);
  console.log('Protected broker listening on private Unix socket');
} else
  server.listen(config.port || 9443, '127.0.0.1', () =>
    console.log('Protected broker listening on loopback'),
  );
