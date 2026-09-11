// CHAT MODE'S VOICE, driven through the REAL Claude backend.
//
// The thing under test is a rule about TURNS, and a turn only exists inside
// claude.ts's `for await (const msg of session)` loop — which no test could
// reach until the fake SDK harness existed. Hand-written frames hid three
// earlier bugs in this file's neighbourhood (see subagent-leak.test.ts), so
// everything here goes through scripted SDK messages into the real backend,
// with the real in-process `reply` tool invoked the way the live SDK invokes
// it: out-of-band from the message stream.
//
// The property that matters, stated once: A USER WHO SENT A MESSAGE MUST NEVER
// GET SILENCE. xAI's Grok Bot spends ~800 prompt words asking for that and
// still ships the bug. It is decided here, in code, at the turn-result
// boundary.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPLY_ACK,
  REPLY_TOOL_NAME,
  normalizeTranscriptLine,
  renderCronMarker,
} from '@muxpad/shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Must precede the fakeRunner import — constructing the backend calls query().
vi.mock('@anthropic-ai/claude-agent-sdk', () => import('../test-helpers/fakeAgentSdk.js'));

import { createClaudeBackend, replyToolDescription } from '../agent-runner/backends/claude.js';
import type { RunnerHost } from '../agent-runner/backends/types.js';
import { fakeMcpTool, fakeSession, resetFakeAgentSdk } from '../test-helpers/fakeAgentSdk.js';
import { sdk } from '../test-helpers/sdkScript.js';
import type { AgentMode, RunnerFrame } from './protocol.js';

// The backend reads agent-instructions.md / chat-mode.md from the data dir at
// construction and would otherwise touch the real ~/.muxpad.
let dataDir: string;
beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'muxpad-chat-voice-'));
  process.env.MUXPAD_DATA_DIR = dataDir;
  return () => rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => resetFakeAgentSdk());

/**
 * The backend on its own — no socket, no server. The reply guard is entirely a
 * runner-side decision (its outputs are the pane log and the turn-done
 * summary), so the ws hop would add latency and flake without adding coverage.
 * subagent-leak.test.ts already pins the full runner→server path.
 */
function boot(mode: AgentMode = 'chat') {
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
    async feed(messages: unknown[]) {
      for (const m of messages) session.push(m);
      await session.settle();
      await new Promise((r) => setTimeout(r, 10));
    },
    /** Call `reply` exactly as the SDK would, and feed the two messages the
     *  transcript gets for it. */
    async reply(text: string, toolUseId = `toolu_r${Math.random().toString(36).slice(2, 8)}`) {
      await this.feed([sdk.replyToolUse(toolUseId, text)]);
      const res = await fakeMcpTool('reply').handler({ text } as never);
      await this.feed([sdk.replyAck(toolUseId)]);
      return res;
    },
    /** A user send, awaited far enough for the queue to yield it. */
    async send(text: string) {
      backend.send(text);
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

const turnDone = (sent: RunnerFrame[]) =>
  sent.filter((f): f is RunnerFrame & { t: 'turn-done' } => f.t === 'turn-done');
const guardFired = (logs: string[]) => logs.some((l) => l.includes('no reply'));

describe('the reply tool is registered, and it is the voice', () => {
  it('is offered to the model alongside ask_user and show_files', async () => {
    const fx = boot('chat');
    expect(() => fakeMcpTool('reply')).not.toThrow();
    expect(fakeMcpTool('reply').description).toMatch(/only voice/i);
    await fx.stop();
  });

  it('is registered in AGENT mode too — a mid-session switch cannot add tools', async () => {
    // `mcpServers` is fixed at query() construction exactly like `systemPrompt`
    // (agent-modes.ts). A pane that launched in Agent mode and was switched to
    // Chat would otherwise be a Chat session with no voice at all.
    const fx = boot('agent');
    expect(() => fakeMcpTool('reply')).not.toThrow();
    await fx.stop();
  });

  it('…but AGENT mode is told the tool is inert there, not that text is private', async () => {
    // Measured against a live Opus: with the Chat-mode wording in both modes,
    // three of five Agent-mode turns called `reply` and the user read the
    // answer twice — once as the reply, then again as the third-person recap
    // the model wrote believing nobody would see it. With this wording, zero
    // of seven did. A tool description is a system-prompt-strength
    // instruction; in Agent mode "your plain text is a private scratchpad" is
    // simply false.
    const fx = boot('agent');
    const desc = fakeMcpTool('reply').description;
    expect(desc).toMatch(/AGENT MODE/);
    expect(desc).toMatch(/do not call this tool/i);
    expect(desc).not.toMatch(/your ONLY voice/i);
    await fx.stop();
  });

  it('exposes the two descriptions as a pure function, so both can be pinned', () => {
    expect(replyToolDescription('chat')).toMatch(/only voice/i);
    // The closing-summary rule: a live model ended almost every Chat turn with
    // "Done — reported to the user…", written to an audience it knew could not
    // read it.
    expect(replyToolDescription('chat')).toMatch(/do not write a closing summary/i);
    expect(replyToolDescription('agent')).toMatch(/sees it twice/i);
  });

  it('hands back the fixed ack sentinel the normalizer recognises', async () => {
    const fx = boot('chat');
    const res = (await fakeMcpTool('reply').handler({ text: 'shipped' } as never)) as {
      content: Array<{ text: string }>;
    };
    expect(res.content[0]?.text).toBe(REPLY_ACK);
    await fx.stop();
  });

  it('a reply renders as a user-facing MESSAGE, not a tool row', () => {
    // The normalizer is what every reader of a transcript goes through — the
    // web chat, the archive indexer, `muxpad agent transcript`.
    const [event] = normalizeTranscriptLine({
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-09-11T00:00:00.000Z',
      message: {
        model: 'claude-opus-4-8',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: REPLY_TOOL_NAME, input: { text: 'ok' } },
        ],
      },
    });
    expect(event).toMatchObject({ kind: 'assistant', text: 'ok', voice: 'reply' });
  });

  it('MULTIPLE replies in one turn render as separate messages', () => {
    const events = normalizeTranscriptLine({
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-09-11T00:00:00.000Z',
      message: {
        model: 'claude-opus-4-8',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: REPLY_TOOL_NAME,
            input: { text: 'Landed in ~/Docs.' },
          },
          { type: 'tool_use', id: 't2', name: REPLY_TOOL_NAME, input: { text: 'Want the diff?' } },
        ],
      },
    });
    expect(events.map((e) => (e as { text: string }).text)).toEqual([
      'Landed in ~/Docs.',
      'Want the diff?',
    ]);
    // Distinct ids — they are two React rows, two scroll anchors, two search
    // targets. One welded paragraph is exactly what this is not.
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it("the reply's ack is dropped — no orphan tool row under every message", () => {
    expect(
      normalizeTranscriptLine({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-09-11T00:00:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: REPLY_ACK }],
            },
          ],
        },
      }),
    ).toEqual([]);
  });
});

describe('THE GUARD — a human-initiated turn never ends in silence', () => {
  it('fires when a human-initiated Chat turn ends with zero replies', async () => {
    const fx = boot('chat');
    await fx.send('file the invoice');
    await fx.feed([
      sdk.text('The user wants the invoice filed. I will check the folder first.'),
      sdk.text('Filed it under ~/Documents/Invoices/2026-09.pdf.'),
      sdk.result('success'),
    ]);
    expect(guardFired(fx.logs)).toBe(true);
    // …and the fallback is the turn's FINAL text, verbatim — never invented,
    // never summarised.
    expect(turnDone(fx.sent).at(-1)?.summary).toBe(
      'Filed it under ~/Documents/Invoices/2026-09.pdf.',
    );
    await fx.stop();
  });

  it('does NOT fire when the turn actually replied', async () => {
    const fx = boot('chat');
    await fx.send('file the invoice');
    await fx.feed([sdk.text('private reasoning about where it goes')]);
    await fx.reply('~/Documents/Invoices/2026-09.pdf');
    await fx.feed([sdk.result('success')]);
    expect(guardFired(fx.logs)).toBe(false);
    // The push body is what was SPOKEN, not the scratchpad that preceded it.
    expect(turnDone(fx.sent).at(-1)?.summary).toBe('~/Documents/Invoices/2026-09.pdf');
    await fx.stop();
  });

  it('the push body quotes the FIRST reply of a multi-reply turn, not the last', async () => {
    // The contract asks for two to four quick texts that LEAD with the
    // outcome, so the trailing one is routinely the caveat. Measured on live
    // turns: "848 words total across 6 files" followed by "one note: the calls
    // ran in parallel" — and the notification used to buzz with the note.
    const fx = boot('chat');
    await fx.send('count the words');
    await fx.reply('848 words total across 6 files.');
    await fx.reply('One note: the calls ran in parallel, so the sleeps overlapped.');
    await fx.feed([sdk.result('success')]);
    expect(turnDone(fx.sent).at(-1)?.summary).toBe('848 words total across 6 files.');
    await fx.stop();
  });

  it('does NOT fire for a SELF-INITIATED turn — a wakeup may end silent', async () => {
    // No send at all: the first stream message opens the turn (a cron fire, a
    // background subagent finishing, a scheduled wakeup). Nobody is waiting.
    const fx = boot('chat');
    await fx.feed([sdk.text('background sweep found nothing'), sdk.result('success')]);
    expect(turnDone(fx.sent)).toHaveLength(1);
    expect(guardFired(fx.logs)).toBe(false);
    await fx.stop();
  });

  it('does NOT fire for a CRON fire, which is a relay and not a person', async () => {
    const fx = boot('chat');
    await fx.send(
      renderCronMarker(
        { id: 'c1', name: 'pr-sweep', at: Date.parse('2026-09-11T09:00:00Z'), missed: 0 },
        'sweep the PRs',
      ),
    );
    await fx.feed([sdk.text('nothing to report'), sdk.result('success')]);
    expect(guardFired(fx.logs)).toBe(false);
    await fx.stop();
  });

  it('does NOT fire in AGENT mode — plain text is the voice there', async () => {
    const fx = boot('agent');
    await fx.send('file the invoice');
    await fx.feed([sdk.text('Filed it.'), sdk.result('success')]);
    expect(guardFired(fx.logs)).toBe(false);
    expect(turnDone(fx.sent).at(-1)?.summary).toBe('Filed it.');
    await fx.stop();
  });

  it('does NOT fire when the user pressed Stop — silence is what they asked for', async () => {
    const fx = boot('chat');
    await fx.send('do the long thing');
    await fx.feed([sdk.text('starting')]);
    fx.backend.stop();
    await new Promise((r) => setTimeout(r, 10));
    await fx.feed([sdk.result('success')]);
    expect(guardFired(fx.logs)).toBe(false);
    await fx.stop();
  });

  it('does NOT fire on a FAILED turn — the error is already the answer', async () => {
    const fx = boot('chat');
    await fx.send('do the thing');
    await fx.feed([sdk.text('trying'), sdk.result('error_during_execution')]);
    expect(guardFired(fx.logs)).toBe(false);
    await fx.stop();
  });

  it('does NOT fire for a slash command — that talks to the session, not the agent', async () => {
    const fx = boot('chat');
    fx.backend.slash('compact');
    await new Promise((r) => setTimeout(r, 10));
    await fx.feed([sdk.text('compacted'), sdk.result('success')]);
    expect(guardFired(fx.logs)).toBe(false);
    await fx.stop();
  });

  it('says so plainly when there is nothing at all to fall back on', async () => {
    // A turn that produced no prose AND no reply. There is nothing honest to
    // show, so the harness records the miss rather than inventing a sentence.
    const fx = boot('chat');
    await fx.send('do the thing');
    await fx.feed([sdk.result('success')]);
    expect(fx.logs.some((l) => l.includes('nothing to fall back on'))).toBe(true);
    expect(turnDone(fx.sent).at(-1)?.summary).toBeUndefined();
    await fx.stop();
  });

  it('re-arms per turn: a replying turn does not excuse the next silent one', async () => {
    const fx = boot('chat');
    await fx.send('first');
    await fx.reply('done, in ~/a.txt');
    await fx.feed([sdk.result('success')]);
    expect(guardFired(fx.logs)).toBe(false);

    await fx.send('second');
    await fx.feed([sdk.text('I should tell them about this.'), sdk.result('success')]);
    expect(guardFired(fx.logs)).toBe(true);
    expect(turnDone(fx.sent).at(-1)?.summary).toBe('I should tell them about this.');
    await fx.stop();
  });

  it('the working indicator still lights for a turn that says nothing until the end', async () => {
    // The behaviour change makes long silent stretches NORMAL, so the one
    // thing that must not regress is the evidence that anything is happening.
    const fx = boot('chat');
    await fx.send('do the thing');
    expect(fx.sent.filter((f) => f.t === 'turn-start')).toHaveLength(1);
    await fx.feed([sdk.result('success')]);
    expect(fx.sent.filter((f) => f.t === 'turn-done')).toHaveLength(1);
    await fx.stop();
  });
});
