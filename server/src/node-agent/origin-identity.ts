import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * WHO THIS MACHINE SAYS IT IS, AND THE KEY THAT PROVES IT.
 *
 * One file, `<dataDir>/origin-key`, holding `<origin> <key>`. The origin is
 * the name the host policy uses (`trayo`); the key is the other half of the
 * one the broker holds under /Library/muxpad/origins on the machine that
 * decides.
 *
 * ── WHAT THIS DOES NOT PRETEND ─────────────────────────────────────────────
 * On this host the key is readable by anything running as this user, agents
 * included — exactly as muxpad's own credentials are. That is the right
 * granularity for the question being answered, because the policy is written
 * about MACHINES ("slack: trayo"), not about which process on one. It proves
 * the request was minted here. It is not a claim about who, and nothing
 * downstream should read it as one.
 *
 * Group- or world-readable is refused anyway: on a shared VM with an admin
 * who is not the user, "anything running as this user" and "anybody on the
 * box" are very different sentences.
 */
export interface OriginIdentity {
  origin: string;
  key: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export function readOriginIdentity(
  dataDir = join(homedir(), '.muxpad'),
  io = { readFileSync, statSync },
): OriginIdentity | null {
  const path = join(dataDir, 'origin-key');
  try {
    // 0o077: any group or other permission at all. A key the rest of the box
    // can read proves nothing about this machine that it does not also prove
    // about everyone on it.
    if (io.statSync(path).mode & 0o077) return null;
    const [origin, key] = io.readFileSync(path, 'utf8').trim().split(/\s+/);
    if (!origin || !key) return null;
    if (!NAME.test(origin) || key.length < 32) return null;
    return { origin, key };
  } catch {
    // Absent is the normal state of a host with no key: every connector call
    // from here is approved once, exactly as before this existed.
    return null;
  }
}
