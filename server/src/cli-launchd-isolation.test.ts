import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const MUXPAD_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'muxpad',
);

/**
 * A LAUNCHD JOB BELONGS TO THE DEFAULT INSTALL, AND NOBODY ELSE.
 *
 * `dev.muxpad` / `dev.muxpad.ptyd` are global labels, but an instance is
 * identified by its DATA DIR — so every verb that asked launchctl a question
 * without checking which install it was running as got an answer about the
 * machine's real cockpit. Three of the four verbs then acted on it:
 *
 *   start    "already running (PID …)" — and started nothing
 *   stop     booted out the LIVE job, killing the user's running server
 *   restart  kickstarted the LIVE job
 *   status   printed the live pids under the dev data dir's name
 *
 * That is the entire isolated-dev-instance workflow, which exists so that an
 * agent working on this repo cannot disturb the cockpit it is running inside.
 * It was pointed straight at it.
 *
 * ── WHY A FAKE launchctl ────────────────────────────────────────────────────
 * The bug only appears when a job IS loaded, so a test that merely runs the
 * real `launchctl` proves nothing on a machine without the plists installed —
 * which is every CI runner, i.e. exactly where this would have to be caught.
 * A stub on PATH makes "the job is loaded and running" the premise rather than
 * an accident of the host, and lets both halves of the rule be asserted: the
 * default install still finds its job, an isolated one never looks.
 */
function withFakeLaunchctl(): { env: NodeJS.ProcessEnv; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'muxpad-launchd-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'launchctl');
  // Prints the one line `launchd_pid` parses, for any label, and exits 0 — the
  // shape of a loaded, running job.
  writeFileSync(stub, '#!/bin/sh\necho "\tpid = 4242"\nexit 0\n');
  chmodSync(stub, 0o755);
  return {
    home: root,
    env: {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      // The pane this test may be running inside exports both; they would
      // otherwise leak into the child and pick the socket for it.
      MUXPAD_PTYD_SOCKET: join(root, 'ptyd.sock'),
      MUXPAD_DATA_DIR: '',
    },
  };
}

async function status(env: NodeJS.ProcessEnv, dataDir?: string): Promise<string> {
  const { stdout } = await execFileAsync(MUXPAD_BIN, ['status'], {
    env: { ...env, ...(dataDir === undefined ? {} : { MUXPAD_DATA_DIR: dataDir }) },
  });
  return stdout;
}

describe('scripts/muxpad and the launchd jobs', () => {
  it('asks launchd about the DEFAULT install', async () => {
    const { env } = withFakeLaunchctl();
    const out = await status(env);
    expect(out).toContain('owner: launchd (dev.muxpad');
    expect(out).toContain('4242');
  });

  it('never asks launchd about an isolated instance', async () => {
    // The `stop` that booted out the cockpit went down this same branch, so
    // this assertion is about all four verbs, not about `status`.
    const { env, home } = withFakeLaunchctl();
    const out = await status(env, join(home, 'dev-instance'));
    expect(out).not.toContain('launchd');
    expect(out).not.toContain('4242');
    expect(out).toContain('muxpad: not running');
  });

  it('treats a trailing slash as the same install, not a different one', async () => {
    // MUXPAD_DATA_DIR comes from humans and from shell completion, and
    // `~/.muxpad/` meaning "some other install" would quietly reinstate the
    // whole bug for the one person most likely to type it.
    const { env, home } = withFakeLaunchctl();
    const out = await status(env, `${join(home, '.muxpad')}/`);
    expect(out).toContain('owner: launchd (dev.muxpad');
  });
});
