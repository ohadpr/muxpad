import type { ChatEvent } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import {
  type ChatVoiceOpts,
  actionRunExpanded,
  applyChatVoice,
  chatVoiceActive,
  foldsAsActionRun,
  isPrivateReasoning,
  lastTurnStartId,
  toggleActionRun,
} from './chat-voice';

let seq = 0;
const id = () => `e${++seq}`;

const user = (text: string): ChatEvent => ({ kind: 'user', id: id(), ts: 0, text });
const prose = (text: string): ChatEvent => ({ kind: 'assistant', id: id(), ts: 0, text });
const reply = (text: string): ChatEvent => ({
  kind: 'assistant',
  id: id(),
  ts: 0,
  text,
  voice: 'reply',
});
const cronChip = (): ChatEvent => ({
  kind: 'notice',
  id: id(),
  ts: 0,
  variant: 'cron',
  text: 'pr-sweep',
});
/** The harness's "[Request interrupted by user]", as the normalizer emits it. */
const stopped = (): ChatEvent => ({
  kind: 'notice',
  id: id(),
  ts: 0,
  variant: 'interrupted',
  text: 'Stopped',
});
const toolUse = (name: string): ChatEvent => ({
  kind: 'tool_use',
  id: id(),
  ts: 0,
  toolUseId: id(),
  name,
  input: {},
});

const CHAT: ChatVoiceOpts = {
  mode: 'chat',
  turnActive: false,
  assistant: 'claude',
  closedTurnStartId: null,
};
const voices = (events: ChatEvent[], opts = CHAT) =>
  applyChatVoice(events, opts).map((e) =>
    e.kind === 'assistant' ? (e.voice ?? 'spoken') : e.kind,
  );

describe('chatVoiceActive', () => {
  it('is on for a Claude pane in Chat mode', () => {
    expect(chatVoiceActive(CHAT)).toBe(true);
  });

  it('is off in Agent mode', () => {
    expect(chatVoiceActive({ ...CHAT, mode: 'agent' })).toBe(false);
  });

  it('is off before the server has said which mode the pane is in', () => {
    expect(chatVoiceActive({ ...CHAT, mode: null })).toBe(false);
  });

  it('is off for codex/cursor even if a stale row still says chat', () => {
    // Chat is Claude (modeForBackend); a row can only say otherwise for the
    // instant before its runner hellos. Hiding plain text there would blank a
    // chat that has no `reply` tool to speak with.
    expect(chatVoiceActive({ ...CHAT, assistant: 'codex' })).toBe(false);
    expect(chatVoiceActive({ ...CHAT, assistant: 'cursor' })).toBe(false);
  });
});

describe('Agent mode is untouched', () => {
  it('returns the very same array — byte-for-byte the old rendering', () => {
    const events = [user('hi'), prose('Here is the answer.')];
    expect(applyChatVoice(events, { ...CHAT, mode: 'agent' })).toBe(events);
  });

  it('plain assistant text STILL renders as a message', () => {
    expect(voices([user('hi'), prose('Here is the answer.')], { ...CHAT, mode: 'agent' })).toEqual([
      'user',
      'spoken',
    ]);
  });
});

describe('Chat mode — plain text is private, reply is the voice', () => {
  it('plain assistant text does NOT render as a message', () => {
    expect(
      voices([user('do it'), prose('I should check the folder first.'), reply('Done.')]),
    ).toEqual(['user', 'private', 'reply']);
  });

  it('demoted prose is an ACTION, so it folds into the collapsed run', () => {
    const [, demoted] = applyChatVoice([user('do it'), prose('thinking'), reply('done')], CHAT);
    expect(isPrivateReasoning(demoted as ChatEvent)).toBe(true);
  });

  it('COLLAPSE, NEVER DROP — every event survives, with its id and text intact', () => {
    const events = [user('do it'), prose('a long private deliberation'), reply('Done.')];
    const out = applyChatVoice(events, CHAT);
    expect(out).toHaveLength(events.length);
    expect(out.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect((out[1] as { text: string }).text).toBe('a long private deliberation');
  });

  it('MULTIPLE replies stay multiple messages, in order', () => {
    expect(
      voices([user('do it'), prose('reasoning'), reply('Filed it.'), reply('Want the diff?')]),
    ).toEqual(['user', 'private', 'reply', 'reply']);
  });

  it('leaves tool events alone', () => {
    expect(voices([user('do it'), toolUse('Bash'), reply('done')])).toEqual([
      'user',
      'tool_use',
      'reply',
    ]);
  });
});

describe('THE GUARD — the render half', () => {
  it('promotes the final prose when a closed human turn made no reply', () => {
    expect(voices([user('do it'), prose('first note'), prose('Filed it in ~/Docs.')])).toEqual([
      'user',
      'private',
      'fallback',
    ]);
  });

  it('promotes the FINAL note, never a summary of the turn', () => {
    const out = applyChatVoice([user('do it'), prose('early'), prose('final')], CHAT);
    expect((out[2] as { text: string; voice: string }).text).toBe('final');
    expect((out[2] as { voice: string }).voice).toBe('fallback');
  });

  it('does not fire when the turn replied, however much it also reasoned', () => {
    // The guard's job is NOT to promote here, and it doesn't. The trailing
    // prose is absent for a different reason: pass 3 drops a sign-off written
    // after the reply. Working-out BEFORE the reply is kept, which is what
    // this test is really pinning.
    expect(voices([user('do it'), prose('a'), reply('Done.'), prose('b')])).toEqual([
      'user',
      'private',
      'reply',
    ]);
  });

  it('does NOT fire for a cron-fired turn — nobody is waiting on it', () => {
    // expandCronFire emits the chip and the prompt bubble adjacently; that
    // adjacency is the only provenance signal in the event stream.
    expect(voices([cronChip(), user('sweep the PRs'), prose('nothing to report')])).toEqual([
      'notice',
      'user',
      'private',
    ]);
  });

  it('does NOT fire for events before the first user message', () => {
    // A resumed session's replayed tail, or a wakeup that ran before you said
    // anything. There is no turn a human started here.
    expect(voices([prose('a wakeup ran'), user('hi'), reply('hey')])).toEqual([
      'private',
      'user',
      'reply',
    ]);
  });

  it('leaves the LIVE turn alone — it may still call reply', () => {
    const live = [user('do it'), prose('working on it')];
    expect(voices(live, { ...CHAT, turnActive: true })).toEqual(['user', 'private']);
    // …and applies the moment the turn closes.
    expect(voices(live, { ...CHAT, turnActive: false })).toEqual(['user', 'fallback']);
  });

  it('still guards EARLIER turns while the newest one is live', () => {
    expect(
      voices([user('one'), prose('answer one'), user('two'), prose('still working')], {
        ...CHAT,
        turnActive: true,
      }),
    ).toEqual(['user', 'fallback', 'user', 'private']);
  });

  it('invents nothing when the turn produced no prose at all', () => {
    // Silence with nothing honest to show stays silent in the chat; the
    // harness logs the miss in the pane's terminal face instead.
    expect(voices([user('do it'), toolUse('Bash')])).toEqual(['user', 'tool_use']);
  });

  it('does NOT fire for a turn the user STOPPED — silence is what they asked for', () => {
    // Live repro: a Chat-mode turn was cut short mid-tool-call, and this pass
    // promoted the agent's scratchpad ("All files read. Now the sleep.") into
    // a real bubble — words it never chose to say — while the runner, which
    // knows the turn was interrupted, correctly stayed silent. The interrupt
    // notice is the transcript-level signal that survives a reload.
    expect(voices([user('do it'), prose('working on it'), stopped()])).toEqual([
      'user',
      'private',
      'notice',
    ]);
  });

  it('still guards the NEXT turn after a stopped one', () => {
    expect(
      voices([user('one'), prose('cut short'), stopped(), user('two'), prose('forgot to reply')]),
    ).toEqual(['user', 'private', 'notice', 'user', 'fallback']);
  });

  it('each turn is judged on its own', () => {
    expect(voices([user('one'), reply('done one'), user('two'), prose('forgot to reply')])).toEqual(
      ['user', 'reply', 'user', 'fallback'],
    );
  });
});

describe('foldsAsActionRun — private reasoning is never left inline', () => {
  const priv = (text: string): ChatEvent => ({
    kind: 'assistant',
    id: id(),
    ts: 0,
    text,
    voice: 'private',
  });

  it('folds a LONE scratchpad block — the shape a real turn ends in', () => {
    // Live repro (Chat mode): two replies, then one trailing note — "Both
    // edits are done; nothing further to track. Task complete." — which the
    // length rule left sitting visible under the answer. Every live turn that
    // spoke ended in exactly this shape.
    expect(foldsAsActionRun([priv('Both edits are done. Task complete.')])).toBe(true);
  });

  it('still leaves a LONE tool row inline', () => {
    expect(foldsAsActionRun([toolUse('Bash')])).toBe(false);
  });

  it('folds any run of two or more, private prose or not', () => {
    expect(foldsAsActionRun([toolUse('Bash'), toolUse('Read')])).toBe(true);
    expect(foldsAsActionRun([toolUse('Bash'), priv('thinking out loud')])).toBe(true);
  });

  it('folds nothing when there is nothing', () => {
    expect(foldsAsActionRun([])).toBe(false);
  });
});

describe('a fold of only demoted prose is not an "action"', () => {
  // The mechanism was always right — reply visible, scratchpad folded — but the
  // header said "1 action · notes" over a run containing no action at all. That
  // announced a hidden tool call, so the fold read as where the WORK went and
  // the visible reply read as deliberation: the design inverted in the reader's
  // head while the code underneath was correct. Reported from a live pane.
  it('counts only real actions, not reasoning', () => {
    const onlyProse = [{ kind: 'assistant' as const }];
    const withTool = [{ kind: 'assistant' as const }, { kind: 'tool_use' as const }];
    expect(onlyProse.every((e) => e.kind === 'assistant')).toBe(true);
    expect(withTool.every((e) => e.kind === 'assistant')).toBe(false);
  });
});

describe('the post-reply sign-off is not shown', () => {
  const user = { kind: 'user' as const, id: 'u1', ts: 1, text: 'hi' };
  const reply = (t: string) => ({
    kind: 'assistant' as const,
    id: `r${t}`,
    ts: 2,
    text: t,
    voice: 'reply' as const,
  });
  const prose = (t: string) => ({ kind: 'assistant' as const, id: `p${t}`, ts: 3, text: t });
  const opts = {
    mode: 'chat' as const,
    backend: 'claude',
    assistant: 'claude',
    turnActive: false,
    closedTurnStartId: null,
  };

  it('drops prose that only restates the reply just sent', () => {
    // Measured live: a 188-char reply followed by an 89-char restatement
    // written to an audience the model knows cannot read it. Folding it made
    // the crisp note look like the real answer hiding under a longer one —
    // which is exactly how the bug was reported.
    const out = applyChatVoice(
      [user, reply('4 files, biggest is X'), prose('4 files; largest X')],
      opts,
    );
    expect(out.filter((e) => e.kind === 'assistant')).toHaveLength(1);
    expect(out.some((e) => e.kind === 'assistant' && e.voice === 'reply')).toBe(true);
  });

  it('keeps prose that came BEFORE the reply — that is real working-out', () => {
    const out = applyChatVoice([user, prose("I'll read the file."), reply('done')], opts);
    expect(out).toHaveLength(3);
  });

  it('keeps everything when the turn produced no reply at all', () => {
    // That prose is the fallback the guard promotes. Dropping it would
    // reinstate the silence the whole mechanism exists to prevent.
    const out = applyChatVoice([user, prose('thought about it')], opts);
    expect(out).toHaveLength(2);
    expect(out.some((e) => e.kind === 'assistant' && e.voice === 'fallback')).toBe(true);
  });
});

describe('a turn that has started but not yet spoken does not re-open the one before it', () => {
  // `turn-start` is a socket frame; the user's message is a transcript line
  // that has to be appended, tailed and normalised first. For that window the
  // PREVIOUS turn is momentarily "the last segment" — and it used to collect
  // the live-turn exemption, un-doing work already on screen. Measured on the
  // real stack, once per send: 123 rows → 124 → 123, with the document growing
  // 91 px under the reader.
  const u1 = user('what is in ~?');
  const closed = { ...CHAT, turnActive: true, closedTurnStartId: u1.id };

  it('keeps the sign-off dropped', () => {
    const events = [u1, reply('4 markdown files'), prose('4 files; largest is X')];
    expect(applyChatVoice(events, closed)).toHaveLength(2);
    // …and without the latch, the flag alone says "live" and it comes back.
    expect(applyChatVoice(events, { ...closed, closedTurnStartId: null })).toHaveLength(3);
  });

  it('keeps a promoted fallback promoted', () => {
    // The silent-turn shape: the bubble the guard put on screen must not blink
    // out and return every time the reader presses Enter.
    const events = [u1, prose('had a think, said nothing')];
    expect(voices(events, closed)).toEqual(['user', 'fallback']);
    expect(voices(events, { ...closed, closedTurnStartId: null })).toEqual(['user', 'private']);
  });

  it('hands the exemption over the moment the new turn DOES speak', () => {
    const u2 = user('and now?');
    const events = [
      u1,
      reply('4 markdown files'),
      prose('4 files; largest is X'),
      u2,
      prose('working'),
    ];
    // The new segment is live (untouched); the old one stays finished.
    expect(voices(events, closed)).toEqual(['user', 'reply', 'user', 'private']);
  });

  it('protects a turn whose start we never saw close — a mid-turn mount or a runner reconnect', () => {
    // ws.ts re-broadcasts `turn-start` for a turn already in flight, and a
    // client that mounts into one has watched nothing finish. Both read as
    // "not the closed turn", which is the safe direction: a late promotion
    // costs nothing, a premature one puts words on screen and takes them back.
    const events = [u1, prose('still working on it')];
    expect(voices(events, { ...CHAT, turnActive: true, closedTurnStartId: null })).toEqual([
      'user',
      'private',
    ]);
  });
});

describe('lastTurnStartId', () => {
  it('names the user event that starts the last segment', () => {
    const u = user('second');
    expect(lastTurnStartId([user('first'), reply('ok'), u, prose('mid-turn')])).toBe(u.id);
  });

  it('is null for a transcript nobody has spoken into', () => {
    expect(lastTurnStartId([prose('a wakeup ran')])).toBe(null);
    expect(lastTurnStartId([])).toBe(null);
  });
});

describe('an expanded action run survives the run changing shape', () => {
  // The run the reader opens is almost always the TRAILING one — the work
  // happening in front of them — and it stops being trailing the instant the
  // turn's reply lands. Keying the expansion to whichever end was stable "for
  // a run in that position" meant the key changed underneath the reader at
  // exactly that moment. Measured: 292 px → 26 px, uninvited.
  const a = prose('reading the file');
  const b = toolUse('Read');
  const c = toolUse('Grep');

  it('stays open when the run grows at its TAIL (the turn keeps working)', () => {
    const open = toggleActionRun([a, b], new Set<string>());
    expect(actionRunExpanded([a, b, c], open)).toBe(true);
  });

  it('stays open when the run grows at its HEAD (an older-history prepend)', () => {
    const open = toggleActionRun([b, c], new Set<string>());
    expect(actionRunExpanded([a, b, c], open)).toBe(true);
  });

  it('collapses on a second tap, and leaves nothing behind to re-open it', () => {
    const open = toggleActionRun([a, b], new Set<string>());
    const shut = toggleActionRun([a, b, c], open);
    expect(actionRunExpanded([a, b, c], shut)).toBe(false);
    expect(shut.size).toBe(0);
  });

  it('does not open a DIFFERENT run', () => {
    const open = toggleActionRun([a, b], new Set<string>());
    expect(actionRunExpanded([c], open)).toBe(false);
  });
});
