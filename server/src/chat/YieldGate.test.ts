import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../events.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { TaskStore } from './TaskStore.js';
import { YieldGate } from './YieldGate.js';
import * as lastMessage from './last-message.js';

/**
 * THE GATE, WIRED. Everything here is about the one direction it may fail in:
 * it exists to make the cockpit less likely to stop, and must never be able
 * to trap work inside a chat or talk over the person holding the Stop button.
 */
describe('the anti-yield gate on the turn bus', () => {
  let db: ReturnType<typeof openDb>;
  let dir: string;
  let bus: EventBus;
  let sent: { paneId: string; text: string }[];
  let decided: string;
  let prompts: string[];
  let paneId: string;
  let tabId: string;

  const make = (over: Partial<ConstructorParameters<typeof YieldGate>[0]> = {}) =>
    new YieldGate({
      db,
      events: bus,
      send: (p, text) => {
        sent.push({ paneId: p, text });
        return { status: 'sent' };
      },
      decide: async (prompt) => {
        prompts.push(prompt);
        return decided;
      },
      isOwner: (t) => !t.startsWith('[muxpad'),
      log: () => {},
      ...over,
    });

  const turnDone = async (gate: YieldGate, over: Record<string, unknown> = {}) => {
    gate.start();
    bus.emit({
      type: 'agent_turn',
      pane_id: paneId,
      phase: 'done',
      sid: 's1',
      backend: 'claude',
      ...over,
    } as never);
    await gate.idle();
    gate.stop();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muxpad-yield-'));
    db = openDb(':memory:');
    bus = new EventBus();
    sent = [];
    prompts = [];
    decided = '{"verdict":"prod","message":"run the suite","why":"no proof"}';
    const ws = new WorkspaceStore(db).create({ name: 'W' });
    const tab = new TabStore(db).create({ name: 'T', workspace_id: ws.id, layout: '' });
    tabId = tab.id;
    paneId = new PaneStore(db).create({ tab_id: tab.id, startup_cmd: '', face: 'chat' }).id;
    // A readable yield: the owner asked, the chat answered.
    vi.spyOn(lastMessage, 'recentChatEvents').mockReturnValue([
      { kind: 'user', text: 'make it shorter' },
      { kind: 'assistant', text: 'done' },
    ] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prods a chat that yielded with nothing recorded, and writes the task', async () => {
    await turnDone(make());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('run the suite');
    expect(sent[0]?.text).toContain('autopilot');
    // The task the agent should have written — which is what makes the budget
    // and the anti-loop govern the NEXT yield.
    const task = new TaskStore(db).openFor(tabId);
    expect(task?.request).toBe('make it shorter');
    expect(task?.continuations).toBe(1);
  });

  it('asks the model about the owner’s goal, with both sides of the yield', async () => {
    await turnDone(make());
    expect(prompts[0]).toContain('make it shorter');
    expect(prompts[0]).toContain('done');
    expect(prompts[0]).toMatch(/GOAL/);
  });

  it('NEVER talks over Stop', async () => {
    await turnDone(make(), { stopped: true });
    expect(sent).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it('leaves a turn with background work alone — it has not yielded', async () => {
    // Backgrounded work starts another turn on its own; prodding races it.
    await turnDone(make(), { background: 1 });
    expect(sent).toEqual([]);
  });

  it('hands over when the model says so', async () => {
    decided = '{"verdict":"deliver","why":"he asked a question"}';
    await turnDone(make());
    expect(sent).toEqual([]);
    expect(new TaskStore(db).openFor(tabId)).toBe(null);
  });

  it.each([
    ['the model throws', () => Promise.reject(new Error('quota'))],
    ['the model returns prose', () => Promise.resolve('I think continue?')],
    ['the model returns nothing', () => Promise.resolve('')],
  ])('hands over when %s', async (_n, decide) => {
    await turnDone(make({ decide: decide as () => Promise<string> }));
    expect(sent).toEqual([]);
    // And leaves no half-written task behind.
    expect(new TaskStore(db).openFor(tabId)).toBe(null);
  });

  it('leaves a chat that DID record a task to the existing machinery', async () => {
    // task-continue.ts has already run by the time this event lands; two
    // systems prodding one chat is a loop with a bill attached.
    new TaskStore(db).create(tabId, { request: 'declared' });
    await turnDone(make());
    expect(sent).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it('leaves sub-chats alone — their reader is the parent', async () => {
    const tabs = new TabStore(db);
    const ws = new WorkspaceStore(db).list()[0];
    const child = tabs.create({
      name: 'worker',
      workspace_id: ws?.id as string,
      layout: '',
      spawned_by: tabId,
    });
    const childPane = new PaneStore(db).create({
      tab_id: child.id,
      startup_cmd: '',
      face: 'chat',
    }).id;
    paneId = childPane;
    await turnDone(make());
    expect(sent).toEqual([]);
  });

  it('says nothing about a chat with no readable transcript', async () => {
    vi.spyOn(lastMessage, 'recentChatEvents').mockReturnValue(null);
    await turnDone(make());
    expect(sent).toEqual([]);
    expect(prompts).toEqual([]);
  });
});
