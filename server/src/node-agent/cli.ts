import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_NODE_PORT, readNodeToken, startNodeAgent } from './index.js';

/**
 * Entry point for muxpad-node.
 *
 * Kept separate from index.ts so the agent stays importable and testable
 * without binding a port — the same split as host/cli.ts and host/run.ts.
 *
 * `--init` mints a token and prints it, for the pairing flow: the operator
 * runs it once on the node, and the printed value is what the control plane is
 * configured with. It REFUSES to overwrite an existing token, because doing so
 * would silently orphan a node the control plane is already paired with — the
 * failure would show up as `unauthorized` with nothing to explain it.
 */
const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const dataDir = flag('data-dir') ?? process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad');

if (args.includes('--init')) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'node-token');
  if (existsSync(path) && readNodeToken(dataDir)) {
    console.error(`muxpad-node: a token already exists at ${path} — refusing to replace it.`);
    console.error('Overwriting would orphan a control plane that is already paired with this');
    console.error('node, and the symptom would be an "unauthorized" row with no explanation.');
    console.error('Delete the file by hand if you really mean to re-pair.');
    process.exit(1);
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(token);
  process.exit(0);
}

const token = readNodeToken(dataDir);
if (!token) {
  console.error(`muxpad-node: no token at ${join(dataDir, 'node-token')}.`);
  console.error('Run `muxpad-node --init` once to mint one, then configure the control plane');
  console.error('with the value it prints. Starting without a token is refused rather than');
  console.error('defaulted: an unauthenticated agent on a shared tailnet is a remote shell.');
  process.exit(1);
}

const port = Number(flag('port') ?? DEFAULT_NODE_PORT);
const host = flag('host') ?? '0.0.0.0';
const ptydSocket = flag('ptyd-socket') ?? undefined;

await startNodeAgent({
  port,
  host,
  token,
  ...(ptydSocket ? { ptydSocket } : {}),
});

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    console.log(`[muxpad-node] ${sig} — exiting`);
    process.exit(0);
  });
