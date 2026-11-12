import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `muxpad pane new` — NO PLACEMENT FLAGS, BECAUSE THERE IS NOWHERE TO PLACE.
 *
 * `--direction` and `--target` put the new pane in a split beside another one.
 * A tab holds one thing now and the server refuses a second on every route, so
 * an accepted flag could only ever buy a 409 — and once its documentation was
 * gone, a 409 for a flag that appears nowhere. A flag that does not exist says
 * "unknown flag", which is the honest answer.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-pane-cli-'));
  // Echo the request body back as the API's answer: no listener, no live data.
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/bash
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --data) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$body" > "$out"
printf 201
`,
    { mode: 0o755 },
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync(resolve('..', 'scripts/muxpad'), ['--json', 'pane', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        MUXPAD_API_URL: 'http://127.0.0.1:1',
        // Inside a pane: the case where MUXPAD_PANE_ID used to become
        // `split_from` without anyone asking for it.
        MUXPAD_TAB_ID: 'tab',
        MUXPAD_PANE_ID: 'caller',
        MUXPAD_WORKSPACE_ID: '',
      },
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('muxpad pane new', () => {
  it('refuses --direction and --target as unknown flags', () => {
    for (const flag of ['--direction=right', '--target=p1']) {
      const r = run(['new', '--tab=empty', flag]);
      expect(r.status, flag).toBe(1);
      expect(r.out, flag).toContain(`unknown flag ${flag.split('=')[0]}`);
    }
  });

  it('asks for no split, even from inside a pane', () => {
    const body = JSON.parse(run(['new', '--tab=empty', '--cmd=pnpm dev']).out);
    expect(body).toEqual({ append_to_layout: true, startup_cmd: 'pnpm dev' });
    expect(body).not.toHaveProperty('split_from');
    expect(body).not.toHaveProperty('direction');
    expect(body).not.toHaveProperty('position');
  });
});

describe('muxpad pane open', () => {
  it('is retired, and says why instead of creating a bare web page', () => {
    const r = run(['open', 'https://example.com']);
    expect(r.status).toBe(1);
    expect(r.out).toContain("'pane open' is gone");
  });
});
