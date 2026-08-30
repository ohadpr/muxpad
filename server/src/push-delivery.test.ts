import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delivery parameters, not payload shape (that's push.test.ts).
 *
 * TTL is the one that bit: at 300s the push service dropped the message if the
 * phone wasn't reachable within five minutes, which is most of the time a
 * "your agent is waiting on you" notification actually matters.
 */
const sendNotification = vi.fn(async () => ({}) as never);
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    sendNotification,
  },
}));

const { PushService } = await import('./push.js');
const { openDb } = await import('./store/db.js');

let dir: string;
beforeEach(() => {
  sendNotification.mockClear();
  dir = mkdtempSync(join(tmpdir(), 'muxpad-push-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function serviceWithOneSub() {
  const db = openDb(':memory:');
  const push = new PushService(db, dir);
  push.subscribe({ endpoint: 'https://push.example/abc' });
  return push;
}

function optsOfLastSend() {
  return sendNotification.mock.calls.at(-1)?.[2] as {
    TTL: number;
    urgency?: string;
    topic?: string;
  };
}

describe('PushService.send delivery options', () => {
  it('holds an undelivered notification for an hour, not five minutes', async () => {
    await serviceWithOneSub().send({ title: 't', body: 'b', url: '/' });
    expect(optsOfLastSend().TTL).toBe(3600);
  });

  it('asks the push service to wake the device rather than batch it', async () => {
    await serviceWithOneSub().send({ title: 't', body: 'b', url: '/' });
    expect(optsOfLastSend().urgency).toBe('high');
  });

  it('collapses queued notifications per pane, so an hour of TTL cannot stack', async () => {
    // Without a topic, a phone offline for 30 minutes would receive every
    // queued "wants your attention" for the same pane on reconnect.
    await serviceWithOneSub().send({ title: 't', body: 'b', url: '/', tag: '01J8XABCDEF' });
    expect(optsOfLastSend().topic).toBe('01J8XABCDEF');
  });

  it('omits the topic rather than risk a 400 on an unrepresentable tag', async () => {
    const push = serviceWithOneSub();
    await push.send({ title: 't', body: 'b', url: '/' });
    expect(optsOfLastSend().topic).toBeUndefined();
    await push.send({ title: 't', body: 'b', url: '/', tag: 'a'.repeat(33) });
    expect(optsOfLastSend().topic).toBeUndefined();
    await push.send({ title: 't', body: 'b', url: '/', tag: 'has spaces/and+slashes' });
    expect(optsOfLastSend().topic).toBeUndefined();
  });
});
