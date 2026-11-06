import { describe, expect, it } from 'vitest';
import { judgeArgv, verbForCommand } from './passthrough.js';
import { classify } from './registry.js';

/**
 * THE WHOLE CHAIN, on the argv that broke the old filter.
 *
 * The unit tests pin each module; these pin the only thing that matters in
 * the end — what privilege a given command line actually asks for. Both of
 * these were real: `--log-file search query …` ran arbitrary SQL under a
 * timed `search.read`, because `--log-file` takes a value and swallowed
 * `search`; and `calendar create --send-updates=all` was a guest-notifying
 * write classified as a timed calendar read, because only the parent command
 * was looked up.
 */
const asked = (argv: string[]) => {
  const v = judgeArgv(argv);
  if (!v.ok) return { refused: v.reason };
  const verb = verbForCommand(v.command as string);
  if (!verb) return { refused: `unmapped command ${v.command}` };
  const c = classify(verb);
  return c.ok ? { verb, timed: c.timed } : { refused: c.reason };
};

describe('the reviewer’s bypasses', () => {
  it('no longer runs SQL as a timed search', () => {
    expect(asked(['--log-file', 'search', 'query', 'SELECT * FROM messages'])).toHaveProperty(
      'refused',
    );
  });
  it('no longer runs a calendar write as a timed read', () => {
    expect(asked(['calendar', 'create', '--send-updates=all'])).toHaveProperty('refused');
  });
  it('still lets the ordinary calls through', () => {
    expect(asked(['search', 'from:x', '--json'])).toEqual({
      verb: 'msgvault.search.read',
      timed: true,
    });
    expect(asked(['calendar', 'freebusy', 'primary', '--json'])).toEqual({
      verb: 'msgvault.calendar.read',
      timed: true,
    });
    expect(asked(['draft-reply', 'id', '--text=hi'])).toEqual({
      verb: 'msgvault.draft.create',
      timed: false,
    });
  });
});
