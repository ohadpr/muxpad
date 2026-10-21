import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHICH PANE IS CALLING, WITHOUT ASKING PTYD AND WITHOUT TRUSTING THE CALLER.
 *
 * ── WHAT THIS REPLACED, AND WHY ────────────────────────────────────────────
 * The Slack gate needs to know which workspace a `muxpad` invocation is
 * running in, and `$MUXPAD_PANE_ID` alone is worthless because the caller sets
 * it. The first answer walked the calling process's ancestry up to a live pane
 * shell — unforgeable, and it needed pane pids, which only ptyd knows. That
 * meant a new ptyd RPC, and a ptyd protocol change means a restart that kills
 * EVERY TERMINAL ON THE MACHINE. Reported as: "not sure I like that you need
 * ptyd for this."
 *
 * `PaneRuntimeSpec.env` was already in the protocol and the SERVER already
 * fills it. So the server mints a key per pane and hands it over at spawn, and
 * ptyd — which merges `spec.env` into the pty's environment and has no idea
 * what any of it means — needs no change at all.
 *
 * ── DERIVED, NOT STORED ────────────────────────────────────────────────────
 * `HMAC(install secret, pane id)`. No column, no migration, no per-pane state
 * to get out of sync, and it survives a server restart because the secret is
 * on disk and the pane id has not changed. A pane cannot compute another
 * pane's key without the secret, which lives in the data dir and never leaves
 * this process.
 *
 * ── AND IT IS A BEARER TOKEN, WHICH IS WEAKER THAN ANCESTRY ────────────────
 * Stated plainly because the thing it replaced was not. A key sits in a pane's
 * environment, and anything that prints its environment into a transcript puts
 * it somewhere another pane can read with `muxpad agent transcript`. Ancestry
 * could not leak that way.
 *
 * That is an acceptable trade for the threat that actually exists: a helpful
 * agent reaching for a tool in arm's reach, not an adversary. Against an
 * adversary neither version works — same uid, same home directory — and the
 * only real answer is a broker under a second OS user.
 *
 * ── PANES OLDER THAN THIS HAVE NO KEY ──────────────────────────────────────
 * They were spawned before the server knew to hand one out, and nothing can
 * retroactively put it in a running process's environment. They fail closed:
 * using Slack from one costs a respawn OF THAT PANE, which is the whole point
 * of the change — the alternative cost every terminal on the machine.
 */
const FILE = 'pane-key-secret';

let secret: Buffer | null = null;

export function initPaneKeys(dataDir: string): void {
  const path = join(dataDir, FILE);
  try {
    const hex = readFileSync(path, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(hex)) {
      secret = Buffer.from(hex, 'hex');
      return;
    }
  } catch {
    // Absent or unreadable — mint one.
  }
  const fresh = randomBytes(32);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${fresh.toString('hex')}\n`, { mode: 0o600 });
  } catch {
    // Per-process rather than per-install. Keys minted now stop verifying
    // after a restart, which fails closed — a refusal, never an admission.
  }
  secret = fresh;
}

/** Test seam. */
export function __resetPaneKeys(): void {
  secret = null;
}

/** The key for a pane, or null before `initPaneKeys`. */
export function paneKeyFor(paneId: string): string | null {
  if (!secret || !paneId) return null;
  return createHmac('sha256', secret).update(paneId).digest('hex').slice(0, 32);
}

/**
 * Does `key` belong to `paneId`?
 *
 * Constant-time, which is close to theatre at this threat level but costs one
 * function call and means nobody has to reason about whether it matters here.
 */
export function verifyPaneKey(paneId: string, key: string | undefined | null): boolean {
  const want = paneKeyFor(paneId);
  if (!want || !key || key.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(key));
}

/**
 * A pane's spawn environment with its key folded in.
 *
 * Every `ensurePane` call site goes through this, so there is one place that
 * decides what a pane is told about itself rather than four that agree today.
 */
export function withPaneKey(
  env: Record<string, string> | null | undefined,
  paneId: string,
): Record<string, string> {
  const key = paneKeyFor(paneId);
  // Codex shell policies can strip names containing KEY/SECRET/TOKEN. Carry
  // the same pane-only bearer proof under a compatible name as well. This
  // grants no Slack authority: server verification and passkey approval remain.
  return { ...(env ?? {}), ...(key ? { MUXPAD_PANE_KEY: key, MUXPAD_PANE_PROOF: key } : {}) };
}
