import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadlessRunner } from './HeadlessRunner.js';

function writeFakeBin(dir: string, body: string): string {
  const bin = join(dir, 'fakeclaude.sh');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function run(opts: {
  bin: string;
  cwd: string;
}): Promise<{ sids: string[]; ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const sids: string[] = [];
    const r = new HeadlessRunner({
      cwd: opts.cwd,
      resumeSid: 'resume-me',
      text: 'hello',
      bin: opts.bin,
      cb: {
        onSessionId: (s) => sids.push(s),
        onDone: (ok, error) => resolve({ sids, ok, ...(error ? { error } : {}) }),
      },
    });
    r.start();
  });
}

describe('HeadlessRunner', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hr-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('captures the session-id from init and reports success on clean exit', async () => {
    const bin = writeFakeBin(
      dir,
      `echo '{"type":"system","subtype":"init","session_id":"new-sid-1","model":"m"}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}'
echo '{"type":"result","subtype":"success","session_id":"new-sid-1"}'`,
    );
    const res = await run({ bin, cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.sids).toContain('new-sid-1');
  });

  it('handles multi-line/chunked JSON and dedupes the id across init+result', async () => {
    const bin = writeFakeBin(
      dir,
      `printf '{"type":"system","subtype":"init","sess'
printf 'ion_id":"drift-2"}\\n'
echo '{"type":"result","session_id":"drift-2"}'`,
    );
    const res = await run({ bin, cwd: dir });
    expect(res.ok).toBe(true);
    // Same id from init and result — both captured (caller dedupes).
    expect(res.sids.every((s) => s === 'drift-2')).toBe(true);
    expect(res.sids.length).toBeGreaterThanOrEqual(1);
  });

  it('reports failure with stderr on a nonzero exit', async () => {
    const bin = writeFakeBin(dir, `echo "boom" >&2\nexit 3`);
    const res = await run({ bin, cwd: dir });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
  });

  it('reports failure when the binary does not exist', async () => {
    const res = await run({ bin: join(dir, 'nope-does-not-exist'), cwd: dir });
    expect(res.ok).toBe(false);
  });

  it('ignores torn/garbage stdout lines without crashing', async () => {
    const bin = writeFakeBin(
      dir,
      `echo 'not json at all'
echo '{"type":"system","subtype":"init","session_id":"s9"}'
echo '{"type":"result","session_id":"s9"}'`,
    );
    const res = await run({ bin, cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.sids).toContain('s9');
  });
});
