import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE WORKING ROW SAYS WHAT IT IS DOING, NOT WHAT IT IS RUNNING.
 *
 * It led with the TOOL — "Running Bash…" — and put the agent's own sentence
 * after it in faint italic at 0.75em. Both halves were wrong, and the owner
 * named it: "the thought is much more helpful 99% of the time… I prefer to
 * see a sentence saying what it's doing more than seeing that it did 22 steps
 * and 44 bash somethings."
 *
 * The tool name is the one thing already on screen — the fold directly above
 * reads `Bash ×49` — so the row spent its prominence restating the known
 * thing and its faintest type on the only new one.
 */
const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');

/** A rule's body, so a colour assertion cannot be satisfied by a comment. */
function rule(selector: string): string {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = stripped.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`${selector} not found — this test is about nothing`);
  return stripped.slice(at, stripped.indexOf('}', at));
}

describe('the running row leads with the sentence', () => {
  it('shows the agent’s own words when there are any', () => {
    expect(SRC).toMatch(/\{hint \? \(\s*<span className="chat-working-say">\{hint\}<\/span>/);
  });

  it('falls back to the tool name only when nothing has been thought yet', () => {
    // A silent pane still has to say something: "Running Bash…" beats a bare
    // spinner. But it is the FALLBACK, not the lead.
    const branch = SRC.slice(SRC.indexOf('{hint ? ('));
    const tail = branch.slice(0, branch.indexOf('</div>'));
    expect(tail).toMatch(/\) : workingLabel \? \(/);
    expect(tail).toMatch(/className="chat-working-label"/);
  });

  it('is READABLE — not the faint ink that fails AA on six of seven themes', () => {
    // Measured: --chat-faint is 3.34:1 on memphis and under 4.5:1 everywhere
    // but blueprint. This row is the only account of what a silent pane is
    // doing, so it is the last place to spend legibility on quietness.
    expect(rule('.chat-working-say')).toContain('var(--chat-dim)');
    expect(rule('.chat-working-say')).not.toContain('--chat-faint');
    expect(rule('.chat-working-label')).toContain('var(--chat-dim)');
    expect(rule('.chat-working-label')).not.toContain('--chat-faint');
  });

  it('stays ONE line however long the thought is', () => {
    // It occupies the same pixels on every tool call; a row that wrapped to
    // three lines would push the conversation up each time, which is the
    // growing verbose log the indicator exists to avoid.
    const say = rule('.chat-working-say');
    expect(say).toContain('white-space: nowrap');
    expect(say).toContain('text-overflow: ellipsis');
    // Without `min-width: 0` a flex item will not shrink below its content,
    // so the ellipsis never appears and the row grows instead.
    expect(say).toContain('min-width: 0');
  });

  it('leaves no trace of the old faint-italic hint', () => {
    expect(SRC).not.toMatch(/chat-working-hint/);
    expect(CSS).not.toMatch(/chat-working-hint/);
  });
});
