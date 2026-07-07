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
  fresh?: boolean;
  startTimeoutMs?: number;
  onStart?: (r: HeadlessRunner) => void;
}): Promise<{ sids: string[]; ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const sids: string[] = [];
    const r = new HeadlessRunner({
      cwd: opts.cwd,
      resumeSid: 'resume-me',
      text: 'hello',
      bin: opts.bin,
      ...(opts.fresh ? { fresh: true } : {}),
      ...(opts.startTimeoutMs ? { startTimeoutMs: opts.startTimeoutMs } : {}),
      cb: {
        onSessionId: (s) => sids.push(s),
        onDone: (ok, error) => resolve({ sids, ok, ...(error ? { error } : {}) }),
      },
    });
    r.start();
    opts.onStart?.(r);
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

  it('delivers the prompt over stdin, not argv', async () => {
    // Echo argv into the "error" so a leaked positional prompt fails the test,
    // and echo stdin back as the captured session-id to prove it arrived.
    const bin = writeFakeBin(
      dir,
      `prompt="$(cat)"
for a in "$@"; do [ "$a" = "hello" ] && { echo "prompt leaked into argv" >&2; exit 1; }; done
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"got:$prompt\\"}"
echo '{"type":"result"}'`,
    );
    const res = await run({ bin, cwd: dir });
    expect(res.ok).toBe(true);
    expect(res.sids).toContain('got:hello');
  });

  it('uses --session-id instead of --resume in fresh mode', async () => {
    const bin = writeFakeBin(
      dir,
      `mode=""
prev=""
for a in "$@"; do
  [ "$prev" = "--resume" ] && mode="resume:$a"
  [ "$prev" = "--session-id" ] && mode="fresh:$a"
  prev="$a"
done
echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$mode\\"}"
echo '{"type":"result"}'`,
    );
    const fresh = await run({ bin, cwd: dir, fresh: true });
    expect(fresh.sids).toContain('fresh:resume-me');
    const resume = await run({ bin, cwd: dir });
    expect(resume.sids).toContain('resume:resume-me');
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

  it('kills a silent child via the startup watchdog and reports the timeout', async () => {
    const bin = writeFakeBin(dir, 'sleep 30');
    const res = await run({ bin, cwd: dir, startTimeoutMs: 300 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('startup timeout');
  });

  it('treats a user interrupt as a clean stop, not an error', async () => {
    const bin = writeFakeBin(
      dir,
      `echo '{"type":"system","subtype":"init","session_id":"s1"}'
sleep 30`,
    );
    const res = await run({
      bin,
      cwd: dir,
      onStart: (r) => setTimeout(() => r.interrupt(), 200),
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });
});
