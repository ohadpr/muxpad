import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-cron-cli-'));
  // Echo the POST body as the API response. No listener or live data.
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
function create(flags: string[]) {
  return JSON.parse(
    execFileSync(
      resolve('..', 'scripts/muxpad'),
      ['--json', 'cron', 'new', '--name=watch', '--at=every 30m', ...flags, 'check saved state'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          MUXPAD_API_URL: 'http://127.0.0.1:1',
          MUXPAD_WORKSPACE_ID: 'workspace',
          MUXPAD_PANE_ID: 'pane',
        },
      },
    ),
  );
}
it('defaults to fresh context instead of the current conversation', () => {
  expect(create([])).toMatchObject({ target_kind: 'new-tab', workspace_id: 'workspace' });
});
it('preserves an explicit live-session target', () => {
  expect(create(['--pane'])).toMatchObject({ target_kind: 'pane', target_pane: 'pane' });
});
it('reads --card from its own argument regardless of flag order', () => {
  expect(create(['--new-tab', '--card=market'])).toMatchObject({ card: 'market' });
});
