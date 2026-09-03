import type { SubagentProgress } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import fanout from '../__fixtures__/sdk-background-fanout.json' with { type: 'json' };
import nested from '../__fixtures__/sdk-background-nested-multiturn.json' with { type: 'json' };
import { SubagentRoster } from '../subagent-roster.js';
import { type SubagentStreamMessage, applySubagentMessage, applyTurnResult } from './claude.js';

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
