import type { SubagentProgress } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { MAX_ROSTER_ENTRIES, SubagentRoster } from './subagent-roster.js';

/** Collects emitted frames and gives back a fresh roster wired to them. */
function make(startAt = 1_000) {
  const sent: SubagentProgress[] = [];
  const logs: string[] = [];
  let clock = startAt;
  const roster = new SubagentRoster(
    (p) => sent.push(p),
    (line) => logs.push(line),
    () => clock,
  );
  const tick = (ms: number): void => {
    clock += ms;
  };
  return { roster, sent, logs, tick };
}

describe('SubagentRoster — durability', () => {
  it('a launch is announced immediately, with its description', () => {
    // The launching tool_use is the ONLY message that carries the description,
    // and a background subagent's first child message can be a minute away.
    const { roster, sent } = make();
    roster.launch('tu_1', 'audit the pipeline');
    expect(roster.size).toBe(1);
    expect(sent).toEqual([
      { toolUseId: 'tu_1', steps: 0, label: 'audit the pipeline', seenAt: 1_000 },
    ]);
    // Idempotent — a replayed launch must not reset the counters.
    roster.activity('tu_1', 'Bash: pnpm test');
    roster.launch('tu_1', 'audit the pipeline');
    expect(roster.size).toBe(1);
    expect(roster.values()[0]?.steps).toBe(1);
  });

  it('survives arbitrarily long silence — there is no decay window', () => {
    // The whole point. Measured (P1, 2026-08): a live background subagent
    // parked in one tool call emits nothing for 44s+.
    const { roster, tick } = make();
    roster.launch('tu_1', 'worker');
    tick(10 * 60_000);
    expect(roster.size).toBe(1);
    roster.announceAll();
    expect(roster.size).toBe(1);
  });

  it('a keepalive re-announce does NOT freshen seenAt', () => {
    // The keepalive supplies liveness for the SERVER's copy; the per-row
    // busy/quiet dot must still reflect REAL activity, or every rostered
    // subagent would permanently read "busy" off our own heartbeat.
    const { roster, sent, tick } = make();
    roster.launch('tu_1', 'worker');
    tick(30_000);
    roster.announceAll();
    expect(sent.at(-1)?.seenAt).toBe(1_000);
    // Real activity is what moves it. (The frame itself is inside the throttle
    // window the keepalive just reset, so flush() to see it go out.)
    roster.activity('tu_1');
    roster.flush();
    expect(sent.at(-1)?.seenAt).toBe(31_000);
  });

  it('throttles progress, and flush() pushes the withheld frame WITHOUT dropping entries', () => {
    const { roster, sent, tick } = make();
    roster.launch('tu_1', 'worker');
    expect(sent).toHaveLength(1);
    roster.activity('tu_1', 'Read: a.ts'); // inside the 500ms throttle → withheld
    expect(sent).toHaveLength(1);
    tick(600);
    roster.activity('tu_1', 'Read: b.ts');
    expect(sent).toHaveLength(2);
    roster.activity('tu_1', 'Read: c.ts'); // withheld again
    expect(sent).toHaveLength(2);

    // flush() runs at every turn `result`. It must publish the withheld frame
    // and KEEP the entry — a background Task outlives the turn that made it.
    roster.flush();
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)?.lastTool).toBe('Read: c.ts');
    expect(roster.size).toBe(1);
    // Nothing withheld now → a second flush is silent.
    roster.flush();
    expect(sent).toHaveLength(3);
  });
});

describe('SubagentRoster — every end-path announces itself', () => {
  // Membership has no timer, so an end that goes unannounced is IMMORTAL: the
  // pane reads `working` until its runner process dies and the keepalive
  // re-announces the ghost forever. These are the three paths.

  it('1 + 2: an individual finish emits a terminal frame and drops the entry', () => {
    const { roster, sent } = make();
    roster.launch('tu_1', 'worker');
    roster.done('tu_1');
    expect(roster.size).toBe(0);
    expect(sent.at(-1)).toMatchObject({ toolUseId: 'tu_1', done: true });
    // Unknown / repeated ids are inert — no phantom terminal frames.
    const before = sent.length;
    roster.done('tu_1');
    roster.done('never-existed');
    expect(sent).toHaveLength(before);
  });

  it('3: retireAll clears a STOPPED turn’s background tasks (the immortality bug)', () => {
    // A Stop kills background subagents, and that death produces no
    // tool_result and no finish notice — so without this the entries would
    // never leave, the pane would read `working` forever, and the keepalive
    // would re-announce ghosts every 5s for the life of the session.
    const { roster, sent, tick } = make();
    roster.launch('tu_a', 'a');
    roster.launch('tu_b', 'b');
    tick(1_000);
    roster.retireAll('stopped');
    expect(roster.size).toBe(0);
    const terminal = sent.filter((p) => p.done);
    expect(terminal.map((p) => p.toolUseId).sort()).toEqual(['tu_a', 'tu_b']);

    // And the keepalive now has nothing to say.
    const before = sent.length;
    roster.announceAll();
    expect(sent).toHaveLength(before);
  });

  it('5: retireUnstarted clears a launch that never ran, and only that', () => {
    // A `Task` tool_use can be delivered and then RETRACTED (a refused leg
    // superseded by the fallback), or otherwise never execute: no task_started,
    // no tool_result, no child traffic, never in the level set. Not one of the
    // other end-paths can reach it, and on a SUCCESSFUL turn retireAll doesn't
    // run — so without this it is immortal.
    const { roster, sent, tick } = make();
    roster.launch('tu_retracted', 'never ran');
    roster.launch('tu_background', 'a real background agent');
    roster.launch('tu_foreground', 'a real foreground agent');
    roster.bindTask('tu_background', 'task_bg'); // it started
    tick(600);
    roster.activity('tu_foreground', 'Read: a.ts'); // it is working

    roster.retireUnstarted();
    expect(roster.values().map((p) => p.toolUseId)).toEqual(['tu_background', 'tu_foreground']);
    expect(sent.at(-1)).toMatchObject({ toolUseId: 'tu_retracted', done: true });

    // Emphatically NOT the turn-clearing regression: run it every turn for the
    // life of a long-lived background agent and it never touches it.
    for (let i = 0; i < 20; i++) roster.retireUnstarted();
    expect(roster.size).toBe(2);
  });

  it('retireAll on an empty roster is silent', () => {
    const { roster, sent } = make();
    roster.retireAll('turn failed');
    expect(sent).toHaveLength(0);
  });

  it('the map cannot grow across many stopped turns', () => {
    // The leak shape: launch a background task, Stop, repeat. Without
    // retireAll this map grows monotonically for the session's whole life.
    const { roster, tick } = make();
    for (let turn = 0; turn < 50; turn++) {
      roster.launch(`tu_${turn}`, `worker ${turn}`);
      tick(1_000);
      roster.flush();
      roster.retireAll('stopped');
    }
    expect(roster.size).toBe(0);
  });
});

describe('SubagentRoster — membership is TOP-LEVEL launches only', () => {
  // The over-counting bug. A subagent can spawn its own subagents, and a
  // NESTED agent's traffic arrives on the SAME top-level SDK stream carrying
  // the NESTED tool_use id (probe-verified, SDK 0.3.220). Its launch and its
  // end, though, both live inside its parent's stream — so an entry adopted
  // from that traffic is structurally immortal.
  //
  // Live evidence (pane 01KX6GKF…, 2026-08): 19 rostered, 7 real. The other 12
  // were depth-2/3 grandchildren of three research fan-outs that had all
  // finished — every one of them adopted, none of them retirable.

  it('ignores traffic from an id it never saw launched', () => {
    const { roster, sent } = make();
    roster.activity('tu_grandchild', 'WebFetch: https://example.com');
    expect(roster.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('a research fan-out does not inflate the count', () => {
    // Two top-level background agents; each spawns five of its own. Only the
    // two the chat can actually render belong in the roster.
    const { roster, tick } = make();
    roster.launch('tu_parent_a', 'strategy scout');
    roster.launch('tu_parent_b', 'agent UX research');
    for (let i = 0; i < 5; i++) {
      tick(600);
      roster.activity(`tu_nested_a${i}`, 'WebSearch: …');
      roster.activity(`tu_nested_b${i}`, 'WebSearch: …');
      // The parents' own traffic still counts.
      roster.activity('tu_parent_a', 'Read: notes.md');
    }
    expect(roster.size).toBe(2);
    expect(
      roster
        .values()
        .map((p) => p.toolUseId)
        .sort(),
    ).toEqual(['tu_parent_a', 'tu_parent_b']);
  });

  it('a nested agent finishing cannot retire a top-level entry it shadows', () => {
    // done() on an id we never launched is inert — no phantom terminal frames
    // to the server, which would drop a REAL row.
    const { roster, sent } = make();
    roster.launch('tu_parent', 'parent');
    const before = sent.length;
    roster.done('tu_nested');
    expect(roster.size).toBe(1);
    expect(sent).toHaveLength(before);
  });
});

describe('SubagentRoster — reconciliation against the SDK level signal', () => {
  // `system/background_tasks_changed` carries the COMPLETE set of live
  // background tasks after every membership change (REPLACE semantics). It is
  // the only source of truth a missed edge cannot wedge.

  it('retires an entry whose background task has left the live set', () => {
    const { roster, sent } = make();
    roster.launch('tu_1', 'worker');
    roster.reconcileBackground(['task_1']); // level lands first…
    roster.bindTask('tu_1', 'task_1'); // …then the edge that names it
    expect(roster.size).toBe(1);

    // Its finish edge never arrives (dropped frame, harness quirk, whatever).
    // The next level payload is enough.
    roster.reconcileBackground([]);
    expect(roster.size).toBe(0);
    expect(sent.at(-1)).toMatchObject({ toolUseId: 'tu_1', done: true });
  });

  it('reconciles when the edge lands BEFORE the level (ordering is unspecified)', () => {
    const { roster } = make();
    roster.launch('tu_1', 'worker');
    roster.bindTask('tu_1', 'task_1');
    roster.reconcileBackground(['task_1']);
    expect(roster.size).toBe(1);
    roster.reconcileBackground([]);
    expect(roster.size).toBe(0);
  });

  it('never sweeps a FOREGROUND task, which is absent from that payload by design', () => {
    // A foreground Task retires on its own tool_result. It never appears in the
    // background level set, so its absence must mean nothing.
    const { roster } = make();
    roster.launch('tu_fg', 'foreground worker');
    roster.bindTask('tu_fg', 'task_fg');
    roster.reconcileBackground([]); // never seen live in the background set
    roster.reconcileBackground(['task_other']);
    expect(roster.size).toBe(1);
    roster.done('tu_fg'); // its tool_result
    expect(roster.size).toBe(0);
  });

  it('leaves entries with no bound task id alone', () => {
    const { roster } = make();
    roster.launch('tu_1', 'worker'); // task_started not seen yet
    roster.reconcileBackground(['task_other']);
    expect(roster.size).toBe(1);
  });

  it('keeps a still-live sibling while retiring the finished one', () => {
    const { roster } = make();
    roster.launch('tu_a', 'a');
    roster.launch('tu_b', 'b');
    roster.bindTask('tu_a', 'task_a');
    roster.bindTask('tu_b', 'task_b');
    roster.reconcileBackground(['task_a', 'task_b']);
    roster.reconcileBackground(['task_b']);
    expect(roster.values().map((p) => p.toolUseId)).toEqual(['tu_b']);
  });

  it('bindTask ignores ids it never launched (nested agents, background Bash)', () => {
    const { roster } = make();
    roster.bindTask('tu_nested', 'task_nested');
    roster.reconcileBackground([]);
    expect(roster.size).toBe(0);
  });

  it('resurrects a RESUMED agent, on its original row', () => {
    // Probe-verified (SDK 0.3.220): a finished background agent that is resumed
    // (`SendMessage`) re-enters the live set under the SAME task id, but the
    // new `task_started` / `task_notification` carry the RESUMING call's
    // tool_use id — while its child messages still carry the original launch's.
    // Without resurrection the row would be gone and could never come back:
    // `activity` no longer adopts, so nothing else would ever re-create it.
    const { roster, sent, tick } = make();
    roster.launch('tu_1', 'sleeper');
    roster.bindTask('tu_1', 'task_1');
    roster.reconcileBackground(['task_1']);
    tick(600);
    roster.activity('tu_1', 'Bash: sleep 3');
    roster.done('tu_1'); // its task_notification
    expect(roster.size).toBe(0);

    // Resumed: the level signal names task_1 again, and the resuming
    // SendMessage id is NOT a launch we know.
    tick(10_000);
    roster.bindTask('tu_sendmessage', 'task_1');
    roster.reconcileBackground(['task_1']);
    expect(roster.size).toBe(1);
    const back = roster.values()[0];
    expect(back?.toolUseId).toBe('tu_1'); // the original row, not the resume's
    expect(back?.label).toBe('sleeper');
    expect(back?.steps).toBe(1); // continues, does not restart at zero
    expect(sent.at(-1)).toMatchObject({ toolUseId: 'tu_1', label: 'sleeper' });

    // …and it still ends properly the second time.
    roster.reconcileBackground([]);
    expect(roster.size).toBe(0);
  });

  it('resurrection cannot smuggle in a NESTED agent', () => {
    // A grandchild's task id is never bound to a launch, so it is never
    // remembered — a level payload naming it creates nothing.
    const { roster } = make();
    roster.bindTask('tu_nested', 'task_nested'); // ignored: never launched
    roster.reconcileBackground(['task_nested']);
    roster.reconcileBackground(['task_nested']);
    expect(roster.size).toBe(0);
  });

  it('does not resurrect a task that simply stayed finished', () => {
    const { roster } = make();
    roster.launch('tu_1', 'worker');
    roster.bindTask('tu_1', 'task_1');
    roster.reconcileBackground(['task_1']);
    roster.reconcileBackground([]);
    expect(roster.size).toBe(0);
    roster.reconcileBackground([]);
    roster.announceAll();
    expect(roster.size).toBe(0);
  });

  it('never leaks its bookkeeping onto the wire', () => {
    const { roster, sent } = make();
    roster.launch('tu_1', 'worker');
    roster.bindTask('tu_1', 'task_1');
    roster.reconcileBackground(['task_1']);
    roster.announceAll();
    for (const p of sent) {
      expect(p).not.toHaveProperty('taskId');
      expect(p).not.toHaveProperty('background');
      expect(p).not.toHaveProperty('lastSentAt');
      expect(p).not.toHaveProperty('dirty');
    }
  });
});

describe('SubagentRoster — the cap is a bound, not a policy', () => {
  it('never exceeds the cap, retiring the STALEST entry and logging once', () => {
    const { roster, sent, logs, tick } = make();
    for (let i = 0; i < MAX_ROSTER_ENTRIES + 5; i++) {
      tick(1_000);
      roster.launch(`tu_${i}`, `worker ${i}`);
    }
    expect(roster.size).toBe(MAX_ROSTER_ENTRIES);
    // The five evicted are the five oldest, and each left with a terminal
    // frame so the server's mirror agrees.
    const retired = sent.filter((p) => p.done).map((p) => p.toolUseId);
    expect(retired).toEqual(['tu_0', 'tu_1', 'tu_2', 'tu_3', 'tu_4']);
    // Loud, but not once per launch.
    expect(logs.filter((l) => l.includes('cap'))).toHaveLength(1);
  });
});
