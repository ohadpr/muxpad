import type { SubagentProgress } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { SubagentRoster } from './subagent-roster.js';

/** Collects emitted frames and gives back a fresh roster wired to them. */
function make(startAt = 1_000) {
  const sent: SubagentProgress[] = [];
  let clock = startAt;
  const roster = new SubagentRoster(
    (p) => sent.push(p),
    () => {},
    () => clock,
  );
  const tick = (ms: number): void => {
    clock += ms;
  };
  return { roster, sent, tick };
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
