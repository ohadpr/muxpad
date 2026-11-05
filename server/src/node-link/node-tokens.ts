import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nodeTokenPath } from './NodeLinks.js';

/**
 * THE CREDENTIAL FOR ONE MACHINE, minted here and written to disk.
 *
 * ── THE ORDER IS THE SECURITY PROPERTY ───────────────────────────────────
 * This machine issues the token and the other machine is installed WITH it.
 * The alternative — install the agent first, then paste an endpoint — leaves
 * an unauthenticated listener sitting on a shared tailnet for however long
 * that takes, and the tailnet this was built for has other people's dev VMs
 * and an admin who is not the user on it.
 *
 * ── 64 HEX CHARACTERS, NOT A PASSPHRASE ──────────────────────────────────
 * 32 bytes of CSPRNG. It is compared in constant time by the agent
 * (`tokenMatches`) and never logged by either side. `readNodeTokenFor` treats
 * anything shorter than 32 chars as ABSENT rather than as a credential, so a
 * truncated write fails closed — which is why the file is written in one call
 * rather than streamed.
 */
export const NODE_TOKEN_BYTES = 32;

/** A fresh token. Exported for tests that need one without touching disk. */
export function mintNodeToken(): string {
  return randomBytes(NODE_TOKEN_BYTES).toString('hex');
}

/**
 * Mint a token for `nodeId` and store it where the links will read it.
 *
 * 0600 and 0700 on the directory: this file is the whole of a remote
 * machine's authentication, and the data dir is not otherwise private.
 * Returns the token so the caller can show it ONCE — it has to be typed on
 * the other machine, and that is the only moment anyone needs to see it.
 */
export function writeNodeToken(nodeId: string, dataDir?: string): string {
  const token = mintNodeToken();
  const path = nodeTokenPath(nodeId, dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * Forget a machine's token.
 *
 * Best-effort: a node being removed must not fail because its credential was
 * already gone by hand. REVOCATION IS NOT CLOSURE, and this is worth being
 * honest about — deleting the file stops the next dial from authenticating,
 * and an already-open link keeps working until it drops. The caller closes the
 * link; this only removes the means to make a new one.
 */
export function removeNodeToken(nodeId: string, dataDir?: string): void {
  rmSync(nodeTokenPath(nodeId, dataDir), { force: true });
}
