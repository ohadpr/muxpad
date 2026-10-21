import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-quota-card-'));
  writeFileSync(join(dir, 'muxpad'), '#!/bin/sh\ncat "$QUOTA_FIXTURE"\n', { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function render(cooldowns: unknown[] = []) {
  const file = join(dir, 'status.json');
  writeFileSync(
    file,
    JSON.stringify({
      preferred: 'primary',
      cooldowns,
      utilization: [
        {
          account: 'backup',
          windows: [
            {
              scope: 'seven_day',
              utilization: 54,
              status: 'rejected',
              resetsAt: Date.now() + 3600000,
            },
          ],
        },
      ],
    }),
  );
  return execFileSync(process.execPath, [resolve('..', 'scripts/quota-card.mjs'), '--print'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, MUXPAD_BIN: join(dir, 'muxpad'), QUOTA_FIXTURE: file },
  });
}
it('shows normalized weekly usage without marking a partially-used window as blocked', () => {
  const html = render();
  expect(html).toContain('claude 2 · 7d 54%');
  expect(html).toContain('width:54%');
  expect(html).not.toContain(' · blocked');
});
it('labels an all-model five-hour cooldown as 5h rather than weekly', () => {
  const html = render([
    {
      account: 'backup',
      scope: 'all',
      until_ms: Date.now() + 3600000,
      reason: 'five_hour usage limit',
    },
  ]);
  expect(html).toContain('claude 2 · 5h 100%');
  expect(html).toContain(' · blocked');
});
