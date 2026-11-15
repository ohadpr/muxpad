import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPACT_INSTRUCTIONS, compactionBlurb } from './context-pressure';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('context pressure', () => {
  it('exports no levels for the chat to colour itself with', () => {
    // `contextLevel`, CONTEXT_WARN_PCT and CONTEXT_HIGH_PCT lived here, and
    // the strip turned warn-coloured at 70% and danger at 88%. They earned
    // that only while nothing compacted by itself; the harness compacts near
    // the ceiling whatever muxpad thinks, so a reader colour-coded about a
    // number they cannot act on is pure stress: "I don't want the user to be
    // thinking about compaction."
    const src = readFileSync(join(HERE, 'context-pressure.ts'), 'utf8');
    for (const gone of ['contextLevel', 'CONTEXT_WARN_PCT', 'CONTEXT_HIGH_PCT'])
      expect(src.replace(/\/\*[\s\S]*?\*\//g, ''), gone).not.toContain(gone);
  });

  it('names what a compaction must keep, not how long it may be', () => {
    // The observed default on a 216k-token thread produced 4,663 tokens — the
    // shape of the conversation, without the things it was made of.
    for (const must of ['names', 'numbers', 'dates', 'decisions', 'open', 'recent'])
      expect(COMPACT_INSTRUCTIONS.toLowerCase()).toContain(must);
    // A token budget would be a request the compactor has no contract to
    // honour; content is something it can act on.
    expect(COMPACT_INSTRUCTIONS).not.toMatch(/\d+\s*(k|tokens)/i);
  });

  it('says out loud that compaction cannot be undone', () => {
    const blurb = compactionBlurb(700_000, 1_000_000);
    expect(blurb).toContain('cannot be undone');
    expect(blurb).toContain('70%');
  });
});

describe('compaction is automatic, and it is the HARNESS doing it', () => {
  /**
   * THE ABSENCE OF UI IN THIS MODULE RESTS ON THE RUNNER, so this reads it.
   *
   * It used to assert the opposite: that the runner fired `/compact` itself at
   * a percentage. That trigger is gone (the argument is in the runner's
   * context-heal.ts), and what has to be true now is the mirror image — the
   * runner must not compact on a percentage AND must not touch the harness's
   * own automatic compaction, because that is the only thing left keeping a
   * long chat off the ceiling.
   */
  const runner = readFileSync(
    join(HERE, '..', '..', '..', 'server', 'src', 'agent-runner', 'backends', 'claude.ts'),
    'utf8',
  );
  /** Comments stripped: the runner's notes NAME the things it does not do. */
  const code = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('compacts nothing on a percentage', () => {
    // The trigger that was removed, by every name it had. A reinstated one
    // would put a `/compact` the user never typed back in their chat, and the
    // harness's "continue where you left off" would then make the model
    // re-send the message it had just finished.
    expect(code).not.toContain('AutoCompactor');
    expect(code).not.toContain('autoCompactor');
    expect(code).not.toMatch(/context\?\.pct\s*[><]=?/);
  });

  it('still sends `/compact` when a person or an overflow asks', () => {
    // What remains: the Compact button's path, and the recovery after a send
    // has already failed. Both carry the instructions from this module —
    // unguided is where a 216k thread becomes 4.7k.
    expect(code).toMatch(/slash\('compact', RECOVERY_COMPACT_INSTRUCTIONS\)/);
  });

  it("still overrides nothing in the harness's own settings", () => {
    // Both overrides are failures, in opposite directions: a window compacts
    // threads nobody asked about (measured: 216k → 4.7k on a live deal
    // thread), and a disable wedges them at the ceiling, where every send —
    // including `/compact` itself — answers "Prompt is too long". With no
    // trigger of its own, muxpad depends on the harness's entirely, so an
    // override here would be the whole mechanism gone.
    expect(code).not.toContain('autoCompactEnabled');
    expect(code).not.toContain('autoCompactWindow');
  });

  it('keeps the MANUAL compaction the button depends on', () => {
    // DISABLE_COMPACT would turn off `/compact` as well — the button's path
    // and the overflow recovery's, since they send the same command.
    //
    expect(code).not.toContain('DISABLE_COMPACT');
    expect(code).not.toContain('DISABLE_AUTO_COMPACT');
  });
});
