import { type ChatEvent, expandCronFire, renderCronMarker } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { foldCronTurns, foldsAsActionRun, isPrivateReasoning } from './chat-voice';

/**
 * A folded cron's WHOLE turn is plumbing, not just its prompt.
 *
 * `--fold` hid the injected instruction but not what the agent then did about
 * it, so an hourly job still printed a tool row and a one-word reply into the
 * chat every time — six rows a day saying "closed", in a conversation whose
 * real content is one card.
 *
 * ── THE FIXTURE IS THE REAL NORMALIZER, DELIBERATELY ────────────────────────
 * `fire()` used to hand-build the notice it expected — `body` set meant folded,
 * absent meant not. That is a second opinion about a shape only
 * `expandCronFire` actually produces, and the two drifted the moment the chip
 * became a mark: the prompt moved out of the notice's `body` and into a
 * `folded: true` bubble behind it, so every real fire read as UNfolded and the
 * fold stopped running entirely. Every test here still passed, because they
 * were agreeing with each other rather than with the code.
 *
 * So the fixture goes through `renderCronMarker` → `expandCronFire`, the exact
 * path a delivered message takes. A change to the fire's shape now breaks this
 * file instead of the user's chat.
 */
let n = 0;
const id = () => `e${++n}`;
const fire = (folded: boolean, prompt = 'Are the markets open?'): ChatEvent[] => {
  const text = renderCronMarker(
    { id: `c${++n}`, name: 'nw-hourly', at: null, missed: 0, fold: folded },
    prompt,
  );
  const out = expandCronFire(text, id(), 0);
  if (!out) throw new Error('fixture is not a cron fire');
  return out;
};
const prose = (text = 'closed'): ChatEvent => ({ kind: 'assistant', id: id(), ts: 0, text });
const reply = (text: string): ChatEvent => ({
  kind: 'assistant',
  id: id(),
  ts: 0,
  text,
  voice: 'reply',
});
const user = (text: string): ChatEvent => ({ kind: 'user', id: id(), ts: 0, text });
const tool = (): ChatEvent => ({
  kind: 'tool_use',
  id: id(),
  ts: 0,
  toolUseId: id(),
  name: 'Bash',
  input: {},
});

describe('foldCronTurns', () => {
  /** Is the assistant message that said `text` folded away? Located by what it
   *  SAYS, so the tests do not have to track how many rows a fire expands to. */
  const hidden = (out: readonly ChatEvent[], text: string): boolean => {
    const e = out.find((x) => x.kind === 'assistant' && x.text === text);
    if (!e) throw new Error(`no assistant message "${text}" in the output`);
    return isPrivateReasoning(e);
  };

  it('demotes the prose a FOLDED fire produced', () => {
    // The bug this file missed: with the chip a mark, a folded fire is a notice
    // plus a `folded` bubble and the notice carries no body at all. Read off a
    // hand-built notice, the fold never engaged and an hourly job printed
    // "closed" into the conversation six times a day.
    const out = foldCronTurns([...fire(true), tool(), prose('closed')]);
    expect(hidden(out, 'closed')).toBe(true);
  });

  it('folds a fire that carried no prompt at all', () => {
    // `expandCronFire` emits a lone notice for this one — no bubble to read the
    // answer off, so "folded" has to be the default a cron notice falls back to.
    const out = foldCronTurns([...fire(true, ''), prose('closed')]);
    expect(hidden(out, 'closed')).toBe(true);
  });

  it('leaves an UNFOLDED fire’s REAL prose alone', () => {
    // Its author did not ask for this; its prompt is visible and so is its work.
    // The stand-in used to be the word "closed", which is now read as an
    // acknowledgement (see below) — so this was asserting the rule it meant to
    // with a word that no longer carries any.
    const out = foldCronTurns([...fire(false), tool(), prose('NET closed at $318, down 2%.')]);
    expect(hidden(out, 'NET closed at $318, down 2%.')).toBe(false);
  });

  /**
   * AN ACKNOWLEDGEMENT IS NOT A REPLY, EVEN UNFOLDED.
   *
   * "The investing window experienced something related to the cron making its
   * way to the main chat window." `nw-open` is declared `fold=false`, so the
   * fold was working exactly as specified; what it let through was
   *
   *     ⏱ nw-open 07:03   › 3 actions prompt · Bash · PushNotification   ok
   *
   * three rows whose total content is that a schedule ran. The job's real
   * output was a push; "ok" is the word its own prompt asked for. Three of the
   * four crons in that chat are written that way, so `--fold` on each of them
   * fixes today and not tomorrow.
   */
  it('demotes a bare acknowledgement from an unfolded fire', () => {
    for (const ack of ['ok', 'OK.', 'done', 'closed', 'nothing to report', 'net: no']) {
      const out = foldCronTurns([...fire(false), tool(), prose(ack)]);
      expect(hidden(out, ack), ack).toBe(true);
    }
  });

  it('does not eat a SHORT message that says something', () => {
    // The tempting rule was "short and wordless". "NET $318" is two words and
    // is the entire point of the message that contains it.
    for (const real of ['NET $318', 'no fills today — spread widened', 'closed early (half day)']) {
      const out = foldCronTurns([...fire(false), tool(), prose(real)]);
      expect(hidden(out, real), real).toBe(false);
    }
  });

  it('never touches the same word from a person’s turn', () => {
    // "ok" typed at a human is a reply to a human. The rule applies only
    // inside a fire, which is why the fire-tracking is separate from the fold.
    const out = foldCronTurns([user('ship it'), prose('ok')]);
    expect(hidden(out, 'ok')).toBe(false);
  });

  it('stops at the next human turn', () => {
    const out = foldCronTurns([...fire(true), prose('closed'), user('hey'), prose('hello!')]);
    expect(hidden(out, 'closed')).toBe(true);
    expect(hidden(out, 'hello!')).toBe(false);
  });

  it("does not let a cron's own prompt bubble end the fold", () => {
    // The bubble adjacent to a fire belongs to the fire; a bubble elsewhere is
    // a person and ends it.
    const out = foldCronTurns([...fire(true), prose('closed')]);
    expect(hidden(out, 'closed')).toBe(true);
  });

  it('NEVER folds a deliberate reply', () => {
    // A cron told to say something was told to say it; hiding that would hide
    // the one part its author meant you to read.
    const out = foldCronTurns([...fire(true), reply('SPX +0.4%')]);
    expect(out.at(-1)).toMatchObject({ voice: 'reply' });
  });

  it('returns the SAME array when nothing changed', () => {
    // Identity matters: this runs on every render of every chat.
    const events = [user('hi'), prose('hello')];
    expect(foldCronTurns(events)).toBe(events);
  });

  it('a second fire re-opens the fold', () => {
    const out = foldCronTurns([...fire(true), prose('a'), ...fire(true), prose('b')]);
    expect(hidden(out, 'a')).toBe(true);
    expect(hidden(out, 'b')).toBe(true);
  });

  it('a non-cron notice does not open one', () => {
    const task: ChatEvent = { kind: 'notice', id: id(), ts: 0, variant: 'task', text: 'x' };
    const out = foldCronTurns([task, prose('visible')]);
    expect(hidden(out, 'visible')).toBe(false);
  });
});

describe('the injected prompt is plumbing whatever the flag says', () => {
  it('folds an UNFOLDED fire’s prompt too', () => {
    // Reported looking at `nw-close`: six lines of "Run: python3 … On error
    // print+push 'NW close snapshot failed'" above the answer. Nobody re-reads
    // the instruction a schedule injected.
    const [, bubble] = fire(false, 'Run: python3 scripts/nw_oneline.py CLOSE');
    expect(bubble).toMatchObject({ kind: 'user', folded: true });
  });

  it('still leaves an unfolded fire’s REPLY visible', () => {
    // The whole point of not folding `nw-close` is that it says something worth
    // reading. Prompt and output were two decisions wearing one flag.
    const out = foldCronTurns([...fire(false), tool(), prose('CLOSE 10/7 · −$24K')]);
    expect(isPrivateReasoning(out[out.length - 1] as ChatEvent)).toBe(false);
  });

  it('carries the flag on the notice instead of inferring it from the shape', () => {
    // Both shapes are identical now, so a predicate that read the next event
    // would always answer "folded". The flag is a fact about the SCHEDULE.
    expect(fire(true)[0]).toMatchObject({ kind: 'notice', variant: 'cron', fold: true });
    expect(fire(false)[0]).not.toHaveProperty('fold');
  });
});

describe('a fire whose turn produced nothing else', () => {
  it('still folds its prompt, even as a run of one', () => {
    // The length rule renders a lone action inline, which brought the whole
    // prompt back as a visible row. Observed on a fire that died at the weekly
    // limit: chip, then six lines of "Run: python3 … On error print+push".
    const [notice, prompt] = fire(true, 'Run: python3 scripts/nw_oneline.py OPEN');
    expect(notice).toBeTruthy();
    expect(foldsAsActionRun([prompt as ChatEvent])).toBe(true);
  });

  it('…while a lone ordinary tool row still renders inline', () => {
    // The exception is for injected prompts, not a general "always fold".
    expect(foldsAsActionRun([tool()])).toBe(false);
  });
});
