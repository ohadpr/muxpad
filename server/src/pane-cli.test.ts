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

/**
 * `muxpad pane open` — KEPT, and placement-free like `pane new`.
 *
 * The no-panes audit recommended retiring it: a page is not a chat, an agent
 * or a terminal, and zero of them existed live. The first half is a NAMING
 * problem, which `rowNoun` answers with "web view"; the second is weak
 * evidence, zero at one moment in a cockpit whose own description is
 * terminal-AND-browser. And it is the only way to put a page INSIDE muxpad —
 * `muxpad open` throws it to a real browser, `serve` and `app` both need a
 * command to run — so retiring it removes a capability, which is not what "a
 * tab holds one thing" asked for.
 *
 * What it loses is the placement. One url row in an empty tab is still one
 * thing in the tab.
 */
describe('muxpad pane open', () => {
  it('asks for a web view and nothing about where to put it', () => {
    const body = JSON.parse(run(['open', '--tab=empty', 'https://example.test/d']).out);
    expect(body).toEqual({ kind: 'url', url: 'https://example.test/d' });
  });

  it('carries no split, even from inside a pane', () => {
    // `--target` defaulted to MUXPAD_PANE_ID, so running this from a chat
    // asked to split the chat you were sitting in.
    const body = JSON.parse(run(['open', '--tab=empty', 'https://example.test/d']).out);
    expect(body).not.toHaveProperty('split_from');
    expect(body).not.toHaveProperty('append_to_layout');
  });

  it('refuses the placement flags as unknown, like pane new', () => {
    for (const flag of ['--direction=right', '--target=p1']) {
      const r = run(['open', '--tab=empty', flag, 'https://example.test/d']);
      expect(r.status, flag).toBe(1);
      expect(r.out, flag).toContain(`unknown flag ${flag.split('=')[0]}`);
    }
  });
});
