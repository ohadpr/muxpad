import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@anthropic-ai/claude-agent-sdk', () => import('../test-helpers/fakeAgentSdk.js'));
import { AccountPool } from '../claude-accounts/pool.js';
import { type FakeSession, fakeSession, resetFakeAgentSdk } from '../test-helpers/fakeAgentSdk.js';
import { createClaudeBackend } from './backends/claude.js';
import type { AgentBackend } from './backends/types.js';
import type { RunnerFrame } from './protocol.js';

let dir: string;
let backend: AgentBackend;
let run: Promise<void>;
let frames: RunnerFrame[];
const sid = '11111111-2222-3333-4444-555555555555';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-quota-'));
  const primary = join(dir, 'primary');
  const backup = join(dir, 'backup');
  mkdirSync(join(primary, 'projects/project'), { recursive: true });
  mkdirSync(backup);
  symlinkSync(join(primary, 'projects'), join(backup, 'projects'));
  writeFileSync(join(primary, 'projects/project', `${sid}.jsonl`), '{"type":"user"}\n');
  writeFileSync(
    join(dir, 'claude-accounts.json'),
    JSON.stringify({
      version: 1,
      preferred: 'primary',
      accounts: [
        { id: 'primary', label: 'Primary', configDir: primary, priority: 0 },
        { id: 'backup', label: 'Backup', configDir: backup, priority: 1 },
      ],
    }),
  );
  vi.stubEnv('MUXPAD_DATA_DIR', dir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', primary);
  frames = [];
  boot();
});
function boot() {
  backend = createClaudeBackend(
    {
      paneId: 'pane',
      apiUrl: '',
      emit: (f) => frames.push(f),
      log: () => {},
      connected: () => false,
    },
    { requestedSid: sid, requestedModel: 'opus', mode: 'agent' },
  );
  run = backend.start();
}
afterEach(async () => {
  backend.shutdown();
  await run;
  resetFakeAgentSdk();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
async function until(test: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function send(text = 'do the work') {
  backend.send(text);
  const s = fakeSession();
  await until(() => s.promptTexts.length > 0);
  return s;
}
const result = { type: 'result', subtype: 'success', duration_ms: 1, total_cost_usd: 0 };
const limited = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    rateLimitType: 'five_hour',
    resetsAt: Math.floor(Date.now() / 1000) + 10000,
  },
};
function assistant(content: unknown[], error?: string) {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    error,
    uuid: 'a',
    message: { model: error ? '<synthetic>' : 'opus', content },
  };
}
async function deny(s: FakeSession) {
  s.push(limited);
  s.push(result);
  await s.settle();
}

describe('Claude quota recovery through real backend loop', () => {
  it('switches credentials, resumes same session and retries a rejected request', async () => {
    const first = await send();
    await deny(first);
    await until(() => fakeSession() !== first && fakeSession().promptTexts.length === 1);
    const next = fakeSession();
    expect(first.closed).toBe(true);
    expect(next.options.resume).toBe(sid);
    expect((next.options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(
      join(dir, 'backup'),
    );
    expect(next.promptTexts).toEqual(['do the work']);
    expect(frames.filter((f) => f.t === 'turn-done')).toHaveLength(0);
    next.push(result);
    await next.settle();
    expect(frames.some((f) => f.t === 'turn-done' && f.ok)).toBe(true);
  });
  it('does NOT replay a request the turn already answered', async () => {
    /**
     * THE DOUBLE DELIVERY, as a test.
     *
     * The SDK emits `rate_limit_event` whenever the window CHANGES, not only
     * when a request is refused. So a turn that answered perfectly well and
     * then tipped the window to rejected looked, to recovery, exactly like a
     * request that never ran — and the user's message was sent again on the
     * next account. One typed message, two turns, two answers. Reported from
     * a real session as "I only typed this once".
     *
     * The account must still be blocked; only the replay is wrong.
     */
    const first = await send();
    first.push(assistant([{ type: 'text', text: 'Here is the answer.' }]));
    await deny(first);
    await first.settle();

    // No second session, and nothing re-prompted.
    expect(fakeSession()).toBe(first);
    expect(first.promptTexts).toEqual(['do the work']);
    expect(frames.some((f) => f.t === 'turn-done' && f.ok)).toBe(true);
    // …and the refusal was still recorded, so the account cools down.
    const pool = new AccountPool(dir);
    const cooling = pool.db
      .prepare('SELECT 1 FROM cooldowns WHERE account = ? AND until_ms > ?')
      .get('primary', Date.now());
    pool.close();
    expect(cooling).toBeTruthy();
  });

  it('still replays when the turn produced only the provider refusal', async () => {
    // The other side of the same branch: a turn whose ONLY assistant message
    // is the CLI's synthetic "you've hit your limit" has not answered
    // anything, and must still move to the next account.
    const first = await send();
    first.push(assistant([{ type: 'text', text: "You've hit your limit" }], 'rate_limit'));
    await deny(first);
    await until(() => fakeSession() !== first);
    expect(fakeSession().promptTexts).toEqual(['do the work']);
  });

  it('does not switch on warning events or normal prose', async () => {
    const first = await send();
    first.push({ ...limited, rate_limit_info: { status: 'allowed_warning' } });
    first.push(assistant([{ type: 'text', text: "You've hit your limit" }]));
    first.push(result);
    await first.settle();
    expect(fakeSession()).toBe(first);
    expect(first.closed).toBe(false);
  });
  it('uses structured assistant denial even when result says success', async () => {
    const first = await send();
    first.push(
      assistant(
        [
          {
            type: 'text',
            text: "You've hit your weekly limit · resets Oct 21 at 1pm (America/Los_Angeles)",
          },
        ],
        'rate_limit',
      ),
    );
    first.push(result);
    await first.settle();
    await until(() => fakeSession() !== first);
  });
  it('continues after completed tools instead of replaying the action', async () => {
    const first = await send('send the message');
    first.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    first.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    });
    await deny(first);
    await until(() => fakeSession() !== first && fakeSession().promptTexts.length > 0);
    expect(fakeSession().promptTexts[0]).toContain('do not repeat completed actions');
    expect(fakeSession().promptTexts[0]).not.toBe('send the message');
  });
  it('pauses post-tool recovery when the saved transcript is missing', async () => {
    const first = await send('send the message');
    first.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    first.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    });
    rmSync(join(dir, 'primary/projects/project', `${sid}.jsonl`));
    await deny(first);
    expect(fakeSession()).toBe(first);
    expect(frames.some((f) => f.t === 'turn-done' && f.error?.includes('reconciliation'))).toBe(
      true,
    );
    backend.send('/retry');
    expect(first.promptTexts).toHaveLength(1);
    expect(
      frames.some((f) => f.t === 'turn-done' && f.error?.includes('restore the conversation')),
    ).toBe(true);
  });
  it('waits without a live session if history disappears during backoff, then resumes after restoration', async () => {
    const first = await send('send the message');
    first.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    first.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    });
    await deny(first);
    expect(first.closed).toBe(true);
    const path = join(dir, 'primary/projects/project', `${sid}.jsonl`);
    rmSync(path);
    await until(() =>
      frames.some((f) => f.t === 'turn-done' && f.error?.includes('Restore the conversation')),
    );
    expect(fakeSession()).toBe(first);
    writeFileSync(path, '{"type":"user"}\n');
    backend.send('/retry');
    await until(() => fakeSession() !== first && fakeSession().promptTexts.length > 0);
    expect(fakeSession().options.resume).toBe(sid);
    expect(fakeSession().options.sessionId).toBeUndefined();
    expect(fakeSession().promptTexts[0]).toContain('do not repeat completed actions');
  });

  it('Stop releases history-paused recovery without replay and clears active status', async () => {
    const first = await send('send the message');
    first.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    first.push({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    });
    await deny(first);
    rmSync(join(dir, 'primary/projects/project', `${sid}.jsonl`));
    await until(() =>
      frames.some((f) => f.t === 'turn-done' && f.error?.includes('Restore the conversation')),
    );
    backend.stop();
    await until(() => {
      const hello = backend.hello();
      return hello.t === 'hello' && !hello.turnActive;
    });
    expect(fakeSession().promptTexts).toHaveLength(0);
    const pool = new AccountPool(dir);
    expect(pool.pending('pane')).toBeUndefined();
    pool.close();
  });
  it('preserves history-required pending recovery across runner restart', async () => {
    backend.shutdown();
    await run;
    resetFakeAgentSdk();
    const pool = new AccountPool(dir);
    pool.savePending('pane', sid, 'continue after completed tools', 'quota', true);
    pool.close();
    const path = join(dir, 'primary/projects/project', `${sid}.jsonl`);
    rmSync(path);
    boot();
    const session = fakeSession();
    expect(session.options.resume).toBe(sid);
    expect(session.options.sessionId).toBeUndefined();
    backend.send('/retry');
    expect(session.promptTexts).toHaveLength(0);
    expect(
      frames.some((f) => f.t === 'turn-done' && f.error?.includes('restore the conversation')),
    ).toBe(true);
    writeFileSync(path, '{"type":"user"}\n');
    backend.send('/retry');
    await until(() => session.promptTexts.length > 0);
    expect(session.promptTexts[0]).toBe('continue after completed tools');
  });
  it('pauses when a tool outcome is unknown', async () => {
    const first = await send();
    first.push(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]));
    await deny(first);
    expect(fakeSession()).toBe(first);
    expect(frames.some((f) => f.t === 'turn-done' && f.error?.includes('reconciliation'))).toBe(
      true,
    );
    const pool = new AccountPool(dir);
    expect(pool.pending('pane')).toBeDefined();
    pool.close();
  });
  it('stops after both accounts reject, saves the request, and supports explicit retry', async () => {
    const first = await send();
    await deny(first);
    await until(() => fakeSession() !== first && fakeSession().promptTexts.length > 0);
    const second = fakeSession();
    await deny(second);
    expect(fakeSession()).toBe(second);
    expect(
      frames.some((f) => f.t === 'turn-done' && f.error?.includes('All Claude accounts')),
    ).toBe(true);
    const pool = new AccountPool(dir);
    expect(pool.pending('pane')?.text).toBe('do the work');
    pool.db.prepare('DELETE FROM cooldowns').run();
    pool.close();
    backend.send('/retry');
    await until(() => second.promptTexts.length === 2);
    expect(second.promptTexts[1]).toBe('do the work');
  });
  it('Stop during recovery prevents replay', async () => {
    const first = await send();
    await deny(first);
    backend.stop();
    await until(() => fakeSession() !== first);
    expect(fakeSession().promptTexts).toHaveLength(0);
    expect(frames.some((f) => f.t === 'turn-done' && f.ok)).toBe(true);
  });
  it('keeps the selected model across failover', async () => {
    await backend.setModel('sonnet');
    const first = await send();
    await deny(first);
    await until(() => fakeSession() !== first);
    expect(fakeSession().options.model).toBe('sonnet');
  });
  it('retains the interrupted request ahead of later queued input', async () => {
    const first = await send('original request');
    await deny(first);
    await until(() => fakeSession() !== first && fakeSession().promptTexts.length > 0);
    const second = fakeSession();
    backend.send('later request');
    await deny(second);
    const pool = new AccountPool(dir);
    pool.db.prepare('DELETE FROM cooldowns').run();
    pool.close();
    backend.send('/retry');
    await until(() => second.promptTexts.length === 2);
    expect(second.promptTexts[1]).toBe('original request');
    second.push(result);
    await second.settle();
    await until(() => second.promptTexts.length === 3);
    expect(second.promptTexts[2]).toBe('later request');
  });
  it('recovers a CLI parked on a rejected event without a result', async () => {
    const first = await send();
    first.push(limited);
    await first.settle();
    // Only the recovery timer is advanced; the jitter uses a real clock.
    await new Promise((r) => setTimeout(r, 5100));
    await until(() => fakeSession() !== first && fakeSession().promptTexts.length > 0);
    expect(fakeSession().promptTexts[0]).toBe('do the work');
  });
});
