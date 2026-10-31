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
    // that only while nothing compacted by itself; compaction is automatic
    // again (server/src/agent-runner/auto-compact.ts), so a reader colour-coded
    // about a number they cannot act on is pure stress: "I don't want the user
    // to be thinking about compaction."
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

describe('compaction is automatic, and it is MUXPAD doing it', () => {
  /**
   * The runner is the whole guarantee behind the absence of UI in this module.
   * If the trigger is ever removed, the chat silently goes back to filling up
   * with nothing on screen to say so — and every test above still passes, so
   * this reads the runner.
   */
  const runner = readFileSync(
    join(HERE, '..', '..', '..', 'server', 'src', 'agent-runner', 'backends', 'claude.ts'),
    'utf8',
  );

  it('fires a compaction on the fill, with the instructions from here', () => {
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toContain('AutoCompactor');
    expect(code).toMatch(/autoCompactor\.consider\([^)]*\)/);
    // The same words the button sends. An unguided compaction is where a 216k
    // thread becomes 4.7k.
    expect(code).toMatch(/slash\('compact', RECOVERY_COMPACT_INSTRUCTIONS\)/);
  });

  it("still overrides nothing in the harness's own settings", () => {
    // Both overrides are failures, in opposite directions: a window compacts
    // threads nobody asked about (measured: 216k → 4.7k on a live deal
    // thread), and a disable wedges them at the ceiling, where every send —
    // including `/compact` itself — answers "Prompt is too long". muxpad's own
    // trigger is a percentage of the model's REAL window, which is the thing
    // the imposed cap got wrong.
    //
    // Comments stripped: the runner's own note NAMES both, to explain why
    // neither is used.
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('autoCompactEnabled');
    expect(code).not.toContain('autoCompactWindow');
  });

  it('keeps the MANUAL compaction the button depends on', () => {
    // DISABLE_COMPACT would turn off /compact as well — which is both the
    // button's path and the automatic trigger's, since they send the same
    // command.
    //
    // COMMENTS STRIPPED FIRST. The runner's own comment NAMES that variable,
    // to say why it is not the one being used — a test that searched the raw
    // file would fail on the sentence explaining the correct choice.
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('DISABLE_COMPACT');
    expect(code).not.toContain('DISABLE_AUTO_COMPACT');
  });
});
