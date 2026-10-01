import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InboundSender, inboundTextKey } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentBridge } from '../agent-bridge.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

/**
 * WHO SENT THE MESSAGE, recorded at the door.
 *
 * `muxpad agent send` runs INSIDE a pane and has always thrown that fact away:
 * the body was `{text}` and nothing else, so on the receiving side a
 * coordinator's brief rendered as an ordinary user bubble. These are the two
 * halves of fixing that — the send route learning `from_pane`, and a route the
 * receiving conversation can ask.
 */
describe('inbound-message provenance', () => {
  let test: TestApp;
  let tmp: string;
  /** Every send the stub bridge accepted, so a test can prove the TEXT is untouched. */
  let delivered: string[];

  /** Flipped by the rejection test — the runner refusing the message. */
  let accept: boolean;

  const bridge = (): AgentBridge =>
    ({
      send: (_paneId: string, text: string) => {
        if (!accept) return { ok: false as const, reason: 'pane has no agent runner' };
        delivered.push(text);
        return { ok: true as const, queued: false };
      },
      turnActive: () => false,
    }) as unknown as AgentBridge;

  const workspace = async (): Promise<string> =>
    (
      (await (
        await test.app.request('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'W' }),
        })
      ).json()) as { id: string }
    ).id;

  /** A chat with one pane — what both ends of a send are. */
  const chat = async (ws: string, name: string): Promise<{ tabId: string; paneId: string }> => {
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, workspace_id: ws }),
      })
    ).json()) as { id: string };
    const p = (await (
      await test.app.request(`/api/tabs/${t.id}/panes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shell: '/bin/sh' }),
      })
    ).json()) as { id: string };
    return { tabId: t.id, paneId: p.id };
  };

  const send = async (paneId: string, text: string, fromPane?: string) =>
    test.app.request(`/api/agent-sessions/${paneId}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(fromPane ? { from_pane: fromPane } : {}) }),
    });

  const senders = async (tabId: string): Promise<InboundSender[]> =>
    (
      (await (await test.app.request(`/api/tabs/${tabId}/inbound-senders`)).json()) as {
        senders: InboundSender[];
      }
    ).senders;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-inbound-'));
    delivered = [];
    accept = true;
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp, agentBridge: bridge() });
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('records the SENDING CHAT when the caller names the pane it ran in', async () => {
    const ws = await workspace();
    const boss = await chat(ws, 'coordinator');
    const worker = await chat(ws, 'worker');
    expect((await send(worker.paneId, 'go check the PRs', boss.paneId)).status).toBe(202);
    const rows = await senders(worker.tabId);
    expect(rows).toEqual([
      { key: inboundTextKey('go check the PRs'), at: expect.any(Number), from_tab_id: boss.tabId },
    ]);
  });

  it('records a TAB id, not the name — so a renamed chat still resolves', async () => {
    // The card's label is looked up live from the corpus. Storing the name would
    // freeze it, and would let a caller make a card claim a chat it is not.
    const ws = await workspace();
    const boss = await chat(ws, 'coordinator');
    const worker = await chat(ws, 'worker');
    await send(worker.paneId, 'a brief', boss.paneId);
    expect((await senders(worker.tabId))[0]?.from_tab_id).toBe(boss.tabId);
  });

  it('records NOTHING for the web composer — the human is not a card', async () => {
    // The composer goes through the chat socket, not here; but a bodiless HTTP
    // send is the same statement — nobody claimed to be a chat.
    const ws = await workspace();
    const worker = await chat(ws, 'worker');
    expect((await send(worker.paneId, 'what is the status?')).status).toBe(202);
    expect(await senders(worker.tabId)).toEqual([]);
  });

  it('does not invent an attribution when the sending pane is unknown', async () => {
    // A pane that has since been deleted, or a caller that made one up. muxpad
    // knows a send happened and cannot name a chat: that is a null sender, which
    // the client renders as an ordinary bubble.
    const ws = await workspace();
    const worker = await chat(ws, 'worker');
    await send(worker.paneId, 'from nowhere', 'p-does-not-exist');
    expect((await senders(worker.tabId))[0]?.from_tab_id).toBeNull();
  });

  it('records nothing when a chat sends into ITSELF', async () => {
    // An agent running `muxpad agent send` against its own pane is the agent
    // talking to itself — a queued note, a self-reminder. A "from" card on that
    // says nothing the reader does not already know, and naming the chat they
    // are reading as the sender reads as a bug.
    const ws = await workspace();
    const self = await chat(ws, 'worker');
    expect((await send(self.paneId, 'remember to re-run the suite', self.paneId)).status).toBe(202);
    expect(await senders(self.tabId)).toEqual([]);
  });

  it('records nothing when the send was REJECTED', async () => {
    // Provenance for a message that never arrived would put a card on a bubble
    // that does not exist.
    const ws = await workspace();
    const boss = await chat(ws, 'coordinator');
    const worker = await chat(ws, 'worker');
    accept = false;
    expect((await send(worker.paneId, 'nowhere to land', boss.paneId)).status).toBe(409);
    expect(await senders(worker.tabId)).toEqual([]);
  });

  it('does NOT alter the text delivered to the harness', async () => {
    // The whole point of a side table: this is presentation. A marker prepended
    // to the prompt would change every worker's behaviour.
    const ws = await workspace();
    const boss = await chat(ws, 'coordinator');
    const worker = await chat(ws, 'worker');
    await send(worker.paneId, 'run the suite and report', boss.paneId);
    expect(delivered).toEqual(['run the suite and report']);
  });

  it('answers an empty list for a chat nothing was ever sent to', async () => {
    const ws = await workspace();
    const worker = await chat(ws, 'worker');
    expect(await senders(worker.tabId)).toEqual([]);
  });
});
