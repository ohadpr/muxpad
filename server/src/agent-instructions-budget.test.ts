import { describe, expect, it } from 'vitest';
import {
  AGENT_INSTRUCTIONS_SEED,
  ALL_INSTRUCTION_TEXT,
  INSTRUCTION_TOPICS,
  applyCapabilities,
  capsAllower,
  helpPage,
} from './agent-instructions.js';
import { STANDING_RULES } from './agent-instructions.js';

/**
 * WHAT EVERY SESSION PAYS, in bytes, pinned.
 *
 * The document reached 51,515 characters — about 12,900 tokens injected into
 * every chat on this machine, whether or not it would ever touch mail, Slack,
 * a card, a cron or a browser. Measured against its own content: roughly 550
 * tokens of that were RULES. The rest was a manual, and a manual belongs where
 * you look it up.
 *
 * This test is the ceiling that keeps it from growing back one well-argued
 * paragraph at a time. Raising it is a decision, not a drive-by.
 */
const RESIDENT_CEILING = 7_000;

describe('what every session is handed', () => {
  const resident = AGENT_INSTRUCTIONS_SEED;

  it('stays under its character ceiling', () => {
    expect(
      resident.length,
      `resident instructions are ${resident.length} chars (~${Math.round(resident.length / 4)} tokens)`,
    ).toBeLessThan(RESIDENT_CEILING);
  });

  it('keeps the standing rules, which are the part that must be read before acting', () => {
    expect(resident).toContain(STANDING_RULES);
  });

  it('names every topic it deferred, so a capability is still discoverable', () => {
    // THE ONE THING THAT CANNOT BE DEFERRED. An agent that has never heard of
    // `muxpad cron` does not go looking for `muxpad help cron`.
    for (const topic of Object.keys(INSTRUCTION_TOPICS))
      expect(resident, `topic ${topic} is unreachable`).toContain(`\`${topic}\``);
    expect(resident).toContain('muxpad help <topic>');
  });

  it('keeps the publish TRIGGER resident, because a deferred trigger never fires', () => {
    // The failure this is pinned against, in the owner's words: "again failing
    // to produce an artifact". `publish`'s manual had moved to a help page and
    // the rule that says WHEN to publish went with it — so an agent that never
    // thought to read the page handed back a local file path and hand-rolled a
    // `python3 -m http.server`. A trigger is not a flag reference: it has to be
    // in the text every session already has.
    expect(resident).toContain('IT, HAND BACK THE URL');
    expect(resident).toContain('not yours to second-guess');
    expect(resident).toContain('not a hand-rolled server');
    // The owner's verbatim instruction stays in the page the bullet points at.
    expect(INSTRUCTION_TOPICS.publish).toContain('no agent deciding');
  });

  it('moved the manual rather than deleting it', () => {
    // Each page is still the text it was. These are the load-bearing lines of
    // four different topics; if a move quietly dropped one, this fails.
    expect(ALL_INSTRUCTION_TEXT).toContain('SLACK REQUIRES HUMAN APPROVAL');
    expect(ALL_INSTRUCTION_TEXT).toContain('THE SLUG IS NOT THE NAME YOU ASKED FOR');
    expect(ALL_INSTRUCTION_TEXT).toContain('muxpad cron');
    expect(ALL_INSTRUCTION_TEXT.length).toBeGreaterThan(40_000);
  });
});

describe('a capability this machine cannot use', () => {
  const doc =
    '<!--cap:slack-->SLACK MANUAL<!--/cap:slack-->\nkeep\n<!--cap:msgvault-->MAIL<!--/cap:msgvault-->';

  it('is cut entirely, not just unmarked', () => {
    const out = applyCapabilities(doc, (c) => c === 'msgvault');
    expect(out).not.toContain('SLACK MANUAL');
    expect(out).toContain('MAIL');
    expect(out).toContain('keep');
    expect(out).not.toContain('cap:');
  });

  it('keeps everything when nobody said otherwise', () => {
    // The failure that matters is hiding a capability the user HAS.
    const out = applyCapabilities(doc);
    expect(out).toContain('SLACK MANUAL');
    expect(out).toContain('MAIL');
  });
});

describe('MUXPAD_CAPS', () => {
  it('tells "unset" apart from "none", because they are opposite answers', () => {
    expect(capsAllower(undefined)).toBeUndefined();
    const none = capsAllower('');
    expect(none?.('slack')).toBe(false);
    const some = capsAllower('msgvault, slack');
    expect(some?.('slack')).toBe(true);
    expect(some?.('publish')).toBe(false);
  });
});

describe('a help page', () => {
  it('loses the fences and gains a title when it starts mid-bullet', () => {
    const page = helpPage(
      'slack',
      '<!--cap:slack-->\n- `muxpad slack` — the thing\n<!--/cap:slack-->',
    );
    expect(page).not.toContain('cap:slack');
    expect(page.startsWith('## muxpad slack')).toBe(true);
  });

  it('leaves a page that already has a heading alone', () => {
    expect(helpPage('cards', '## Cards\n\nbody').startsWith('## Cards')).toBe(true);
  });
});
