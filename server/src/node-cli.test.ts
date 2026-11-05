import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `muxpad node` — PAIRING, FROM THE SHELL.
 *
 * `init` is the half that runs ON THE MACHINE BEING PAIRED, and it is the only
 * verb in the CLI that talks to no server: that machine has none, and on the
 * pair this was built for it cannot even reach the one that issued its token.
 * So it is a local file write plus an optional service install — which makes
 * it the one part of pairing that can be tested end to end here, against a
 * real filesystem.
 */

const CLI = fileURLToPath(new URL('../../scripts/muxpad', import.meta.url));
const SRC = readFileSync(CLI, 'utf8');

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Run the CLI against a throwaway data dir. Never the real `~/.muxpad`. */
function run(args: string[]): { status: number; out: string } {
  dir ??= mkdtempSync(join(tmpdir(), 'muxpad-node-cli-'));
  try {
    const out = execFileSync(CLI, args, {
      env: { ...process.env, MUXPAD_DATA_DIR: dir, MUXPAD_PTYD_SOCKET: join(dir, 'ptyd.sock') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const TOKEN = 'a'.repeat(64);

describe('muxpad node init', () => {
  it('writes the token 0600, in a 0700 directory', () => {
    const r = run(['node', 'init', `--token=${TOKEN}`]);
    expect(r.status).toBe(0);
    const path = join(dir as string, 'node-token');
    expect(readFileSync(path, 'utf8').trim()).toBe(TOKEN);
    // This file is the whole of a machine's authentication. A world-readable
    // window, however short, is a window on the whole machine — which is why
    // it is written under `umask 077` rather than chmod'ed afterwards.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir as string).mode & 0o777).toBe(0o700);
  });

  it('refuses a truncated paste rather than installing one that fails closed', () => {
    // `readNodeToken` treats anything under 32 chars as ABSENT, not as a
    // credential — so a short token would install silently and then look
    // exactly like a machine nobody paired.
    const r = run(['node', 'init', '--token=tooshort']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/too short/i);
  });

  it('requires a token, and says where to get one', () => {
    const r = run(['node', 'init']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/muxpad node add/);
  });

  it('tells you how to start the agent when you did not ask for a service', () => {
    const r = run(['node', 'init', `--token=${TOKEN}`]);
    expect(r.out).toMatch(/node-agent\/cli\.js/);
    expect(r.out).toMatch(/--service/);
  });
});

describe('the verb set', () => {
  it('is dispatched, and `init` is documented as the other machine’s half', () => {
    expect(SRC).toContain('node) cmd_node');
    expect(SRC).toMatch(/on the OTHER machine/);
  });

  it('prints usage and fails when given no subcommand', () => {
    const r = run(['node']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/muxpad node add <id>/);
  });

  it('installs a user service that survives logout, not just this session', () => {
    // A systemd --user unit dies at logout and never comes back after a
    // reboot without lingering, which is precisely the machine this is for.
    expect(SRC).toContain('loginctl enable-linger');
    expect(SRC).toContain('RestartSec=2');
    expect(SRC).toContain('dev.muxpad.node');
  });
});
