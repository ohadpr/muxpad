import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));
import { accountCompletion } from './completion.js';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-completion-'));
  vi.stubEnv('MUXPAD_DATA_DIR', dir);
  writeFileSync(
    join(dir, 'claude-accounts.json'),
    JSON.stringify({
      version: 1,
      preferred: 'primary',
      accounts: ['primary', 'backup'].map((id, priority) => ({
        id,
        label: id,
        configDir: join(dir, id),
        priority,
      })),
    }),
  );
  query.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
function stream(messages: unknown[]) {
  return Object.assign(
    (async function* () {
      yield* messages;
    })(),
    { close: vi.fn() },
  );
}
it('retries tool-free housekeeping on the backup and never returns the quota error as a title', async () => {
  const failed = stream([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }]);
  const success = stream([{ type: 'result', subtype: 'success', result: 'A useful title' }]);
  query.mockReturnValueOnce(failed).mockReturnValueOnce(success);
  const out = [];
  for await (const msg of accountCompletion({ prompt: 'title', options: { model: 'haiku' } }))
    out.push(msg);
  expect(out).toEqual([{ type: 'result', subtype: 'success', result: 'A useful title' }]);
  expect(query.mock.calls[1]?.[0].options.env.CLAUDE_CONFIG_DIR).toBe(join(dir, 'backup'));
  expect(query.mock.calls[1]?.[0].options.tools).toEqual([]);
  expect(failed.close).toHaveBeenCalled();
  expect(success.close).toHaveBeenCalled();
});
it('tries each account only once', async () => {
  query.mockImplementation(() =>
    stream([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }]),
  );
  await expect(
    (async () => {
      for await (const _ of accountCompletion({ prompt: 'x', options: {} })) {
        /* drain */
      }
    })(),
  ).rejects.toThrow('All Claude accounts');
  expect(query).toHaveBeenCalledTimes(2);
});
it('does not start anything after cancellation', async () => {
  const abort = new AbortController();
  abort.abort();
  for await (const _ of accountCompletion({ prompt: 'x', options: { abortController: abort } })) {
    /* drain */
  }
  expect(query).not.toHaveBeenCalled();
});
it('keeps legacy behavior when the pool is not configured', async () => {
  const other = join(dir, 'unconfigured');
  mkdirSync(other);
  vi.stubEnv('MUXPAD_DATA_DIR', other);
  query.mockReturnValue(stream([{ type: 'result', subtype: 'success', result: 'ok' }]));
  for await (const _ of accountCompletion({ prompt: 'x', options: {} })) {
    /* drain */
  }
  expect(query.mock.calls[0]?.[0].options.env).toBeUndefined();
});

it('disables thinking and uses low effort for all housekeeping, including retries', async () => {
  query
    .mockReturnValueOnce(
      stream([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }]),
    )
    .mockReturnValueOnce(stream([{ type: 'result', subtype: 'success', result: 'label' }]));
  for await (const _ of accountCompletion({
    prompt: 'label',
    options: { model: 'haiku', effort: 'high' },
  })) {
    /* drain */
  }
  expect(query).toHaveBeenCalledTimes(2);
  for (const [args] of query.mock.calls) {
    expect(args.options).toMatchObject({
      thinking: { type: 'disabled' },
      effort: 'low',
      tools: [],
    });
  }
});
