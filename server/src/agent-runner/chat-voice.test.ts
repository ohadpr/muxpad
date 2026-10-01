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
import {
  fakeMcpTool,
  fakeSession,
  mcpExtra,
  resetFakeAgentSdk,
} from '../test-helpers/fakeAgentSdk.js';
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
    /** Call `reply` exactly as the SDK would — including the MCP `extra` that
     *  carries the tool_use id — and feed the two messages the transcript gets
     *  for it. */
    async reply(text: string, toolUseId = `toolu_r${Math.random().toString(36).slice(2, 8)}`) {
      await this.feed([sdk.replyToolUse(toolUseId, text)]);
      const res = await fakeMcpTool('reply').handler({ text } as never, mcpExtra(toolUseId));
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

  it('is NOT registered in AGENT mode — agent mode is raw', async () => {
    // It used to be registered in both modes, described as inert in Agent,
    // because mcpServers is fixed at query() construction and a mid-session
    // switch cannot add tools. Measured against a live Opus, that cost more
    // than it bought: 3 of 5 Agent turns called it anyway and then wrote a
    // closing recap for an audience they believed could not see them, so the
    // user read the same answer twice, the second time in the third person.
    // Re-wording the description to "do not call me" took that to 0 of 7 — but
    // a description is a request, and not offering the tool is a guarantee.
    const fx = boot('agent');
    expect(() => fakeMcpTool('reply')).toThrow();
    // The other two muxpad tools are mode-independent and stay.
    expect(() => fakeMcpTool('ask_user')).not.toThrow();
    expect(() => fakeMcpTool('show_files')).not.toThrow();
    await fx.stop();
  });

  it('exposes the description as a pure function, so the contract can be pinned', () => {
    const d = replyToolDescription();
    expect(d).toMatch(/only voice/i);
    // The closing-summary rule used to be spelled "do not write a closing
    // summary of what you just said". Its own test comment recorded that it
    // MEASURED ZERO — the fold is what actually stopped the recap — and
    // Anthropic documents negative instructions as underperforming, so it is
    // now stated as the fact it rests on: the turn ends with the last reply.
    expect(d).toMatch(/your reply ends the turn/i);
    // CADENCE, not just length. "Two to four short texts" measured a median of
    // THREE replies per turn at ~1,600 chars each on a live session — the model
    // reported every subagent as it returned, so the user got a stream of walls
    // while the work was still running. One reply, at the end.
    expect(d).toMatch(/send one reply/i);
    expect(d).toMatch(/not as you go/i);
    // A tool description is a system-prompt-strength instruction, so the three
    // levers that actually shorten a reply all have to be IN it — not only in
    // the mode overlay, which competes with the harness's own prompt.
    expect(d).toMatch(/screen already shows/i); // what the UI renders for free
    expect(d).toMatch(/one to three lines/i); // the positive budget
    expect(d).toMatch(/whole turn/i); // …bounded per TURN, not per message
    expect(d).toMatch(/one claim, not a survey/i); // the shape rule that bit
    expect(d).toMatch(/in full when it matters/i); // the named exemptions
    // Exemplars must AGREE with the budget, or they are what gets copied.
    const shown = d.split('Real replies look like:')[1] ?? '';
    const examples = [...shown.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string).slice(0, 3);
    expect(examples).toHaveLength(3);
    for (const ex of examples) expect(ex.length).toBeLessThanOrEqual(120);
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

  // ── THE GUARD IS ALSO A VOICE PATH, AND IT USED NOT TO BE ─────────────────
  // The guard's two outputs were the pane log and the push body. Neither is
  // audible. `speak`/`speak-delta` are the ONLY frames a voice session turns
  // into speech (speak-bridge.ts's allow-list; `stream` is deliberately
  // nothing, being the suppressed scratchpad), and they exist only inside the
  // reply tool — so a turn that ended with zero replies went out over a live
  // voice session as SILENCE, with a `turn-done ok:true` that says nothing
  // aloud. The user asked a question out loud, heard nothing back, and kept
  // billing OpenAI minutes until the session's TTL.
  //
  // It is not a rare shape either: a pane switched Agent→Chat mid-session has
  // NO reply tool at all (mcpServers is fixed at query() construction), so
  // every one of its turns is a zero-reply turn — and the mic is offered
  // anyway, because the UI reads the pane's mode off the row.
  it('SPEAKS the promoted text — a voice session must not hear silence', async () => {
    const fx = boot('chat');
    await fx.send('where did the invoice go');
    await fx.feed([
      sdk.text('Checking the folder first.'),
      sdk.text('Filed it under ~/Documents/Invoices/2026-09.pdf.'),
      sdk.result('success'),
    ]);
    expect(guardFired(fx.logs)).toBe(true);
    // Exactly one, carrying exactly what was promoted — the same text the push
    // quotes and the same text the chat renders from the transcript.
    expect(speaks(fx.sent).map((f) => f.text)).toEqual([
      'Filed it under ~/Documents/Invoices/2026-09.pdf.',
    ]);
    await fx.stop();
  });

  it('speaks BEFORE the turn ends, so the turn-done is not the last word', async () => {
    const fx = boot('chat');
    await fx.send('status?');
    await fx.feed([sdk.text('All three services are up.'), sdk.result('success')]);
    const kinds = fx.sent.map((f) => f.t);
    expect(kinds.indexOf('speak')).toBeGreaterThan(-1);
    expect(kinds.indexOf('speak')).toBeLessThan(kinds.lastIndexOf('turn-done'));
    await fx.stop();
  });

  it('the promoted speech carries the TRANSCRIPT identity of the text it promoted', async () => {
    // Same id the rendered bubble gets (`<message uuid>:<block index>`), so a
    // consumer can tie the two together — and so a client-side backstop for
    // OLD runners (which emit no frame at all) dedupes against this one rather
    // than saying the answer twice.
    const fx = boot('chat');
    const msg = sdk.text('Done — 3 files changed.');
    await fx.send('ship it');
    await fx.feed([msg, sdk.result('success')]);
    expect(speaks(fx.sent)[0]?.id).toBe(`${(msg as { uuid: string }).uuid}:0`);
    await fx.stop();
  });

  it('promotes NOTHING when there is nothing to fall back on', async () => {
    // No prose, no reply: there is nothing honest to say, and an empty speak
    // frame would be a voice session clearing its throat at silence.
    const fx = boot('chat');
    await fx.send('do the thing');
    await fx.feed([sdk.result('success')]);
    expect(speaks(fx.sent)).toHaveLength(0);
    await fx.stop();
  });

  it('never promotes over a turn that spoke for itself', async () => {
    // The promotion exists because `replies === 0`; a turn that replied must
    // emit its replies and nothing else, or every answer is said twice.
    const fx = boot('chat');
    await fx.send('file the invoice');
    await fx.feed([sdk.text('scratchpad, private')]);
    await fx.reply('~/Documents/Invoices/2026-09.pdf');
    await fx.feed([sdk.result('success')]);
    expect(speaks(fx.sent).map((f) => f.text)).toEqual(['~/Documents/Invoices/2026-09.pdf']);
    await fx.stop();
  });

  it('does not promote a STOPPED or FAILED turn into speech', async () => {
    // Silence after Stop is what was asked for, and a failure already speaks
    // as a failed turn-done (which the voice bridge does say aloud).
    const stopped = boot('chat');
    await stopped.send('long job');
    await stopped.feed([sdk.text('half-finished thought')]);
    stopped.backend.stop();
    await stopped.feed([sdk.result('success')]);
    expect(speaks(stopped.sent)).toHaveLength(0);
    await stopped.stop();

    const failed = boot('chat');
    await failed.send('long job');
    await failed.feed([sdk.text('half-finished thought'), sdk.result('error_during_execution')]);
    expect(speaks(failed.sent)).toHaveLength(0);
    await failed.stop();
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

// ───────────────────────────────────────────────────────────────────────────
// SPEECH ON THE WIRE — the frame a voice layer listens on.
//
// This is the half the reply tool used to be missing. A reply reached an open
// chat exactly one way — the transcript, tailed every 250 ms — and that path
// cannot serve speech, because the reply is only IN the transcript once the
// whole tool_use block has finished generating. A voice turn could not open
// its mouth until the agent had stopped talking.
//
// The frames here fix the latency. The property that must NOT break while they
// do it is the one the old no-frame comment was protecting: a reply renders
// exactly once, from the transcript. Which is why `speak` is a DISTINCT KIND
// the chat UI has no branch for, rather than a second delivery on `stream`
// (the scratchpad, suppressed on purpose) or a dedupe rule two sides have to
// keep agreeing on.
// ───────────────────────────────────────────────────────────────────────────

const speaks = (sent: RunnerFrame[]) =>
  sent.filter((f): f is RunnerFrame & { t: 'speak' } => f.t === 'speak');
const speakDeltas = (sent: RunnerFrame[]) =>
  sent.filter((f): f is RunnerFrame & { t: 'speak-delta' } => f.t === 'speak-delta');

describe('a reply reaches the wire the moment it exists', () => {
  it('emits ONE speak frame per reply, carrying its text', async () => {
    const fx = boot('chat');
    await fx.send('where did it go');
    await fx.reply('~/Documents/Invoices/2026-09.pdf');
    await fx.feed([sdk.result('success')]);
    expect(speaks(fx.sent)).toHaveLength(1);
    expect(speaks(fx.sent)[0]?.text).toBe('~/Documents/Invoices/2026-09.pdf');
    await fx.stop();
  });

  it('carries the reply’s TRANSCRIPT identity, so a consumer can correlate', async () => {
    // The id is the tool_use id — the same thing normalizeTranscriptLine
    // derives the rendered event's id from. Read out of MCP's `_meta`, which
    // is where the live SDK puts it.
    const fx = boot('chat');
    await fx.send('hi');
    await fx.reply('done', 'toolu_01ABCDEF');
    expect(speaks(fx.sent)[0]?.id).toBe('toolu_01ABCDEF');
    await fx.stop();
  });

  it('still speaks when the SDK gives no id — a rename costs correlation, not the reply', async () => {
    const fx = boot('chat');
    await fx.send('hi');
    // No `extra` at all: the shape an older/newer SDK might hand us.
    await fx.feed([sdk.replyToolUse('toolu_x', 'shipped')]);
    await fakeMcpTool('reply').handler({ text: 'shipped' } as never);
    expect(speaks(fx.sent)).toHaveLength(1);
    expect(speaks(fx.sent)[0]?.text).toBe('shipped');
    expect(speaks(fx.sent)[0]?.id).toBeTruthy();
    await fx.stop();
  });

  it('numbers the replies of a turn, so a consumer can speak them in order', async () => {
    const fx = boot('chat');
    await fx.send('count the words');
    await fx.reply('848 words across 6 files.');
    await fx.reply('One note: the calls ran in parallel.');
    await fx.feed([sdk.result('success')]);
    expect(speaks(fx.sent).map((f) => f.n)).toEqual([1, 2]);
    await fx.stop();
  });

  it('an EMPTY reply is not speech', async () => {
    const fx = boot('chat');
    await fx.send('hi');
    await fakeMcpTool('reply').handler({ text: '   ' } as never, mcpExtra('toolu_blank'));
    expect(speaks(fx.sent)).toHaveLength(0);
    await fx.stop();
  });
});

describe('speech STARTS before the reply is finished', () => {
  // The whole reason the frame exists. These chunks are the live-probed
  // fragmentation of one reply's tool argument (see sdk.replyStream).
  const CHUNKS = [
    '',
    '{"text": "Landed in',
    ' ~/Documents/',
    'Invoices/2',
    '026-09.',
    'pdf — \\"quoted',
    '\\" and a new',
    'line',
    '\\nhere."}',
  ];

  it('forwards the argument deltas as they arrive, under the reply’s id', async () => {
    const fx = boot('chat');
    await fx.send('where did it go');
    await fx.feed(sdk.replyStream('toolu_01STREAM', CHUNKS));
    const deltas = speakDeltas(fx.sent);
    expect(deltas.length).toBeGreaterThan(1);
    expect(new Set(deltas.map((d) => d.id))).toEqual(new Set(['toolu_01STREAM']));
    // Concatenating them yields the reply, JSON escapes decoded.
    expect(deltas.map((d) => d.delta).join('')).toBe(
      'Landed in ~/Documents/Invoices/2026-09.pdf — "quoted" and a newline\nhere.',
    );
    await fx.stop();
  });

  it('the first delta lands BEFORE the tool call runs — that is the entire point', async () => {
    const fx = boot('chat');
    await fx.send('where did it go');
    await fx.feed(sdk.replyStream('toolu_01STREAM', CHUNKS));
    // Not one `speak` yet: the handler has not been invoked.
    expect(speaks(fx.sent)).toHaveLength(0);
    expect(speakDeltas(fx.sent).length).toBeGreaterThan(0);
    const firstDeltaAt = fx.sent.findIndex((f) => f.t === 'speak-delta');
    await fakeMcpTool('reply').handler(
      { text: 'Landed in ~/Documents/Invoices/2026-09.pdf' } as never,
      mcpExtra('toolu_01STREAM'),
    );
    const speakAt = fx.sent.findIndex((f) => f.t === 'speak');
    expect(firstDeltaAt).toBeGreaterThanOrEqual(0);
    expect(speakAt).toBeGreaterThan(firstDeltaAt);
    await fx.stop();
  });

  it('does NOT mistake another tool’s arguments for speech', async () => {
    // A voice layer reading a Bash command aloud is the failure this prevents.
    const fx = boot('chat');
    await fx.send('clean up');
    await fx.feed([
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} },
        },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"command": "rm -rf /"}' },
        },
      },
    ]);
    expect(speakDeltas(fx.sent)).toHaveLength(0);
    await fx.stop();
  });

  it('a SUBAGENT’s reply stream is not this session’s speech', async () => {
    const fx = boot('chat');
    await fx.send('go');
    const child = sdk
      .replyStream('toolu_child', ['{"text": "from a subagent"}'])
      .map((m) => ({ ...m, parent_tool_use_id: 'toolu_parent' }));
    await fx.feed(child);
    expect(speakDeltas(fx.sent)).toHaveLength(0);
    await fx.stop();
  });
});

describe('the frames cannot double-render a reply', () => {
  it('speech NEVER rides the `stream` kind — that is the suppressed scratchpad', async () => {
    // The Chat UI hides `stream` on purpose (plain text is the private
    // scratchpad in Chat mode). Putting a reply on it would be invisible here
    // and a duplicate bubble anywhere that does render it.
    const fx = boot('chat');
    await fx.send('hi');
    await fx.feed(sdk.replyStream('toolu_s', ['{"text": "spoken"}']));
    await fx.reply('spoken', 'toolu_s2');
    expect(fx.sent.filter((f) => f.t === 'stream')).toHaveLength(0);
    await fx.stop();
  });

  it('a reply produces speech frames and NOTHING that the chat renders', async () => {
    // The kinds a chat client draws a message from are `stream` (scratchpad,
    // suppressed) and the transcript `events` batch the server sends — never a
    // runner frame. So the exhaustive check is: the runner's output for a
    // replying turn contains only turn lifecycle + speech.
    const fx = boot('chat');
    await fx.send('hi');
    await fx.feed(sdk.replyStream('toolu_s', ['{"text": "done"}']));
    await fx.reply('done', 'toolu_s');
    await fx.feed([sdk.result('success')]);
    const kinds = new Set(fx.sent.map((f) => f.t));
    // Decoration, not conversation: the header meter and the self-generated
    // pane title. Neither can put a bubble in the thread.
    kinds.delete('status');
    kinds.delete('title');
    expect(kinds).toEqual(new Set(['turn-start', 'speak-delta', 'speak', 'turn-done']));
    await fx.stop();
  });

  it('plain assistant text still streams as `stream`, and is never speech', async () => {
    // The scratchpad path must be untouched: it is how the mid-turn reconnect
    // preview and the Agent-mode voice work.
    const fx = boot('chat');
    await fx.send('hi');
    await fx.feed([sdk.textStream('thinking out loud')]);
    expect(fx.sent.filter((f) => f.t === 'stream')).toHaveLength(1);
    expect(speaks(fx.sent)).toHaveLength(0);
    expect(speakDeltas(fx.sent)).toHaveLength(0);
    await fx.stop();
  });

  it('AGENT mode has no reply tool, so it emits no speech at all', async () => {
    const fx = boot('agent');
    await fx.send('hi');
    await fx.feed([sdk.text('Filed it.'), sdk.result('success')]);
    expect(speaks(fx.sent)).toHaveLength(0);
    await fx.stop();
  });
});
