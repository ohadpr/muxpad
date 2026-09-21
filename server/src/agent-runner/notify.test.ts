// THE EXPLICIT NOTIFICATION — the agent deciding that THIS one is worth a
// phone.
//
// Until this tool, push was a single heuristic living at the turn-done path in
// ws.ts: notify if more than two minutes have passed since the user last typed.
// That guess cannot tell a five-second turn carrying something urgent from a
// ten-minute turn carrying nothing, and it is the agent — not the clock — that
// knows which is which.
//
// Everything here runs through the FAKE SDK HARNESS into the real Claude
// backend, over a real socket, into the real ws.ts handler. Hand-written frames
// have hidden three bugs in this neighbourhood already (see
// subagent-leak.test.ts), and the whole point of this feature is a path that
// crosses a process boundary: an in-process MCP tool call, a frame out, the
// server's rate limit and presence check, and a `notify-result` back that the
// TOOL has to turn into something honest for the model to read.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Must precede the fakeRunner import: constructing the Claude backend calls
// query(), which would otherwise spawn a real Agent SDK session.
vi.mock('@anthropic-ai/claude-agent-sdk', () => import('../test-helpers/fakeAgentSdk.js'));

import { EventBus } from '../events.js';
import { PtydCache, decoratePane } from '../ptyd-cache.js';
import type { PaneNotifyOutcome } from '../push.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { fakeMcpTool, resetFakeAgentSdk } from '../test-helpers/fakeAgentSdk.js';
import { type FakeRunner, startFakeRunner } from '../test-helpers/fakeRunner.js';
import { sdk } from '../test-helpers/sdkScript.js';
import { spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';
import { notifyToolDescription } from './backends/claude.js';
import type { AgentMode, RunnerFrame } from './protocol.js';

// Never touch the real ~/.muxpad: the backend reads agent-instructions.md and
// chat-mode.md from the data dir at construction.
let dataDir: string;
beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'muxpad-notify-test-'));
  process.env.MUXPAD_DATA_DIR = dataDir;
  return () => rmSync(dataDir, { recursive: true, force: true });
});

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
  resetFakeAgentSdk();
  vi.restoreAllMocks();
});

interface Fixture {
  runner: FakeRunner;
  paneId: string;
  /** Every (paneId, body) the server handed the notifier, in order. */
  pushes: Array<[string, string]>;
  /** What the notifier reports back next — the server's push reality. */
  outcome: (next: PaneNotifyOutcome) => void;
  /** Call the `notify` tool the way the live SDK does: out-of-band. */
  notify: (text: string) => Promise<string>;
}

interface BootOptions {
  mode?: AgentMode;
  /** The outcome the notifier reports (default: the push went out). */
  outcome?: PaneNotifyOutcome;
  /** false = a server with no push wired up at all. */
  push?: boolean;
}

async function boot(opts: BootOptions = {}): Promise<Fixture> {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  new AgentSessionStore(db);
  const events = new EventBus();
  const wsRow = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  const cache = new PtydCache();
  cache.on('paneChange', (id: string) => {
    const p = panes.getById(id);
    if (p) events.emit({ type: 'pane.updated', tab_id: p.tab_id, pane: decoratePane(cache, p) });
  });

  const pushes: Array<[string, string]> = [];
  let outcome: PaneNotifyOutcome = opts.outcome ?? 'sent';
  attachWsServer({
    http,
    db,
    ptyd: ptyd.client,
    cache,
    events,
    ...(opts.push === false
      ? {}
      : {
          notifyPane: (paneId: string, body: string) => {
            pushes.push([paneId, body]);
            return outcome;
          },
        }),
  });
  await new Promise<void>((r) => http.listen(0, r));
  const port = (http.address() as AddressInfo).port;
  const runner = await startFakeRunner({
    port,
    paneId: pane.id,
    sid: '11111111-2222-3333-4444-555555555555',
    mode: opts.mode ?? 'chat',
  });
  cleanup = async () => {
    await runner.kill().catch(() => {});
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  };

  return {
    runner,
    paneId: pane.id,
    pushes,
    outcome: (next) => {
      outcome = next;
    },
    /** The tool's RESULT text — what the model reads. */
    async notify(text: string) {
      const res = (await fakeMcpTool('notify').handler({ text } as never)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      // A notification that could not be delivered must never come back as a
      // tool ERROR: an error is a thing a model retries, and a retry loop on a
      // push tool is the failure this whole feature has to survive.
      expect(res.isError).toBeFalsy();
      return res.content[0]?.text ?? '';
    },
  };
}

const notifyFrames = (runner: FakeRunner) =>
  runner.sent.filter((f): f is RunnerFrame & { t: 'notify' } => f.t === 'notify');

describe('the tool is offered, and its description is the UX', () => {
  it('is registered in CHAT mode, alongside the other muxpad tools', async () => {
    await boot({ mode: 'chat' });
    expect(() => fakeMcpTool('notify')).not.toThrow();
    expect(fakeMcpTool('notify').description).toBe(notifyToolDescription());
  });

  it('is registered in AGENT mode too — that is where nobody is watching', async () => {
    // Unlike `reply` (chat-only, because Agent mode's voice IS plain text),
    // this tool is about REACHING the user, which is orthogonal to how the
    // session speaks. Crons, wakeups and overnight batches all run in Agent
    // mode, and those are exactly the turns with no human in front of them.
    await boot({ mode: 'agent' });
    expect(() => fakeMcpTool('notify')).not.toThrow();
    expect(() => fakeMcpTool('reply')).toThrow();
  });

  it('says when NOT to call it as plainly as when to', () => {
    const d = notifyToolDescription();
    // The reach — a tool description is the only place the model learns that a
    // push exists at all.
    expect(d).toMatch(/phone/i);
    expect(d).toMatch(/desktop/i);
    // The single most likely misuse, named outright: a notify sitting next to
    // the final reply of an ordinary turn, which buzzes the user twice because
    // turn-done already pushes after the interactivity window.
    expect(d).toMatch(/do not call it to announce an ordinary finished turn/i);
    expect(d).toMatch(/two minutes/i);
    expect(d).toMatch(/progress updates/i);
    // The cap, stated, so a model that wants to ring twice knows what happens.
    expect(d).toMatch(/one notification per minute/i);
    // The body is the whole message — with exemplars, since that is what gets
    // copied, and an explicit ban on the contentless "check muxpad".
    expect(d).toMatch(/lock screen/i);
    expect(d).toMatch(/never "check muxpad"/i);
    // Non-delivery is NORMAL. A model that reads 'held' as a failure retries,
    // and retrying is the one behaviour the rate limit exists to survive.
    expect(d).toMatch(/none of those is an error/i);
    expect(d).toMatch(/say the thing in your reply instead/i);
  });
});

// ── THE BODY'S BUDGET IS A TARGET, NOT A TRAP ───────────────────────────────
// This file's own rule — "a notification that could not be delivered must
// never come back as a tool ERROR: an error is a thing a model retries" — was
// broken by the schema. `text` carried a zod `.max(180)`, and the comment that
// justified it claimed a schema `maxLength` "would be theatre — both the
// Anthropic and OpenAI SDKs strip it off the wire schema".
//
// That is false, and it is checkable from inside any agent pane: the tool
// listing an agent actually receives shows `mcp__muxpad__notify` with
// `"maxLength": 180`, and `ask_user` with 16/80/300/500 — the exact zod values.
// The constraint survives to the wire, so a 200-character lock-screen line was
// a validation failure mid-turn instead of a notification: exactly the retry
// loop the tool's whole contract is built to avoid, on the one call that is
// only ever made because something cannot wait.
//
// The budget stays — in the description, where it steers — and the handler
// truncates to the lock screen's two lines, which is what ws.ts does to the
// body anyway.
describe('the body’s budget is a target, not a trap', () => {
  const overLong = `Staging deploy failed: ${'migration 0042 timed out '.repeat(12)}`;

  it('does not CAP the body on the wire — an over-long line is not an error', async () => {
    await boot();
    const schema = fakeMcpTool('notify').inputSchema as {
      text: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(overLong.length).toBeGreaterThan(180);
    expect(schema.text.safeParse(overLong).success).toBe(true);
    // Still not a free-for-all: an empty body is meaningless and stays refused.
    expect(schema.text.safeParse('').success).toBe(false);
  });

  it('delivers it anyway, trimmed to what a lock screen shows', async () => {
    const fx = await boot();
    const result = await fx.notify(overLong);
    expect(result).toMatch(/Sent/);
    const body = fx.pushes.at(-1)?.[1] ?? '';
    expect(body.length).toBeLessThanOrEqual(180);
    expect(body.endsWith('…')).toBe(true);
    // The front of the sentence — the part that says what happened — survives.
    expect(body.startsWith('Staging deploy failed: migration 0042 timed out')).toBe(true);
  });

  it('leaves a body inside the budget completely alone', async () => {
    const fx = await boot();
    await fx.notify('staging deploy failed: migration 0042 timed out');
    expect(fx.pushes.at(-1)?.[1]).toBe('staging deploy failed: migration 0042 timed out');
  });

  it('the same is true of the other tools a model writes prose into', async () => {
    // Same bug, same evidence (the live listing shows ask_user's 16/80/300/500
    // and reply's cap on the wire). A chip label one word too long, or a
    // security warning that needs 4,200 characters, must not be a tool error:
    // it is the ANSWER, and a failed reply call ends the turn in silence —
    // which the reply guard then covers by promoting scratchpad.
    await boot({ mode: 'chat' });
    const ask = fakeMcpTool('ask_user').inputSchema as {
      questions: { safeParse: (v: unknown) => { success: boolean } };
    };
    const longHeader = [
      {
        question: 'Which approach?',
        header: 'Implementation approach',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ];
    expect(ask.questions.safeParse(longHeader).success).toBe(true);
    // The STRUCTURAL bounds stay hard — a one-option question is not a
    // question, and no amount of truncation can make it one.
    expect(
      ask.questions.safeParse([
        { question: 'Which?', header: 'Pick', options: [{ label: 'only one' }] },
      ]).success,
    ).toBe(false);
    const reply = fakeMcpTool('reply').inputSchema as {
      text: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(reply.text.safeParse('x'.repeat(4200)).success).toBe(true);
  });
});

describe('the frame reaches the notifier', () => {
  it('a tool call becomes a push on the right pane, with the agent’s text', async () => {
    const fx = await boot();
    const result = await fx.notify('staging deploy failed: migration 0042 timed out');
    expect(notifyFrames(fx.runner)).toHaveLength(1);
    expect(fx.pushes).toEqual([[fx.paneId, 'staging deploy failed: migration 0042 timed out']]);
    expect(result).toMatch(/^Sent/);
  });

  it('collapses whitespace — newlines are invisible in a notification body', async () => {
    const fx = await boot();
    await fx.notify('line one\n\n   line two');
    expect(fx.pushes[0]?.[1]).toBe('line one line two');
  });

  it('truncates a body no lock screen could show', async () => {
    // Past the cap the schema asks for: we cut at 180 with an ellipsis rather
    // than letting the phone cut mid-word wherever it likes. The SERVER does
    // it, not the runner — the runner is version-skewed by design.
    const fx = await boot();
    await fx.notify('x'.repeat(400));
    const body = fx.pushes[0]?.[1] ?? '';
    expect(body).toHaveLength(180);
    expect(body.endsWith('…')).toBe(true);
  });

  it('carries no dependence on the turn-done interactivity gate', async () => {
    // The 2-minute "did the user just type?" suppression lives in ws.ts's
    // turn-done path. An explicit notify is the agent OVERRIDING exactly that
    // heuristic, so it must fire even in the middle of a conversation the user
    // is actively driving — i.e. immediately after a human send.
    const fx = await boot();
    fx.runner.backend.send('have a look at the deploy');
    await new Promise((r) => setTimeout(r, 20));
    await fx.notify('the deploy is wedged — it needs your key');
    expect(fx.pushes).toHaveLength(1);
  });
});

describe('the rate limit', () => {
  it('drops the second call in the window, silently, and says so in the result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = await boot();
    const first = await fx.notify('the build failed');
    const second = await fx.notify('and so did the fallback');

    expect(first).toMatch(/^Sent/);
    expect(second).toMatch(/^Dropped/);
    // One push, not two. Both frames were sent — the runner is not the thing
    // enforcing this, and must not be: a model can restart a runner, it cannot
    // restart the server's clock.
    expect(notifyFrames(fx.runner)).toHaveLength(2);
    expect(fx.pushes).toHaveLength(1);
    // Dropped, but not in silence — the operator can see a model looping.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/notify dropped/i);
    // …and the model is told to put it in the reply, not to try again.
    expect(second).toMatch(/reply instead/i);
  });

  it('only a push that WENT OUT starts the clock', async () => {
    // A notification held because the user was looking, or dropped for want of
    // a device, cost them no attention — so it must not cost the next,
    // genuinely urgent call its window.
    const fx = await boot({ outcome: 'held-active' });
    await fx.notify('first, while they were at their desk');
    fx.outcome('sent');
    const second = await fx.notify('second, after they walked away');
    expect(second).toMatch(/^Sent/);
    expect(fx.pushes).toHaveLength(2);
  });
});

describe('presence, and a server with nothing to push to', () => {
  it('holds while the user is at a device, and says so without pretending', async () => {
    // Presence is respected — deliberately. "Nobody is watching" is a guess;
    // "this device reported a keystroke nine seconds ago" is an observation,
    // and a buzz for something already on their screen is pure noise. A
    // BACKGROUND tab does not count: web/src/lib/presence.ts only heartbeats
    // on a visible document with real interaction, so the desktop case still
    // gets its push.
    const fx = await boot({ outcome: 'held-active' });
    const result = await fx.notify('the rename is done');
    // The notifier was still CALLED — presence is its decision, not ws.ts's.
    expect(fx.pushes).toHaveLength(1);
    expect(result).toMatch(/actively using a device/i);
    expect(result).toMatch(/do not call again/i);
  });

  it('degrades to a no-op when no device is subscribed', async () => {
    const fx = await boot({ outcome: 'no-devices' });
    const result = await fx.notify('the batch finished');
    expect(result).toMatch(/no device is subscribed/i);
    expect(result).toMatch(/reply instead/i);
  });

  it('degrades to a no-op when the server has no push at all', async () => {
    // A test server, or a deployment with push never configured. The tool must
    // not throw, must not hang, and must tell the model plainly.
    const fx = await boot({ push: false });
    const result = await fx.notify('the batch finished');
    expect(result).toMatch(/no push configured/i);
    expect(fx.pushes).toHaveLength(0);
  });

  it('answers immediately when the runner is not connected', async () => {
    // A frame emitted with the socket down is DROPPED, not queued, so waiting
    // five seconds for an ack that cannot come is pure mid-turn latency.
    const fx = await boot();
    await fx.runner.disconnect();
    const started = Date.now();
    const result = await fx.notify('nobody will hear this');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatch(/not connected/i);
  });
});

describe('it does not become a second buzz', () => {
  it('a turn ending right after an explicit notify does NOT push again', async () => {
    // The agent already said the specific thing. "finished its turn" landing on
    // top of it seconds later is a second vibration carrying strictly less
    // information than the first — which is how a notification channel earns
    // itself a mute.
    const fx = await boot();
    await fx.notify('staging deploy failed: migration 0042 timed out');
    expect(fx.pushes).toHaveLength(1);

    await fx.runner.feed([sdk.init(), sdk.text('and here is what I found'), sdk.result('success')]);
    expect(fx.pushes).toHaveLength(1);
  });

  it('…but a turn that did NOT notify still pushes, exactly as before', async () => {
    const fx = await boot();
    await fx.runner.feed([sdk.init(), sdk.text('all done'), sdk.result('success')]);
    expect(fx.pushes.map(([, body]) => body)).toEqual(['all done']);
  });
});
