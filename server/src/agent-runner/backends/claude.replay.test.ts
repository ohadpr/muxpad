import type { SubagentProgress } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import fanout from '../__fixtures__/sdk-background-fanout.json' with { type: 'json' };
import nested from '../__fixtures__/sdk-background-nested-multiturn.json' with { type: 'json' };
import foreground from '../__fixtures__/sdk-foreground-agent.json' with { type: 'json' };
import { SubagentRoster } from '../subagent-roster.js';
import {
  type SubagentStreamMessage,
  applySubagentMessage,
  applyTurnResult,
  isBackgroundLaunch,
  isLaunchAck,
  launchAckTaskId,
} from './claude.js';

/**
 * REPLAY tests: the roster driven by message streams RECORDED from a real
 * @anthropic-ai/claude-agent-sdk 0.3.220 session.
 *
 * The roster's unit tests speak the roster's own API, so they can only ever
 * check the lifecycle we BELIEVE the SDK has — and that belief has now been
 * wrong twice while those tests stayed green. These drive the exact code the
 * runner runs (`applySubagentMessage`) with the exact frames the SDK sent, so a
 * wrong belief shows up as a leak instead of as a passing test.
 *
 * Captures (scrubbed of local paths, prose truncated — ids and lifecycle frames
 * verbatim):
 *  · sdk-background-fanout          — three `run_in_background` Agent launches
 *                                     in one turn; each completion re-opens an
 *                                     autonomous turn.
 *  · sdk-background-nested-multiturn — launches spread over three user turns,
 *                                     agents outliving the turn that made them,
 *                                     a NESTED background agent (a subagent
 *                                     launching its own), and background Bash
 *                                     tasks sharing the level payload.
 */

interface Frame extends SubagentStreamMessage {
  subtype?: string;
}

function makeRoster(): { roster: SubagentRoster; sent: SubagentProgress[] } {
  const sent: SubagentProgress[] = [];
  const roster = new SubagentRoster((p) => sent.push(p));
  return { roster, sent };
}

/**
 * GROUND TRUTH, straight off the capture: which top-level launch owns which SDK
 * task id. Read from the complete recording (`task_started` binds it), so it
 * stays authoritative even when the stream under test has been degraded.
 */
function groundTruth(frames: readonly Frame[]): Map<string, string> {
  const launched = new Set<string>();
  const byTask = new Map<string, string>();
  for (const f of frames) {
    if (f.type === 'assistant' && f.parent_tool_use_id === null) {
      const c = f.message?.content;
      for (const b of Array.isArray(c) ? (c as Array<Record<string, unknown>>) : []) {
        if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
          launched.add(b.id as string);
        }
      }
    }
    const m = f as Frame & { task_id?: string; tool_use_id?: string };
    if (f.type === 'system' && f.subtype === 'task_started' && m.task_id && m.tool_use_id) {
      if (launched.has(m.tool_use_id)) byTask.set(m.task_id, m.tool_use_id);
    }
  }
  return byTask;
}

/** Drive a recorded stream exactly as the session loop does. */
function replay(
  frames: readonly Frame[],
  opts: { turnBoundaries?: boolean; truth?: Map<string, string> } = {},
): { roster: SubagentRoster; sent: SubagentProgress[]; peak: number; missing: string[] } {
  const { roster, sent } = makeRoster();
  const truth = opts.truth;
  const missing: string[] = [];
  let peak = 0;
  for (const f of frames) {
    applySubagentMessage(roster, f);
    if (f.type === 'result' && opts.turnBoundaries !== false) {
      applyTurnResult(roster, f.subtype ?? 'success', false);
    }
    // LIVENESS, checked against the SDK's own level signal: every task the SDK
    // says is running right now, and that we know is one of ours, must have a
    // row. Without this an "ends at zero" test is satisfied by retiring live
    // agents too early — an under-count passing for a fix.
    if (truth && f.type === 'system' && f.subtype === 'background_tasks_changed') {
      for (const t of (f as Frame & { tasks?: Array<{ task_id: string }> }).tasks ?? []) {
        const owner = truth.get(t.task_id);
        if (owner && !roster.has(owner)) missing.push(owner);
      }
    }
    peak = Math.max(peak, roster.size);
  }
  return { roster, sent, peak, missing };
}

/** The SDK declares `tool_use_id` OPTIONAL on task_started and
 *  task_notification. Same stream, with the SDK exercising that option. */
function withoutOptionalToolUseIds(frames: readonly Frame[]): Frame[] {
  return frames.map((f) => {
    if (f.type !== 'system') return f;
    if (f.subtype !== 'task_started' && f.subtype !== 'task_notification') return f;
    const { tool_use_id, ...rest } = f as Frame & { tool_use_id?: string };
    return rest as Frame;
  });
}

const FIXTURES: Array<[string, readonly Frame[], number]> = [
  ['a three-agent background fan-out', fanout as unknown as Frame[], 3],
  ['launches across three turns, with nesting', nested as unknown as Frame[], 3],
  ['a FOREGROUND agent whose report reads like an ack', foreground as unknown as Frame[], 1],
];

describe.each(FIXTURES)('replaying a real SDK stream — %s', (_name, frames, topLevelLaunches) => {
  const truth = groundTruth(frames);

  it('ends with an EMPTY roster, and never drops a live agent on the way', () => {
    // Both halves matter. "Ends at zero" alone is satisfiable by retiring live
    // agents early; `missing` is the SDK's level signal calling that out.
    const { roster, missing } = replay(frames, { truth });
    expect(missing).toEqual([]);
    expect(roster.size).toBe(0);
  });

  it('counts only TOP-LEVEL launches, never nested agents or background Bash', () => {
    // The nested capture carries a grandchild agent's `task_started`,
    // `task_notification` and level membership on this same stream, plus five
    // `local_bash` background tasks. None of them is a row.
    const { peak } = replay(frames);
    expect(peak).toBe(topLevelLaunches);
  });

  it('retires the moment the agent finishes — never at a turn boundary', () => {
    // The user's fleet is long-running background agents launched across many
    // turns. An entry whose retirement waits for a turn boundary is stuck the
    // moment that boundary passes, so retirement must not need one at all.
    const { roster } = replay(frames, { turnBoundaries: false });
    expect(roster.size).toBe(0);
  });

  it('survives the SDK omitting the OPTIONAL tool_use_id on its task frames', () => {
    // `SDKTaskStartedMessage.tool_use_id` and `SDKTaskNotificationMessage.
    // tool_use_id` are both declared optional. When they are absent the entry
    // has no task id, which makes it invisible to BOTH background end-paths —
    // reconcileBackground skips it and doneByTaskId cannot match it — and
    // retireUnstarted will not touch it either, because it plainly RAN.
    // Immortal. The launch ack (`agentId: …`) is the binding that has no
    // optional field, which is why it is now the one we rely on.
    //
    // The liveness half of this is just as load-bearing: with no binding, an
    // agent that has not yet produced child traffic looks "never started" at the
    // first turn result and `retireUnstarted` takes it — so the degraded stream
    // both over-counts (fan-out capture) and under-counts (nested capture).
    const { roster, missing } = replay(withoutOptionalToolUseIds(frames), { truth });
    expect(missing).toEqual([]);
    expect(roster.size).toBe(0);
  });

  it('every row that left announced itself, so the server’s mirror agrees', () => {
    const { sent } = replay(frames);
    const opened = new Set<string>();
    const closed = new Set<string>();
    for (const p of sent) (p.done ? closed : opened).add(p.toolUseId);
    expect([...opened].sort()).toEqual([...closed].sort());
  });
});

describe('an ack and a completion are told apart structurally, not by prose', () => {
  // The sdk-foreground-agent capture is deliberately adversarial and REAL: a
  // `run_in_background: false` Agent whose subagent was told to reply
  // "Async agent launched successfully and the helper finished." Its
  // tool_result therefore matches the ack phrase AND carries its own
  // `agentId:` trailer — the two things a launch ack was being recognised by.
  const frames = foreground as unknown as Frame[];

  function ackText(): string {
    for (const f of frames) {
      if (f.type !== 'user' || f.parent_tool_use_id !== null) continue;
      for (const b of (f.message?.content ?? []) as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result') {
          return ((b.content ?? []) as Array<{ text?: string }>).map((x) => x.text ?? '').join(' ');
        }
      }
    }
    throw new Error('fixture has no top-level tool_result');
  }

  it('the capture really does contain both traps', () => {
    const text = ackText();
    expect(text).toMatch(/[Aa]sync agent launched successfully/);
    expect(text).toMatch(/agentId: [a-z0-9]+/);
    expect(text).toMatch(/<usage>/); // …and the thing that gives it away
  });

  it('is NOT read as a launch ack, so its tool_result still retires the row', () => {
    // With the SDK's optional ids omitted, the tool_result is the ONLY end-path
    // left. Reading it as an ack marks a foreground row background: immune to
    // its own completion, immune to retireForeground, and only reachable by an
    // empty level payload that a foreground-only session never emits.
    expect(isLaunchAck(ackText())).toBe(false);
    expect(launchAckTaskId(ackText())).toBeNull();
    const { roster } = replay(withoutOptionalToolUseIds(frames));
    expect(roster.size).toBe(0);
  });

  it('a real background ack IS read as one', () => {
    const bg = (fanout as unknown as Frame[]).flatMap((f) => {
      if (f.type !== 'user' || f.parent_tool_use_id !== null) return [];
      return ((f.message?.content ?? []) as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'tool_result')
        .map((b) =>
          ((b.content ?? []) as Array<{ text?: string }>).map((x) => x.text ?? '').join(' '),
        );
    });
    expect(bg.length).toBe(3);
    for (const text of bg) {
      expect(isLaunchAck(text)).toBe(true);
      expect(launchAckTaskId(text)).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe('backgroundness comes from the launch input, not the text', () => {
  it('reads run_in_background, defaulting Agent to background', () => {
    // sdk-tools.d.ts: "Agents run in the background by default; you will be
    // notified when one completes. Set to false to run this agent synchronously".
    expect(isBackgroundLaunch('Agent', { run_in_background: true })).toBe(true);
    expect(isBackgroundLaunch('Agent', { run_in_background: false })).toBe(false);
    expect(isBackgroundLaunch('Agent', { description: 'x' })).toBe(true);
    // The legacy `Task` name has no such documented default here.
    expect(isBackgroundLaunch('Task', {})).toBe(false);
    expect(isBackgroundLaunch('Task', { run_in_background: true })).toBe(true);
    expect(isBackgroundLaunch('Agent', undefined)).toBe(true);
  });

  it('the captures carry the flag on every top-level launch', () => {
    for (const frames of [fanout, nested, foreground] as unknown as Frame[][]) {
      for (const f of frames) {
        if (f.type !== 'assistant' || f.parent_tool_use_id !== null) continue;
        for (const b of (f.message?.content ?? []) as Array<Record<string, unknown>>) {
          if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
            expect(typeof (b.input as { run_in_background?: unknown }).run_in_background).toBe(
              'boolean',
            );
          }
        }
      }
    }
  });
});

describe('a Stop keeps the fleet and takes only the turn’s foreground work', () => {
  it('spares background rows, retires foreground ones', () => {
    // The fleet shape: agents launched over earlier turns, still running, while
    // THIS turn is stopped. Driven through the same two functions the loop uses.
    const { roster } = makeRoster();
    // Everything up to the fan-out's first turn `result`: three background
    // agents launched, started and acked, none of them finished.
    const upToFirstResult = (fanout as unknown as Frame[]).slice(
      0,
      (fanout as unknown as Frame[]).findIndex((f) => f.type === 'result'),
    );
    for (const f of upToFirstResult) applySubagentMessage(roster, f);
    const backgroundRows = roster.size;
    expect(backgroundRows).toBe(3);

    // …plus a foreground Task, working, in the turn that is about to be stopped.
    applySubagentMessage(roster, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_fg',
            name: 'Agent',
            input: { description: 'blocking helper', run_in_background: false },
          },
        ],
      },
    });
    applySubagentMessage(roster, {
      type: 'assistant',
      parent_tool_use_id: 'toolu_fg',
      message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} }] },
    });
    expect(roster.size).toBe(backgroundRows + 1);

    applyTurnResult(roster, 'error_during_execution', true);
    expect(roster.values().some((p) => p.toolUseId === 'toolu_fg')).toBe(false);
    expect(roster.size).toBe(backgroundRows);
  });
});

describe('the launch ack is the binding that cannot be missed', () => {
  it('the recorded acks all carry an agentId', () => {
    const acks = (nested as unknown as Frame[]).flatMap((f) => {
      if (f.type !== 'user' || f.parent_tool_use_id !== null) return [];
      const c = f.message?.content;
      return Array.isArray(c) ? c : [];
    });
    const launched = acks.filter((b: { content?: unknown }) =>
      JSON.stringify(b.content ?? '').includes('Async agent launched successfully'),
    );
    expect(launched.length).toBeGreaterThan(0);
    for (const b of launched) expect(JSON.stringify(b.content)).toMatch(/agentId: [a-z0-9]+/);
  });
});
