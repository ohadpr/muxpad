import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A WAITING JOB IS NOT A MESSAGE YOU TYPED.
 *
 * The composer queue holds two unrelated things. One is a message you wrote
 * while the agent was busy — yours, unsent, and a dashed version of your own
 * bubble with edit and cancel beside it is exactly right for it. The other is
 * a CRON FIRE waiting for the chat to go idle, and every one of those claims
 * is false about it: nobody typed it, it is addressed to no one, and it is not
 * going to become a message.
 *
 * Both rendered in the user's slot. A queued fire therefore appeared as a
 * right-aligned dashed pill reading `⏱ nightrun-plumbing-test` — the name and
 * nothing else — with a restore arrow next to it. Reported as "this pending
 * message as if I typed it is just weird — what is it, where is it coming
 * from, what is it trying to say". All three questions are fair: the row named
 * a schedule without saying it was one, without saying it was waiting, and
 * offered to pull it into the composer.
 *
 * A SOURCE ASSERTION, the same trade this directory's sibling tests make and
 * for the same reason: ChatPane mounts a socket, a router, a tab cache and a
 * composer, and the rig needed to render one queue row is a larger source of
 * false greens than the thing it would prove. What is checkable here is the
 * BRANCH — that a fire takes a different path from a message, and that neither
 * path has the other's parts. `parseCronMarker` is unit-tested in shared.
 */
const SRC = readFileSync(join(process.cwd(), 'src/components/ChatPane.tsx'), 'utf8');

/** The queue's render block: from the filter that drops carded deliveries to
 *  the composer reserve that follows it. */
const QUEUE = (() => {
  const start = SRC.indexOf('.filter((q) => !isDeliveryText(q.text))');
  const end = SRC.indexOf("The composer's reserve", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
})();
const FLAT = QUEUE.replace(/\s+/g, ' ');

/** The two arms, split at the early return the cron branch takes. */
const [CRON_ARM, MESSAGE_ARM] = (() => {
  const i = FLAT.indexOf('const fire = parseCronMarker(q.text)');
  const j = FLAT.indexOf('return ( <div key={q.id} className="chat-turn chat-turn-user');
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return [FLAT.slice(i, j), FLAT.slice(j)];
})();

describe('the queue tells a scheduled job apart from your own message', () => {
  it('branches on the cron marker at all', () => {
    expect(FLAT).toContain('const fire = parseCronMarker(q.text)');
  });

  it('a FIRE is not drawn in the user’s slot', () => {
    // `chat-turn-user` is what right-aligns the row and gives it the sent
    // bubble's shape. That is the whole of "as if I typed it".
    expect(CRON_ARM).not.toContain('chat-turn-user');
    expect(CRON_ARM).not.toContain('chat-bubble');
    // It takes the transcript's own quiet strip for a fire instead, so a job
    // waiting and a job that already ran are one shape.
    expect(CRON_ARM).toContain('chat-sysnote chat-sysnote-cron');
  });

  it('…and SAYS what it is and what it is waiting for', () => {
    // The row used to be the schedule's name and nothing else. A name is not
    // an answer to "what is this".
    expect(CRON_ARM).toContain('fire.marker.name');
    expect(CRON_ARM).toMatch(/scheduled job/i);
    expect(CRON_ARM).toMatch(/queued/i);
    expect(CRON_ARM).toMatch(/waiting for this chat/i);
  });

  it('offers SKIP, and not EDIT', () => {
    // Restoring a schedule's prompt into your composer is not an operation
    // anybody wants, and an ✕ beside a schedule could as easily read "delete
    // the schedule" — which this does not do.
    expect(CRON_ARM).not.toContain('editQueued');
    expect(CRON_ARM).not.toContain('chat-queued-edit');
    expect(CRON_ARM).toContain('cancelQueued(q.id)');
    expect(CRON_ARM).toMatch(/>\s*Skip\s*</);
    expect(CRON_ARM).toMatch(/the schedule itself is unchanged/i);
  });

  it('a MESSAGE you typed keeps everything it had', () => {
    // The other half of the branch, and the regression that would matter more:
    // this row is your unsent text, and losing its edit or its cancel would
    // strand it.
    expect(MESSAGE_ARM).toContain('chat-turn-user chat-turn-queued');
    expect(MESSAGE_ARM).toContain('chat-bubble chat-bubble-queued');
    expect(MESSAGE_ARM).toContain('editQueued(q)');
    expect(MESSAGE_ARM).toContain('cancelQueued(q.id)');
    expect(MESSAGE_ARM).toContain('QueuedText');
  });

  it('a carded DELIVERY still never reaches either arm', () => {
    // Settled earlier and easy to undo by accident: a batch of sub-chat
    // reports already has a launch card and a completion card, so a third
    // dashed row for it was "another pending card".
    expect(FLAT).toContain('.filter((q) => !isDeliveryText(q.text))');
  });
});
