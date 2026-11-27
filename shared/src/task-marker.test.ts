import { describe, expect, it } from 'vitest';
import { isMachineMessage } from './spawn-delivery.js';
import { parseTaskMarker, renderTaskContinuation } from './task-marker.js';

const task = {
  request: 'ship the sidebar fix',
  criteria: 'suite green and the order verified',
  next_step: 'run the migration against a copy',
};

describe('a task continuation', () => {
  it('says it is not a human, and which attempt it is', () => {
    const text = renderTaskContinuation({ id: 'tk1', attempt: 2, limit: 6 }, task);
    expect(text).toContain('<muxpad-task id="tk1" attempt="2" limit="6">');
    expect(text).toContain('Not a human');
    expect(text).toContain('continuation 2 of at most 6');
  });

  it('reads the chat its OWN record back rather than paraphrasing the goal', () => {
    // A server that restates the objective becomes a second author of it. The
    // agent's own acceptance criteria are also what lets it check itself,
    // which is the mechanism by which this ends.
    const text = renderTaskContinuation({ id: 'tk1', attempt: 1, limit: 6 }, task);
    expect(text).toContain('ship the sidebar fix');
    expect(text).toContain('suite green and the order verified');
    expect(text).toContain('run the migration against a copy');
  });

  it('names all three exits, with the commands', () => {
    const text = renderTaskContinuation({ id: 'tk1', attempt: 1, limit: 6 }, task);
    expect(text).toContain('muxpad task done tk1');
    expect(text).toContain('muxpad task block tk1');
    expect(text).toContain('muxpad task next tk1');
  });

  it('says that recording progress is what buys the next one', () => {
    // The agent has to know the rule, or the anti-loop reads as muxpad losing
    // interest at random.
    expect(renderTaskContinuation({ id: 'tk1', attempt: 1, limit: 6 }, task)).toContain(
      'RECORDING PROGRESS IS WHAT BUYS THE NEXT CONTINUATION',
    );
  });

  it('omits the lines it has nothing for', () => {
    const text = renderTaskContinuation(
      { id: 'tk1', attempt: 1, limit: 6 },
      { request: 'poke at it', criteria: null, next_step: null },
    );
    expect(text).not.toContain('Done when:');
    expect(text).not.toContain('next step was:');
  });
});

describe('parsing one back', () => {
  it('round-trips the marker and leaves the body', () => {
    const text = renderTaskContinuation({ id: 'tk9', attempt: 3, limit: 6 }, task);
    const parsed = parseTaskMarker(text);
    expect(parsed?.marker).toEqual({ id: 'tk9', attempt: 3, limit: 6 });
    expect(parsed?.body).toContain('You ended a turn with this task still open');
    expect(parsed?.body).not.toContain('<muxpad-task');
  });

  it('is null for ordinary text, including text that merely mentions the tag', () => {
    expect(parseTaskMarker('just a message')).toBeNull();
    expect(parseTaskMarker('I was reading about <muxpad-task id="x"> markers')).toBeNull();
  });

  it('counts as a MACHINE message — the list that gets forgotten', () => {
    // spawn-delivery.ts says it plainly: `isHumanMessage` was once just the
    // cron check, and every injected message type after it would have read as
    // human. A continuation that looked human would reset its own budget and
    // the bound would be decorative.
    const text = renderTaskContinuation({ id: 'tk1', attempt: 1, limit: 6 }, task);
    expect(isMachineMessage(text)).toBe(true);
    expect(isMachineMessage('a person typing')).toBe(false);
  });
});
