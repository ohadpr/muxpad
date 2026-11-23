import { describe, expect, it } from 'vitest';
import { type RebaseFacts, type StalenessFacts, rebaseSafety, staleness } from './staleness.js';

/**
 * The audited population, as fixtures: on 23 November, 16 of 22 live chats
 * were behind on instructions and 6 were on a model that had stopped being the
 * default. Each case below is one of those shapes.
 */
const fresh = (over: Partial<StalenessFacts> = {}): StalenessFacts => ({
  sessionStartedAt: 2_000,
  instructionsWrittenAt: 1_000,
  model: 'claude-opus-5-5',
  defaultModel: 'claude-opus-5-5',
  modelPinned: false,
  reportedBuild: 'b1',
  currentBuild: 'b1',
  ...over,
});

describe('a chat that is current', () => {
  it('says nothing at all', () => {
    expect(staleness(fresh())).toEqual({ stale: false, reasons: [], summary: null });
  });

  it('is not made stale by a session that predates NOTHING', () => {
    // Same millisecond is not evidence. The direction to be wrong in is
    // "says fresh": a mark that cries wolf is a mark you learn to ignore.
    expect(staleness(fresh({ sessionStartedAt: 1_000, instructionsWrittenAt: 1_000 })).stale).toBe(
      false,
    );
  });
});

describe('each way a chat goes stale', () => {
  it('instructions: the session is older than the text on disk', () => {
    // The 16-of-22 case, and the one a respawn does NOT fix — the SDK replays
    // the system prompt it recorded at birth.
    const s = staleness(fresh({ sessionStartedAt: 500, instructionsWrittenAt: 1_000 }));
    expect(s.reasons).toEqual(['instructions']);
    expect(s.summary).toContain('older instructions');
  });

  it('model: a resume kept its birth model', () => {
    const s = staleness(fresh({ model: 'claude-opus-4-8' }));
    expect(s.reasons).toEqual(['model']);
    expect(s.summary).toContain('older model');
  });

  it('build: the runner is behind the server', () => {
    expect(staleness(fresh({ reportedBuild: 'b0' })).reasons).toEqual(['build']);
  });

  it('names all of them at once, in one sentence', () => {
    const s = staleness(
      fresh({ sessionStartedAt: 500, model: 'claude-opus-4-8', reportedBuild: 'b0' }),
    );
    expect(s.reasons).toEqual(['instructions', 'model', 'build']);
    expect(s.summary).toBe(
      'Running older instructions and an older model and an older build — rebase to refresh',
    );
  });
});

describe('what must NEVER wear the mark', () => {
  it('a model the user pinned', () => {
    // A pin is a decision. Marking it stale would be muxpad second-guessing a
    // choice, every day, forever.
    expect(staleness(fresh({ model: 'claude-opus-4-8', modelPinned: true })).stale).toBe(false);
  });

  it('a runner that has not said what it is running', () => {
    // Silence is not evidence. Without this a chat wears the mark for the
    // whole of its first turn, which is when you are watching it.
    expect(staleness(fresh({ model: null })).stale).toBe(false);
    expect(staleness(fresh({ reportedBuild: undefined })).stale).toBe(false);
  });

  it('a pane with no session, and an unreadable instructions file', () => {
    // Absence is not staleness in either direction: no session is nothing to
    // be stale, and if the file cannot be read the honest answer is silence
    // rather than marking all 1,100 chats at once.
    expect(staleness(fresh({ sessionStartedAt: null })).reasons).not.toContain('instructions');
    expect(staleness(fresh({ instructionsWrittenAt: null })).reasons).not.toContain('instructions');
  });
});

/** The refusal, narrowed. `RebaseVerdict` is a union and `.cost` only exists
 *  on the unsafe arm — reading it unnarrowed type-checks nowhere, which is how
 *  this file got committed red. */
const refusal = (f: RebaseFacts): string => {
  const v = rebaseSafety(f);
  if (v.safe) throw new Error('expected a refusal, got safe');
  return v.cost;
};

const idle = (over: Partial<RebaseFacts> = {}): RebaseFacts => ({
  turnActive: false,
  backgroundLive: 0,
  queued: 0,
  blocked: false,
  openTask: false,
  ...over,
});

describe('what a rebase would cost right now', () => {
  it('nothing, when the chat is genuinely idle', () => {
    expect(rebaseSafety(idle())).toEqual({ safe: true });
  });

  it('names the background jobs it would kill — measured, not assumed', () => {
    // A probe lost a background job and a wakeup to a rebase. That is the
    // sentence this button has to be able to say BEFORE it is pressed.
    expect(rebaseSafety(idle({ backgroundLive: 2 }))).toEqual({
      safe: false,
      cost: '2 background jobs would be killed',
    });
    expect(rebaseSafety(idle({ backgroundLive: 1 })).safe).toBe(false);
  });

  it('refuses mid-turn, mid-question, and over queued work', () => {
    expect(rebaseSafety(idle({ turnActive: true }))).toEqual({
      safe: false,
      cost: 'a turn is running',
    });
    expect(refusal(idle({ blocked: true }))).toContain('your answer');
    expect(refusal(idle({ queued: 3 }))).toBe('3 queued messages would be dropped');
  });

  it('refuses while the chat says it has unfinished work', () => {
    expect(refusal(idle({ openTask: true }))).toContain('open task');
  });

  it('reports the LOUDEST cost first, so the button says the scariest true thing', () => {
    const v = rebaseSafety(idle({ turnActive: true, backgroundLive: 5, queued: 2 }));
    expect(v).toEqual({ safe: false, cost: 'a turn is running' });
  });
});
