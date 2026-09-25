// THE GATE, wired — driven through the REAL Claude backend's real hook.
//
// reversibility.test.ts pins the verb LIST. This file pins the three things
// that only exist once the list is plugged into a session, and that a list test
// can say nothing about:
//
//   1. the gate is a PreToolUse hook and it is registered (Chat mode only);
//   2. a gated call BLOCKS — it emits the same `{t:'question'}` frame ask_user
//      does, and does not return a decision until that question resolves;
//   3. EXPIRY. There is no timer, dismissal denies, and an approval allows.
//
// Everything here goes through the fake SDK harness rather than hand-written
// frames, for the reason the top of chat-voice.test.ts gives: hand-written
// frames have hidden three bugs in this neighbourhood already. The hook is
// invoked the way the live SDK invokes it — out-of-band from the message
// stream (see fakeHook), which is the only way to reach it at all.
//
// The SDK-side facts these tests sit on were LIVE-PROBED against 0.3.220 on
// 2026-09-11, not assumed, because every one of them could have made the gate
// decorative: PreToolUse fires under `permissionMode:'bypassPermissions'` (the
// mode muxpad runs, and the mode that shadows `canUseTool` entirely); an
// `await` inside the hook genuinely holds the tool call (measured to 150 s with
// no default timeout cutting in); and `permissionDecision:'deny'` actually
// prevents execution — the probed command never ran, and its reason came back
// to the model as an error tool_result it reported rather than retried.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Must precede the backend import — constructing it calls query().
vi.mock('@anthropic-ai/claude-agent-sdk', () => import('../test-helpers/fakeAgentSdk.js'));

import { createClaudeBackend } from '../agent-runner/backends/claude.js';
import type { RunnerHost } from '../agent-runner/backends/types.js';
import {
  fakeHook,
  fakeSession,
  hasFakeHook,
  resetFakeAgentSdk,
} from '../test-helpers/fakeAgentSdk.js';
import { sdk } from '../test-helpers/sdkScript.js';
import type { AgentMode, RunnerFrame } from './protocol.js';
import { GATE_NO, GATE_YES } from './reversibility.js';

let dataDir: string;
beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'muxpad-gate-'));
  process.env.MUXPAD_DATA_DIR = dataDir;
  return () => rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  resetFakeAgentSdk();
  delete process.env.MUXPAD_GATE;
});

type Decision = {
  continue?: boolean;
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};

/**
 * Boot a runner with the gate SWITCHED ON.
 *
 * The gate is off by default now (see gateEnabled: `mode === 'chat'` gated
 * typed chat too, where the composer is already the eyeball). These tests are
 * about the MECHANISM — where the hook sits, that it holds, that dismissal
 * fails closed — so they opt in explicitly. The default itself is pinned in
 * reversibility.test.ts, and `MUXPAD_GATE=off` still has its own case below.
 */
function boot(mode: AgentMode = 'chat', gate: 'on' | 'off' | 'unset' = 'on') {
  // 'unset' rather than `undefined`: passing undefined explicitly triggers the
  // PARAMETER DEFAULT, so the case meant to exercise the shipped default was
  // booting with the gate on and asserting the opposite. And `process.env.X =
  // undefined` assigns the STRING "undefined" — the key has to be deleted.
  if (gate === 'unset') delete process.env.MUXPAD_GATE;
  else process.env.MUXPAD_GATE = gate;
  const sent: RunnerFrame[] = [];
  const logs: string[] = [];
  const host: RunnerHost = {
    emit: (f) => void sent.push(f),
    log: (l) => void logs.push(l),
    connected: () => true,
    paneId: 'pane-1',
    apiUrl: 'http://127.0.0.1:1',
  };
  const backend = createClaudeBackend(host, { requestedSid: null, requestedModel: null, mode });
  const session = fakeSession();
  const loop = backend.start().catch(() => {});
  return {
    backend,
    sent,
    logs,
    /** Put a tool call to the gate, exactly as the SDK's PreToolUse does. */
    ask(toolName: string, toolInput: unknown): Promise<Decision> {
      return fakeHook('PreToolUse')({
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: 'toolu_gate',
      }) as Promise<Decision>;
    },
    /** The question the gate is currently blocking on, if any. */
    pending() {
      const asked = sent.filter((f): f is RunnerFrame & { t: 'question' } => f.t === 'question');
      const done = new Set(
        sent.filter((f) => f.t === 'question-done').map((f) => (f as { qid: string }).qid),
      );
      return asked.find((q) => !done.has(q.qid)) ?? null;
    },
    answer(qid: string, picked: string[]) {
      backend.answer(qid, [{ question: 'q', answers: picked }]);
    },
    async settle() {
      await new Promise((r) => setTimeout(r, 20));
    },
    /** Open a turn, the way any real tool call is necessarily inside one. */
    async openTurn() {
      session.push(sdk.text('working on it'));
      await session.settle();
      await new Promise((r) => setTimeout(r, 10));
    },
    async stop() {
      await new Promise<void>((r) => {
        session.end();
        setTimeout(r, 10);
      });
      await loop;
    },
  };
}

const decision = (d: Decision) => d.hookSpecificOutput?.permissionDecision ?? null;

describe('where the gate sits', () => {
  it('is a PreToolUse hook — the surface bypassPermissions leaves working', () => {
    // `canUseTool` is the obvious place and it is unavailable: muxpad runs
    // permissionMode:'bypassPermissions' so no permission prompt can wedge a
    // headless turn, and bypass never consults canUseTool. PreToolUse still
    // fires (live-probed), which is why the gate lives there.
    const fx = boot('chat');
    expect(hasFakeHook('PreToolUse')).toBe(true);
    expect((fakeSession().options as { canUseTool?: unknown }).canUseTool).toBeUndefined();
    expect((fakeSession().options as { permissionMode?: string }).permissionMode).toBe(
      'bypassPermissions',
    );
    return fx.stop();
  });

  it('is NOT registered in Agent mode — that face is documented as raw', async () => {
    const fx = boot('agent');
    expect(hasFakeHook('PreToolUse')).toBe(false);
    await fx.stop();
  });

  it('is not registered at all when MUXPAD_GATE=off', async () => {
    const fx = boot('chat', 'off');
    expect(hasFakeHook('PreToolUse')).toBe(false);
    await fx.stop();
  });

  it('…nor by DEFAULT, which is the whole point of the correction', async () => {
    // Being asked to approve a delete or a push you just typed is not safety;
    // it trains you to tap through. See gateEnabled.
    const fx = boot('chat', 'unset');
    expect(hasFakeHook('PreToolUse')).toBe(false);
    await fx.stop();
  });
});

describe('a REVERSIBLE action is not interrupted', () => {
  it('sails through with no question, no frame, no pause', async () => {
    // The whole promise of Chat mode. A gate that fires here is a gate people
    // learn to tap through without reading.
    const fx = boot('chat');
    for (const cmd of ['pnpm -C server test', 'git status --short', 'rm -rf node_modules']) {
      const d = await fx.ask('Bash', { command: cmd });
      expect(d.continue).toBe(true);
      expect(decision(d)).toBeNull();
    }
    expect(fx.sent.filter((f) => f.t === 'question')).toHaveLength(0);
    await fx.stop();
  });

  it('returns synchronously enough that nothing is waiting on a human', async () => {
    const fx = boot('chat');
    const before = Date.now();
    await fx.ask('Read', { file_path: '/Users/me/.ssh/id_rsa' });
    expect(Date.now() - before).toBeLessThan(50);
    await fx.stop();
  });
});

describe('a GATED action stops and asks', () => {
  it('does not decide until the user answers', async () => {
    const fx = boot('chat');
    let settled = false;
    const pending = fx.ask('Bash', { command: 'git push origin main' }).then((d) => {
      settled = true;
      return d;
    });
    await fx.settle();
    // The hook is still inside its await. This is the property that makes the
    // gate a gate rather than a notification.
    expect(settled).toBe(false);
    const q = fx.pending();
    expect(q).not.toBeNull();
    expect(q?.questions[0]?.header).toBe('Push');
    // The exact command is shown — the user approves a thing, not a category.
    expect(q?.questions[0]?.options[0]?.description).toBe('git push origin main');
    fx.answer(q?.qid as string, [GATE_YES]);
    expect(decision(await pending)).toBe('allow');
    await fx.stop();
  });

  it('reuses ask_user’s question frame, so the pane goes `blocked` for free', async () => {
    // No second approval UI: the same frame the server already turns into the
    // blocked status, the push, and the re-delivery on reconnect.
    const fx = boot('chat');
    const pending = fx.ask('Bash', { command: 'muxpad pane send 3 "rm -rf ~"' });
    await fx.settle();
    const q = fx.pending();
    expect(q?.questions).toHaveLength(1);
    expect(q?.questions[0]?.multiSelect).toBe(false);
    expect(q?.questions[0]?.options.map((o) => o.label)).toEqual([GATE_YES, GATE_NO]);
    fx.answer(q?.qid as string, [GATE_NO]);
    await pending;
    // …and the question is retired, so the blocked state cannot outlive it.
    expect(fx.sent.some((f) => f.t === 'question-done')).toBe(true);
    await fx.stop();
  });

  it('DENIES on no, with a reason aimed at the model', async () => {
    const fx = boot('chat');
    const pending = fx.ask('Bash', { command: 'gh pr merge 14 --squash' });
    await fx.settle();
    fx.answer(fx.pending()?.qid as string, [GATE_NO]);
    const d = await pending;
    expect(decision(d)).toBe('deny');
    expect(d.hookSpecificOutput?.permissionDecisionReason).toMatch(/declined/i);
    expect(d.hookSpecificOutput?.permissionDecisionReason).toMatch(/do not retry/i);
    await fx.stop();
  });

  it('forwards a TYPED correction as the denial reason', async () => {
    // The user typing "not to main — use a branch" is worth more than a tap.
    // Throwing it away would make the agent guess at what went wrong.
    const fx = boot('chat');
    const pending = fx.ask('Bash', { command: 'git push origin main' });
    await fx.settle();
    fx.answer(fx.pending()?.qid as string, ['not to main — use a branch']);
    const d = await pending;
    expect(decision(d)).toBe('deny');
    expect(d.hookSpecificOutput?.permissionDecisionReason).toContain('not to main — use a branch');
    await fx.stop();
  });

  it('logs the gate so a parked turn is auditable from the pane', async () => {
    const fx = boot('chat');
    const pending = fx.ask('Bash', { command: 'git push' });
    await fx.settle();
    expect(fx.logs.some((l) => l.includes('gate') && l.includes('will not time out'))).toBe(true);
    fx.answer(fx.pending()?.qid as string, [GATE_YES]);
    await pending;
    await fx.stop();
  });
});

describe('EXPIRY — an unanswered gate does not quietly become a no', () => {
  it('waits indefinitely rather than lapsing', async () => {
    // Grok Bot's approval cards expire into DENIAL while the push that was
    // meant to summon you fails to arrive, so unattended work dies silently and
    // you never learn you were asked. Here the turn just parks: the pane sits
    // `blocked` (top precedence in the nav), the push has already fired, and
    // the question is re-delivered to every client that reconnects. A parked
    // turn is visible; a silently denied one is not.
    const fx = boot('chat');
    let settled = false;
    const pending = fx.ask('Bash', { command: 'git push' }).then((d) => {
      settled = true;
      return d;
    });
    // Far longer than any approval-card timeout, and nothing has decided.
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    expect(fx.pending()).not.toBeNull();
    // It is still answerable, and the answer still lands.
    fx.answer(fx.pending()?.qid as string, [GATE_YES]);
    expect(decision(await pending)).toBe('allow');
    await fx.stop();
  });

  it('survives a client reconnect — the question is re-delivered, not lost', async () => {
    const fx = boot('chat');
    const pending = fx.ask('Bash', { command: 'npm publish' });
    await fx.settle();
    const first = fx.pending();
    fx.sent.length = 0;
    fx.backend.onConnected();
    const redelivered = fx.sent.filter((f) => f.t === 'question');
    expect(redelivered).toHaveLength(1);
    expect((redelivered[0] as { qid: string }).qid).toBe(first?.qid);
    fx.answer(first?.qid as string, [GATE_NO]);
    await pending;
    await fx.stop();
  });

  it('Stop resolves it as a DENY — dismissal fails closed', async () => {
    // A gate can only fire inside a turn, so the turn is opened here the way
    // the SDK opens one: the first main-thread message of any kind.
    const fx = boot('chat');
    await fx.openTurn();
    const pending = fx.ask('Bash', { command: 'git push' });
    await fx.settle();
    fx.backend.stop();
    const d = await pending;
    expect(decision(d)).toBe('deny');
    await fx.stop();
  });

  it('shutdown resolves it as a DENY too', async () => {
    const fx = boot('chat');
    const pending = fx.ask('Bash', { command: 'gh release create v9' });
    await fx.settle();
    fx.backend.shutdown();
    expect(decision(await pending)).toBe('deny');
    await fx.stop();
  });

  it('the SDK aborting the hook is also a DENY, never a pass', async () => {
    // Belt to the braces: the live SDK did NOT cut a 150 s hook off, but if a
    // future one does, it has stopped waiting for our decision — and the only
    // safe thing to return then is no.
    const fx = boot('chat');
    const ac = new AbortController();
    const pending = fakeHook('PreToolUse')(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        tool_use_id: 'toolu_gate',
      },
      undefined,
      { signal: ac.signal },
    ) as Promise<Decision>;
    await fx.settle();
    ac.abort();
    expect(decision(await pending)).toBe('deny');
    await fx.stop();
  });

  it('sets an explicit hook timeout so no SDK DEFAULT can answer for the user', async () => {
    // The contract is "no expiry". This number exists only so a future SDK
    // default cannot silently become the decision.
    const fx = boot('chat');
    const matcher = (
      fakeSession().options as { hooks?: { PreToolUse?: Array<{ timeout?: number }> } }
    ).hooks?.PreToolUse?.[0];
    expect(matcher?.timeout ?? 0).toBeGreaterThan(86_400);
    await fx.stop();
  });
});
