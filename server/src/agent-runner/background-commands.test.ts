import { describe, expect, it } from 'vitest';
import nested from './__fixtures__/sdk-background-nested-multiturn.json' with { type: 'json' };
import { applyTaskLifecycle } from './backends/claude.js';
import { BackgroundCommands } from './background-commands.js';
import { SubagentRoster } from './subagent-roster.js';

/**
 * Driven by the SAME recorded 0.3.220 stream the roster's replay tests use,
 * for the same reason: a tracker tested only through its own API can only check
 * the lifecycle we BELIEVE the SDK has, and that belief has been wrong twice.
 */
interface Frame {
  type?: string;
  subtype: string;
  task_id?: string;
  tool_use_id?: string;
  tasks?: { task_id: string; task_type?: string }[];
  patch?: { status?: string; is_backgrounded?: boolean };
}

// The capture carries non-lifecycle frames too; only those with a subtype
// reach the dispatcher, which is what the runner does.
const frames = (nested as unknown as Partial<Frame>[]).filter(
  (f): f is Frame => typeof f.subtype === 'string',
);

/** Replay every lifecycle frame through the real dispatcher. */
function replay(upTo = frames.length): { cmds: BackgroundCommands; roster: SubagentRoster } {
  const cmds = new BackgroundCommands();
  const roster = new SubagentRoster(() => {});
  for (const f of frames.slice(0, upTo)) applyTaskLifecycle(roster, f, cmds);
  return { cmds, roster };
}

describe('background commands, replayed from a real session', () => {
  it('counts the backgrounded Bash the roster is built to ignore', () => {
    // The roster's membership rule is "we saw its top-level Task/Agent
    // tool_use", which a backgrounded Bash call never has. That is correct for
    // the roster and is exactly why these were invisible: the fixture carries
    // five distinct local_bash task ids alongside the agents.
    const ids = new Set<string>();
    for (const f of frames) {
      for (const t of f.tasks ?? []) if (t.task_type === 'local_bash') ids.add(t.task_id);
    }
    expect(ids.size).toBe(5);
  });

  it('ends empty — every command the session started is accounted for', () => {
    // The failure this guards is the one that matters: a command that no path
    // can retire pins a pane to `working` and would make a round wait forever.
    const { cmds } = replay();
    expect(cmds.size).toBe(0);
    expect(cmds.busy).toBe(false);
  });

  it('is BUSY in the middle, or it is measuring nothing', () => {
    // A tracker that is empty at the end because it was empty throughout would
    // pass the test above and report nothing all day.
    let peak = 0;
    const cmds = new BackgroundCommands();
    const roster = new SubagentRoster(() => {});
    for (const f of frames) {
      applyTaskLifecycle(roster, f, cmds);
      peak = Math.max(peak, cmds.size);
    }
    expect(peak).toBeGreaterThan(0);
  });

  it('never counts an AGENT as a command', () => {
    // The two share one channel and one payload. Counting agents here would
    // make the count climb for work this product no longer has.
    const agentIds = new Set<string>();
    for (const f of frames) {
      for (const t of f.tasks ?? []) if (t.task_type === 'local_agent') agentIds.add(t.task_id);
    }
    expect(agentIds.size).toBeGreaterThan(0);
    const cmds = new BackgroundCommands();
    const roster = new SubagentRoster(() => {});
    for (const f of frames) {
      applyTaskLifecycle(roster, f, cmds);
      for (const e of cmds.list()) expect(agentIds.has(e.taskId)).toBe(false);
    }
  });
});

describe('the rules membership follows', () => {
  const level = (...tasks: { task_id: string; task_type?: string }[]) => tasks;

  it('holds exactly what the level signal last said', () => {
    const c = new BackgroundCommands();
    c.reconcile(level({ task_id: 'a', task_type: 'local_bash' }));
    expect(c.size).toBe(1);
    c.reconcile(level({ task_id: 'b', task_type: 'local_bash' }));
    expect(c.list().map((e) => e.taskId)).toEqual(['b']);
    c.reconcile([]);
    expect(c.busy).toBe(false);
  });

  it('keeps a live task whose TYPE the SDK omitted', () => {
    // The field is optional in the declared shape. Dropping an unknown-typed
    // live task under-reports running work, and under-reporting is the
    // direction that loses results.
    const c = new BackgroundCommands();
    c.reconcile(level({ task_id: 'mystery' }));
    expect(c.size).toBe(1);
  });

  it('does not let a start edge resurrect work the level has dropped', () => {
    // The immortal-entry bug arriving through a different door: edges are an
    // optimisation, the level is the truth.
    const c = new BackgroundCommands();
    c.bind('ghost', 'toolu_1');
    expect(c.size).toBe(0);
    c.reconcile(level({ task_id: 'x', task_type: 'local_bash' }));
    c.done('x');
    c.bind('x', 'toolu_2');
    expect(c.size).toBe(0);
  });

  it('remembers the launching tool_use across level messages', () => {
    // The only thing that ties a running command back to a line in the
    // transcript, and the level signal does not carry it — so it has to
    // survive the wholesale replacement.
    const c = new BackgroundCommands();
    c.reconcile(level({ task_id: 'x', task_type: 'local_bash' }));
    c.bind('x', 'toolu_9');
    c.reconcile(level({ task_id: 'x', task_type: 'local_bash' }));
    expect(c.list()[0]?.toolUseId).toBe('toolu_9');
  });

  it('retires on a terminal edge without waiting for the next level tick', () => {
    const c = new BackgroundCommands();
    c.reconcile(level({ task_id: 'x', task_type: 'local_bash' }));
    c.done('x');
    expect(c.busy).toBe(false);
  });

  it('clears when the session is replaced', () => {
    // A new session's level signal describes a different process's work.
    const c = new BackgroundCommands();
    c.reconcile(level({ task_id: 'x', task_type: 'local_bash' }));
    c.clear();
    expect(c.size).toBe(0);
  });
});
