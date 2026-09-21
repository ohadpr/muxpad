// `muxpad agent --help` MUST NOT START A SESSION.
//
// This is the upstream half of the stranded-conversation bug (see
// agent-resume-repair.ts). The runner's argv parser only looks for the flags it
// knows, so an unrecognised `--help` used to fall straight through to "no
// --resume, no --backend" — a brand-new Claude session minted inside a pane
// that already had one. It hellos, the server's self-heal rewrite re-points
// `current_sid` and `startup_cmd` at it, and the real conversation is stranded
// under an id nothing points at any more. Asking a subcommand for its usage is
// not a destructive act and must not be one here.
//
// Driven against the BUILT runner, spawned the way the `muxpad` script spawns
// it. Deliberately with NO pane env: the guard has to answer before the
// "must run inside a muxpad pane" check, and that check is exactly what this
// asserts we no longer hit.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const RUNNER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'agent-runner',
  'index.js',
);

/** A stale/absent dist would test the OLD binary, which is worse than nothing. */
const built = existsSync(RUNNER);

describe('the runner harness argv guard', () => {
  it.skipIf(!built)('answers --help with usage instead of a session', async () => {
    const env = { ...process.env };
    // biome-ignore lint/performance/noDelete: proving the guard runs before the pane check
    delete env.MUXPAD_PANE_ID;
    // biome-ignore lint/performance/noDelete: same
    delete env.MUXPAD_API_URL;
    const { stdout } = await execFileAsync(process.execPath, [RUNNER, '--help'], {
      env,
      timeout: 15_000,
    });
    expect(stdout).toContain('usage: muxpad agent');
    expect(stdout).toContain('--resume');
    // The flag the drift dropped, named where someone will see it.
    expect(stdout).toContain('--backend');
  });

  it.skipIf(!built)('takes -h too', async () => {
    const { stdout } = await execFileAsync(process.execPath, [RUNNER, '-h'], { timeout: 15_000 });
    expect(stdout).toContain('usage: muxpad agent');
  });

  it.skipIf(!built)('still refuses to run outside a pane', async () => {
    // The guard must not have swallowed the real precondition.
    const env = { ...process.env };
    // biome-ignore lint/performance/noDelete: the point of the assertion
    delete env.MUXPAD_PANE_ID;
    // biome-ignore lint/performance/noDelete: the point of the assertion
    delete env.MUXPAD_API_URL;
    await expect(
      execFileAsync(process.execPath, [RUNNER, '--model', 'x'], { env, timeout: 15_000 }),
    ).rejects.toThrow(/must run inside a muxpad pane/);
  });
});
