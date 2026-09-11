import type { ChatEvent } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import {
  type ChatVoiceOpts,
  applyChatVoice,
  chatVoiceActive,
  foldsAsActionRun,
  isPrivateReasoning,
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

const CHAT: ChatVoiceOpts = { mode: 'chat', turnActive: false, assistant: 'claude' };
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
    expect(voices([user('do it'), prose('a'), reply('Done.'), prose('b')])).toEqual([
      'user',
      'private',
      'reply',
      'private',
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
