// The SPAWN half of the directed round trip. The `@`-composer half is tested
// where its grammar lives (web/src/lib/chat-mention.test.ts) and reaches these
// very functions through a re-export; what is tested here is what the SERVER
// composes, because the server is the side that had no round trip at all.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseDirectMarker,
  parseReportMarker,
  renderDirectMarker,
  renderSpawnBriefing,
} from './chat-direct.js';

/**
 * "I JUST GOT A PUSH ABOUT A2 COMPLETING THEIR WORK AND I CAN'T FIND ANYTHING
 * ABOUT THAT SUBJECT."
 *
 * A spawned worker delivered nothing. It retired with `done_reason =
 * 'delivered'` — the server's own word for "its result went back to the parent
 * as a card" (server/src/tab-retire.ts) — while the parent conversation held not
 * one sentence about what it had found. The mechanism that would have carried it
 * already existed and was wired to one door: the `@`-directed flow hands the
 * receiving agent an instruction to report back, and that report renders in the
 * asking chat as a card WITH A BODY.
 *
 * A spawn is a direction. Same marker, same instruction, same parser.
 */
describe('renderSpawnBriefing', () => {
  const brief = (over: Partial<Parameters<typeof renderSpawnBriefing>[0]> = {}) =>
    renderSpawnBriefing({
      childTabId: 't-child',
      childName: 'build-a2',
      childPane: 'p-child',
      parentName: 'Sidebar work',
      parentPane: 'p-parent',
      task: 'move the spawn card into the transcript',
      ...over,
    });

  it('keeps the task as the message — the briefing is a preamble, not a rewrite', () => {
    const parsed = parseDirectMarker(brief());
    expect(parsed?.body).toBe('move the spawn card into the transcript');
  });

  it('points the report at the PARENT, and identifies the answer as the CHILD', () => {
    // The mapping this wrapper exists to fix. Backwards, the worker reports to
    // itself and the parent waits forever — and both halves still parse, which
    // is precisely why it needs a test rather than care.
    const text = brief();
    expect(parseDirectMarker(text)?.marker).toEqual({
      id: 't-child',
      from: 'Sidebar work',
      pane: 'p-parent',
    });
    const template = text.slice(text.indexOf('<muxpad-report'));
    expect(parseReportMarker(template)?.marker).toEqual({
      id: 't-child',
      from: 'build-a2',
      pane: 'p-child',
    });
  });

  it('correlates on the CHILD TAB ID — the handle both sides already have', () => {
    // No ledger is created for this, on either side: the parent's spawn card is
    // derived from that same row, so the report can be matched to the card that
    // announced the spawn without anything storing a mapping.
    expect(parseDirectMarker(brief({ childTabId: 't-xyz' }))?.marker.id).toBe('t-xyz');
  });

  it('tells a spawned worker that nobody is reading ITS chat', () => {
    // The one line that differs from a direction, and it is the load-bearing
    // one: a spawned chat has no user in it, so "I'll report when done" said
    // into its own log reaches nobody.
    const text = brief();
    expect(text).toContain('SPAWNED');
    expect(text).toContain('Nobody is reading this conversation.');
    expect(text).toContain('"Sidebar work"');
    // …and it is still the same instruction underneath.
    expect(text).toContain('report back once, in one message');
    expect(text).toContain("muxpad agent send 'p-parent'");
  });

  it('is the DIRECTED wording when it is a direction — one builder, two openings', () => {
    const directed = renderDirectMarker({ id: 'd1', from: 'Investing', pane: 'p1' }, 'go');
    expect(directed).toContain('Directed here from the muxpad chat "Investing"');
    expect(directed).not.toContain('SPAWNED');
  });

  it('survives a child with no name and no pane of its own yet', () => {
    // Both are optional on the wire: a tab whose bootstrap produced no pane
    // cannot pre-fill `toPane`, and the report still resolves by `id`.
    const text = renderSpawnBriefing({
      childTabId: 't-child',
      parentName: 'Sidebar work',
      parentPane: 'p-parent',
      task: 'go',
    });
    const template = text.slice(text.indexOf('<muxpad-report'));
    expect(parseReportMarker(template)?.marker).toEqual({ id: 't-child', from: '', pane: '' });
  });
});

/**
 * THE COMMAND IN THE BRIEFING IS A SHELL COMMAND.
 *
 * The same hazard the `@` path already has tests for (see the long note in
 * web/src/lib/chat-mention.test.ts): `esc` is XML escaping and leaves the
 * apostrophe, and these attributes are interpolated into a `'…'` shell word, so
 * a chat called `Ohad's project` used to end the quote in the middle of its own
 * name. The spawn path puts a PARENT chat's name — a real, human-named chat,
 * where an apostrophe is likelier than in a worker's generated name — into that
 * same slot, so it is tested against a real shell here too.
 */
describe('the spawn briefing’s report command survives the names people give chats', () => {
  /** The two indented command lines, as an agent would copy them. */
  const commandOf = (instruction: string): string => {
    const lines = instruction.split('\n');
    const first = lines.findIndex((l) => l.trim().startsWith('muxpad agent send'));
    expect(first).toBeGreaterThanOrEqual(0);
    return lines
      .slice(first, first + 2)
      .map((l) => l.trim())
      .join('\n');
  };

  const brief = (parentName: string, childName: string) =>
    renderSpawnBriefing({
      childTabId: 't-child',
      childName,
      childPane: 'p-child',
      parentName,
      parentPane: 'p-parent',
      task: 'go',
    });

  it.each([
    ["Ohad's project", 'worker'],
    ['plain', "it's a 'quoted' worker"],
    ['say "hi" <b> & co', "don't; rm -rf /"],
  ])('is valid sh when the parent is %s and the child is %s', (parentName, childName) => {
    const script = commandOf(brief(parentName, childName));
    const check = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' });
    expect({ parentName, status: check.status, err: check.stderr.trim() }).toEqual({
      parentName,
      status: 0,
      err: '',
    });
  });

  it('delivers the marker VERBATIM through the shell, both names and all', () => {
    // The real command, the real quoting, a stub in muxpad's place — then parse
    // what actually arrived. Nothing in the chain is simulated but the CLI.
    const childName = "A2's build";
    const script = `muxpad() { printf '%s' "$4"; }\n${commandOf(brief("Ohad's project", childName))}`;
    const run = spawnSync('/bin/sh', [], { input: script, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(parseReportMarker(run.stdout)?.marker).toEqual({
      id: 't-child',
      from: childName,
      pane: 'p-child',
    });
  });
});
