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
/** Every fire is the same now — the schedule carries no speech flag at all.
 *  A fire with something to tell you says it with `muxpad say`, which arrives
 *  as a `reply`-voiced message and was already exempt from every fold. */
const fire = (prompt = 'Are the markets open?'): ChatEvent[] => {
  const out = expandCronFire(
    renderCronMarker({ id: `c${++n}`, name: 'nw-hourly', at: null, missed: 0 }, prompt),
    id(),
    0,
  );
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
    const out = foldCronTurns([...fire(), tool(), prose('closed')]);
    expect(hidden(out, 'closed')).toBe(true);
  });

  it('folds a fire that carried no prompt at all', () => {
    // `expandCronFire` emits a lone notice for this one — no bubble to read the
    // answer off, so "folded" has to be the default a cron notice falls back to.
    const out = foldCronTurns([...fire(''), prose('closed')]);
    expect(hidden(out, 'closed')).toBe(true);
  });

  it('leaves what the fire SAID alone', () => {
    // `muxpad say` arrives as a reply-voiced message — the same exemption the
    // `reply` tool gets in Chat mode, reached through the CLI because agent
    // mode registers no muxpad tools.
    const out = foldCronTurns([...fire(), tool(), reply('NET $318 — down 10%, that is the level')]);
    expect(hidden(out, 'NET $318 — down 10%, that is the level')).toBe(false);
  });

  /**
   * THE DEFAULT DOES NOT READ THE TEXT. The version before this one matched
   * the reply against a list of acknowledgement words — "ok", "done",
   * "closed" — so that a chatty-by-default cron saying nothing would fold
   * itself. Overfitting a guess about English onto a question the schedule's
   * author can answer, and wrong the first time a job replies "no change since
   * yesterday". What a turn SAYS is none of this function's business; who
   * started it, and whether that starter asked to be heard, is all of it.
   */
  it('hides a quiet fire’s prose whatever the words are', () => {
    for (const text of ['ok', 'closed', 'NET $318', 'no fills today — spread widened']) {
      const out = foldCronTurns([...fire(), tool(), prose(text)]);
      expect(hidden(out, text), text).toBe(true);
    }
  });

  it('shows what it SAID whatever the words are', () => {
    for (const text of ['ok', 'closed', 'NET $318', 'no fills today — spread widened']) {
      const out = foldCronTurns([...fire(), tool(), reply(text)]);
      expect(hidden(out, text), text).toBe(false);
    }
  });

  it('never touches the same word from a person’s turn', () => {
    // "ok" typed at a human is a reply to a human. The rule applies only
    // inside a fire, which is why the fire-tracking is separate from the fold.
    const out = foldCronTurns([user('ship it'), prose('ok')]);
    expect(hidden(out, 'ok')).toBe(false);
  });

  it('stops at the next human turn', () => {
    const out = foldCronTurns([...fire(), prose('closed'), user('hey'), prose('hello!')]);
    expect(hidden(out, 'closed')).toBe(true);
    expect(hidden(out, 'hello!')).toBe(false);
  });

  it("does not let a cron's own prompt bubble end the fold", () => {
    // The bubble adjacent to a fire belongs to the fire; a bubble elsewhere is
    // a person and ends it.
    const out = foldCronTurns([...fire(), prose('closed')]);
    expect(hidden(out, 'closed')).toBe(true);
  });

  it('NEVER folds a deliberate reply', () => {
    // A cron told to say something was told to say it; hiding that would hide
    // the one part its author meant you to read.
    const out = foldCronTurns([...fire(), reply('SPX +0.4%')]);
    expect(out.at(-1)).toMatchObject({ voice: 'reply' });
  });

  it('returns the SAME array when nothing changed', () => {
    // Identity matters: this runs on every render of every chat.
    const events = [user('hi'), prose('hello')];
    expect(foldCronTurns(events)).toBe(events);
  });

  it('a second fire re-opens the fold', () => {
    const out = foldCronTurns([...fire(), prose('a'), ...fire(), prose('b')]);
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
    const [, bubble] = fire('Run: python3 scripts/nw_oneline.py CLOSE');
    expect(bubble).toMatchObject({ kind: 'user', folded: true });
  });

  it('folds the fire’s own PROSE, and only `say` gets through', () => {
    // Prompt and output were two decisions wearing one flag, and then a second
    // flag. Both are gone: the prompt always folds, the prose always folds,
    // and what the fire deliberately SAID is the one thing that is neither.
    const quiet = foldCronTurns([...fire(), tool(), prose('CLOSE 10/7 · −$24K')]);
    expect(isPrivateReasoning(quiet[quiet.length - 1] as ChatEvent)).toBe(true);

    const spoken = foldCronTurns([...fire(), tool(), reply('CLOSE 10/7 · −$24K')]);
    expect(isPrivateReasoning(spoken[spoken.length - 1] as ChatEvent)).toBe(false);
  });

  it('carries no speech flag on the notice at all', () => {
    // There were two, in succession, and both asked the schedule a question
    // only the fire can answer. See the header.
    expect(fire()[0]).not.toHaveProperty('speak');
    expect(fire()[0]).not.toHaveProperty('fold');
  });
});

describe('a fire whose turn produced nothing else', () => {
  it('still folds its prompt, even as a run of one', () => {
    // The length rule renders a lone action inline, which brought the whole
    // prompt back as a visible row. Observed on a fire that died at the weekly
    // limit: chip, then six lines of "Run: python3 … On error print+push".
    const [notice, prompt] = fire('Run: python3 scripts/nw_oneline.py OPEN');
    expect(notice).toBeTruthy();
    expect(foldsAsActionRun([prompt as ChatEvent])).toBe(true);
  });

  it('…while a lone ordinary tool row still renders inline', () => {
    // The exception is for injected prompts, not a general "always fold".
    expect(foldsAsActionRun([tool()])).toBe(false);
  });
});
