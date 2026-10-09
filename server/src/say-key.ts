import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE KEY THAT TELLS AN INVOCATION OF `muxpad say` FROM A MENTION OF IT.
 *
 * The first version of `say` lifted any tool output containing its marker into
 * an assistant message, which means `cat` on a file that mentions the marker,
 * a test run, a fetched page — or `grep -rn muxpad-said .` while working on
 * the feature — all spoke in the agent's voice. Found by an adversarial review
 * reading this repository's own fixtures.
 *
 * NOT A SECRET, and it is worth being clear about that. An agent is allowed to
 * speak; there is no attacker to keep out, and anything running as this user
 * can read this file anyway. It exists so that text which CONTAINS the marker
 * is distinguishable from text that IS one.
 *
 * PER INSTALL AND STABLE, not per boot. A transcript is re-read for months —
 * history paging, search, summaries — so a key that rotated on restart would
 * un-say everything said before it, turning old messages back into raw tool
 * output.
 */
const FILE = 'say-key';

export function readOrCreateSayKey(dataDir: string): string {
  const path = join(dataDir, FILE);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {
    // Absent or unreadable — mint one below.
  }
  const key = randomBytes(16).toString('hex');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${key}\n`, { mode: 0o600 });
  } catch {
    // An unwritable data dir means the key is per-process rather than
    // per-install: `say` still works for this run, and old messages stop
    // being recognised. Better than refusing to boot over a cosmetic file.
  }
  return key;
}
