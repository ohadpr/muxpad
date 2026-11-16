import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * A CRON THAT ONLY WAKES AN AGENT WHEN SOMETHING CHANGED.
 *
 * The expensive part of a watcher is not the check, it is the TURN: a
 * three-minute schedule that asks a model to look at a page and say nothing
 * spends a full turn per check, and stays quiet only for as long as the model
 * stays disciplined about its own instructions. Measured on this machine the
 * same evening this was written — ten turns to report nothing.
 *
 * So the check moves to the server, where it is a subprocess and a hash, and
 * the agent is woken only when the answer is different from last time. What
 * the agent then gets is the NEW output, in its prompt, so its first move is
 * not to go and fetch what the server already has.
 */

/** What the server saw this time. */
export interface WatchReading {
  /** stdout+stderr, trimmed and bounded. */
  text: string;
  /** sha256 of the full (untruncated) output, plus the exit status. */
  hash: string;
  /** Non-zero, or the signal/timeout that stopped it. Part of the reading:
   *  a command that starts failing has CHANGED, and that is news. */
  status: string;
}

/** How long a check may take before it counts as a (changed) failure. */
export const WATCH_TIMEOUT_MS = 30_000;
/** How much of the output rides into the prompt. The rest is the agent's to
 *  fetch if it cares — a watcher on a 5MB log must not post 5MB. */
export const WATCH_TEXT_MAX = 4_000;

export function hashReading(output: string, status: string): string {
  return createHash('sha256').update(`${status}\u0000${output}`).digest('hex');
}

/**
 * Keep the END of a long reading: a log's news is at the bottom.
 *
 * The RESULT is bounded, not the slice — a notice added on top of a full-size
 * slice makes the "bounded" text longer than the input, which is how a cap
 * ends up not being one. (The same bug was found and fixed in the Slack
 * notice path; it is easy to write twice.)
 */
export function boundText(text: string, max = WATCH_TEXT_MAX): string {
  const t = text.trim();
  if (t.length <= max) return t;
  // Reserve room for the notice, then measure it exactly: its own length
  // depends on the number it carries, so it is built twice.
  const note = (n: number) => `…[${n} earlier characters omitted]\n`;
  const keep = Math.max(0, max - note(t.length).length);
  return `${note(t.length - keep)}${t.slice(-keep)}`.slice(-max);
}

/**
 * Run one check. Never throws: every failure IS a reading, because a watcher
 * that goes quiet when its command breaks is worse than one that cries wolf.
 */
export function runWatch(
  command: string,
  opts: { cwd?: string | null; timeoutMs?: number } = {},
): Promise<WatchReading> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        timeout: opts.timeoutMs ?? WATCH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`;
        const status = !err
          ? 'ok'
          : err.killed
            ? `timeout after ${opts.timeoutMs ?? WATCH_TIMEOUT_MS}ms`
            : `exit ${err.code ?? 'unknown'}`;
        resolve({ text: boundText(out), hash: hashReading(out, status), status });
      },
    );
  });
}

/**
 * The prompt the agent actually receives.
 *
 * It leads with the reading, because the agent's first instinct otherwise is
 * to go and fetch what the server already has — and on a schedule that is a
 * second round trip per fire, forever.
 */
export function withWatchReading(prompt: string, watched: WatchReading | null): string {
  if (!watched) return prompt;
  return [
    `A watch you are scheduled on CHANGED. Its command exited: ${watched.status}.`,
    'This is the new output, already fetched — do not run the command again unless you need more than it shows:',
    '',
    watched.text || '(no output)',
    '',
    prompt,
  ].join('\n');
}
