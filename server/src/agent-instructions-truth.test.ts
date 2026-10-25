import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTIONS_SEED } from './agent-instructions.js';

/**
 * THE DOCUMENT HAS TO BE TRUE, NOT JUST DELIVERED.
 *
 * ─── Three incidents, one shape ───────────────────────────────────────────
 *
 * muxpad's instructions assert behaviour, and NOTHING tied those assertions to
 * the code. So they rotted silently, and an agent reading them was confidently
 * wrong in front of the user:
 *
 *   · the Slack section described `--as-me` / `--as-bot` long after both flags
 *     were removed — and a pane that could not find them went looking for a
 *     token on disk instead, and DM'd a colleague as a bot;
 *   · the delegation section promised a sub-agent "shows up in the sidebar with
 *     its own row … and a card in your log". The row went behind a pill, the
 *     retired child left the list, and the spawn card never existed — so agents
 *     sent the user hunting for three things that were not there;
 *   · `agent wait`'s exit codes were documented as if `1` meant one thing.
 *
 * Making that document arrive more reliably (which is what the per-turn
 * standing-rules work did) makes a WRONG document worse, not better.
 *
 * ─── What this test can and cannot pin ────────────────────────────────────
 *
 * It pins the MECHANICAL half: every command and flag the document tells an
 * agent to type must exist in the CLI. That is the half that would have caught
 * `--as-me`, and it costs nothing to keep.
 *
 * It CANNOT pin the behavioural half — what the sidebar shows, where a card
 * lands. No test here can know that a UI change made a sentence false. That
 * half is a social rule, stated in the seed itself and in the review habit:
 * when you change what the user SEES, grep this file for what you changed.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = readFileSync(join(ROOT, 'scripts', 'muxpad'), 'utf8');

/** `muxpad <verb>` as the doc writes it — in prose, in fences, in examples. */
function verbsNamedInDoc(doc: string): Set<string> {
  const out = new Set<string>();
  // SAME LINE ONLY. `\s` crossed newlines and turned the wrapped prose "no
  // muxpad / contract on top" into a demand for a `muxpad contract` verb. A
  // command an agent is told to type is never split across a line break.
  for (const m of doc.matchAll(/muxpad[ \t]+([a-z][a-z-]{1,24})\b/g)) {
    const verb = m[1] as string;
    out.add(verb);
  }
  return out;
}

/**
 * Words that follow "muxpad" in a SENTENCE rather than in a command — "muxpad
 * owns", "muxpad delivers its result". Listed explicitly: a regex that tried to
 * tell prose from code would be the thing that rots next.
 */
const PROSE_AFTER_MUXPAD = new Set([
  'owns',
  'creates',
  'delivers',
  'keeps',
  'marks',
  'opens',
  'compacts',
  'publish',
  'tools',
  'server',
  'itself',
  'is',
  'has',
  'does',
  'and',
  'the',
  'own',
  'will',
  'can',
  'cannot',
  'never',
  'always',
  'already',
  'also',
  'still',
  'only',
  'uses',
  'writes',
  'reads',
  'sends',
  'holds',
  'puts',
  'runs',
  'shows',
  'says',
  'knows',
  'treats',
  'makes',
  'picks',
  'spawns',
  'supervises',
  'archives',
  'imposes',
  'rewrites',
  'replaced',
  'mints',
  'hands',
  'stores',
  'serves',
  'refuses',
  'wants',
  'needs',
  'expects',
]);

/** Verbs the top-level dispatcher accepts (`  verb) cmd_… ;;`). */
function verbsInCli(cli: string): Set<string> {
  const out = new Set<string>();
  for (const m of cli.matchAll(/^\s{2}([a-z][a-z-]{1,24})\)\s*(?:cmd_|\n)/gm))
    out.add(m[1] as string);
  for (const m of cli.matchAll(/^\s+([a-z][a-z-]{1,24})\)\s*shift;/gm)) out.add(m[1] as string);
  return out;
}

describe('the instructions name things that exist', () => {
  it('every `muxpad <verb>` in the document is a real CLI verb', () => {
    const cli = verbsInCli(CLI);
    const missing = [...verbsNamedInDoc(AGENT_INSTRUCTIONS_SEED)]
      .filter((v) => !PROSE_AFTER_MUXPAD.has(v))
      .filter((v) => !cli.has(v));
    expect(missing, `the doc tells agents to run verbs the CLI does not have: ${missing}`).toEqual(
      [],
    );
  });

  it('every flag the document tells an agent to pass exists in the CLI', () => {
    // THE ONE THAT MATTERED: `--as-me` survived in this document for weeks
    // after the flag was deleted, and an agent that could not make it work
    // reached for a token on disk instead.
    const flags = new Set(
      [...AGENT_INSTRUCTIONS_SEED.matchAll(/\s(--[a-z][a-z-]{1,24})\b/g)].map(
        (m) => m[1] as string,
      ),
    );
    // CSS custom properties and shell/browser flags the doc quotes for OTHER
    // programs (chrome, tailscale) are not muxpad's to own.
    const notOurs = new Set([
      '--bg-hover',
      '--fg-dim',
      '--accent',
      '--fg',
      '--password-store',
      '--use-mock-keychain',
      '--no-sandbox',
      '--host',
      '--help',
    ]);
    const missing = [...flags].filter((f) => !notOurs.has(f) && !CLI.includes(f));
    expect(missing, `the doc names flags the CLI does not accept: ${missing}`).toEqual([]);
  });

  it('does not promise a sub-agent its own sidebar row, or a card at spawn time', () => {
    // The claim that produced the "I see no sub-chat, no report, nothing"
    // report. A sub-agent is a PILL on the parent's row while it works, a
    // `⇤ reported` chip when it finishes, and gone from the live list after —
    // see groupChats in web/src/components/NavTree.tsx, which is explicit that
    // a retired sub-chat "is not shown AT ALL".
    expect(AGENT_INSTRUCTIONS_SEED).not.toMatch(/sidebar with its own row/);
    expect(AGENT_INSTRUCTIONS_SEED).toMatch(/PILL at the end of YOUR row/);
    expect(AGENT_INSTRUCTIONS_SEED).toMatch(/NO card at spawn time/);
  });

  it('does not claim `agent wait` exit 1 means "not an agent pane"', () => {
    // It also means a usage error, and a pane whose runner has not registered
    // yet — the normal state for a second or two after `muxpad agent new`.
    // Measured: two live agent panes returned 1 immediately after spawn.
    expect(AGENT_INSTRUCTIONS_SEED).not.toMatch(/1 = not an agent pane/);
    expect(AGENT_INSTRUCTIONS_SEED).toMatch(/1 is overloaded/);
  });

  it('never mentions a Slack identity flag — there is no bot identity', () => {
    expect(AGENT_INSTRUCTIONS_SEED).not.toMatch(/--as-me|--as-bot/);
  });
});
