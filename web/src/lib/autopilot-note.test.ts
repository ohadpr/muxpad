import { describe, expect, it } from 'vitest';
import { AUTOPILOT_MARK, splitAutopilot } from './autopilot-note';

/**
 * "I would like to see these Ohad agentic messages in the chat labeled with
 * some color so I can follow what happened."
 *
 * The prods travel the ordinary send road, so they land in the log where the
 * owner's own words land. This is what tells the two apart.
 */
describe('spotting the autopilot in the log', () => {
  const prod = `${AUTOPILOT_MARK} — not Ohad, and he has not seen this turn]\n\nRun the suite.\n\nWhy: no proof yet.`;

  it('splits the chip from the instruction', () => {
    const note = splitAutopilot(prod);
    expect(note?.label).toBe('muxpad autopilot — not Ohad, and he has not seen this turn');
    expect(note?.body.startsWith('Run the suite.')).toBe(true);
  });

  it('leaves an ordinary message alone', () => {
    expect(splitAutopilot('make the bar shorter')).toBe(null);
    expect(splitAutopilot('')).toBe(null);
  });

  it('does not relabel a person QUOTING the autopilot', () => {
    // Which is exactly what happens when somebody pastes one back to ask
    // about it — and having your own message rendered as machinery would be
    // the worst possible answer to "so I can follow what happened".
    expect(splitAutopilot(`why did it say "${AUTOPILOT_MARK}]" here?`)).toBe(null);
    expect(splitAutopilot(`  ${AUTOPILOT_MARK}]`)).toBe(null);
  });

  it('refuses a marker with no closing bracket', () => {
    expect(splitAutopilot(`${AUTOPILOT_MARK} and then nothing`)).toBe(null);
  });
});
