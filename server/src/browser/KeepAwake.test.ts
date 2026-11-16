import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { KEEP_AWAKE_SECONDS, KeepAwake } from './KeepAwake.js';

const fakeSpawn = () => {
  const calls: Array<{ cmd: string; args: string[]; child: EventEmitter & { killed: boolean } }> =
    [];
  const run = (cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill() {
        child.killed = true;
        return true;
      },
    });
    calls.push({ cmd, args, child });
    return child as unknown as ChildProcess;
  };
  return { calls, run };
};

describe('holding the machine awake for a person on their way', () => {
  it('runs the system caffeinate, idle-sleep only, and bounded', () => {
    const { calls, run } = fakeSpawn();
    new KeepAwake('darwin', run).hold('shopping');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('/usr/bin/caffeinate');
    expect(calls[0]?.args).toEqual(['-i', '-t', String(KEEP_AWAKE_SECONDS)]);
  });

  it('lets go on handback', () => {
    const { calls, run } = fakeSpawn();
    const k = new KeepAwake('darwin', run);
    k.hold('shopping');
    k.release('shopping');
    expect(calls[0]?.child.killed).toBe(true);
    expect(k.holding()).toEqual([]);
  });

  it('restarts the clock on a second summons rather than stacking holds', () => {
    const { calls, run } = fakeSpawn();
    const k = new KeepAwake('darwin', run);
    k.hold('shopping');
    k.hold('shopping');
    expect(calls[0]?.child.killed).toBe(true);
    expect(k.holding()).toEqual(['shopping']);
  });

  it('does nothing off macOS', () => {
    const { calls, run } = fakeSpawn();
    new KeepAwake('linux', run).hold('shopping');
    expect(calls).toEqual([]);
  });
});
