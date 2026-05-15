import { describe, it, expect } from 'vitest';
import { PaneRuntime, prettifyCommand } from './PaneRuntime.js';

describe('prettifyCommand', () => {
  it('strips absolute path from argv[0]', () => {
    expect(prettifyCommand('/usr/local/bin/pnpm dev:tui')).toBe('pnpm dev:tui');
  });

  it('preserves a basename-only argv[0]', () => {
    expect(prettifyCommand('vim foo.ts')).toBe('vim foo.ts');
  });

  it('does not rewrite node-script invocations', () => {
    expect(prettifyCommand('/usr/local/bin/node /path/to/pnpm.cjs dev:tui')).toBe(
      'node /path/to/pnpm.cjs dev:tui',
    );
  });

  it('handles empty input', () => {
    expect(prettifyCommand('')).toBe('');
    expect(prettifyCommand('   ')).toBe('');
  });

  it('collapses runs of whitespace to single spaces', () => {
    expect(prettifyCommand('/usr/bin/zsh   --no-rcs')).toBe('zsh --no-rcs');
  });
});

describe('PaneRuntime', () => {
  it('auto-types startup command into shell, then stays at the prompt', async () => {
    const runtime = new PaneRuntime({
      id: 'p1',
      shell: '/bin/sh',
      startup_cmd: 'echo hello-world',
      cwd: '/tmp',
    });
    const collected: string[] = [];
    runtime.on('output', (s) => collected.push(s));
    runtime.start();
    await new Promise((r) => setTimeout(r, 500));
    expect(collected.join('')).toContain('hello-world');
    expect(runtime.isExited()).toBe(false);
    expect(runtime.snapshot()).toContain('hello-world');
    runtime.kill();
    await new Promise<void>((resolve) => runtime.on('exit', () => resolve()));
    expect(runtime.isExited()).toBe(true);
  });

  it('broadcasts output to multiple listeners', async () => {
    const runtime = new PaneRuntime({
      id: 'p2',
      shell: '/bin/sh',
      startup_cmd: 'echo broadcast',
      cwd: '/tmp',
    });
    const a: string[] = [];
    const b: string[] = [];
    runtime.on('output', (s) => a.push(s));
    runtime.on('output', (s) => b.push(s));
    runtime.start();
    await new Promise((r) => setTimeout(r, 500));
    expect(a.join('')).toContain('broadcast');
    expect(b.join('')).toContain('broadcast');
    runtime.kill();
    await new Promise<void>((resolve) => runtime.on('exit', () => resolve()));
  });

  it('forwards input to the PTY', async () => {
    const runtime = new PaneRuntime({ id: 'p3', shell: '/bin/cat', cwd: '/tmp' });
    runtime.start();
    const collected: string[] = [];
    runtime.on('output', (s) => collected.push(s));
    runtime.write('echo-back\n');
    await new Promise((r) => setTimeout(r, 200));
    runtime.kill();
    await new Promise<void>((resolve) => runtime.on('exit', () => resolve()));
    expect(collected.join('')).toContain('echo-back');
  });

  it('captures snapshot of accumulated output', async () => {
    const runtime = new PaneRuntime({
      id: 'p4',
      shell: '/bin/sh',
      startup_cmd: 'echo line1; echo line2',
      cwd: '/tmp',
    });
    runtime.start();
    await new Promise((r) => setTimeout(r, 500));
    const snap = runtime.snapshot();
    expect(snap).toContain('line1');
    expect(snap).toContain('line2');
    runtime.kill();
    await new Promise<void>((resolve) => runtime.on('exit', () => resolve()));
  });

  it('cancels pending startup-cmd write when killed before delay elapses', async () => {
    // Kill the runtime before the 50ms startup-cmd timer fires; if the timer
    // is not cancelled, it will try to write to a dead PTY (and on Linux can
    // throw EIO/EPIPE).
    const runtime = new PaneRuntime({
      id: 'p-cancel',
      shell: '/bin/sh',
      startup_cmd: 'echo should-not-run',
      cwd: '/tmp',
    });
    runtime.start();
    runtime.kill();
    await new Promise<void>((resolve) => runtime.on('exit', () => resolve()));
    // Wait past the original 50ms timer to be sure it would have fired.
    await new Promise((r) => setTimeout(r, 100));
    expect(runtime.snapshot()).not.toContain('should-not-run');
  });

  it('resizes the PTY last-writer-wins across clients', async () => {
    const runtime = new PaneRuntime({ id: 'p-size', shell: '/bin/sh', cwd: '/tmp' });
    runtime.start();
    runtime.setClientSize('a', 200, 50);
    expect(runtime.cols).toBe(200);
    expect(runtime.rows).toBe(50);
    expect(runtime.clientCount()).toBe(1);
    // A second client's resize wins outright — no MIN arbitration.
    runtime.setClientSize('b', 80, 24);
    expect(runtime.cols).toBe(80);
    expect(runtime.rows).toBe(24);
    expect(runtime.clientCount()).toBe(2);
    // The first client re-asserting (e.g. on tab-visibility) reclaims size.
    runtime.setClientSize('a', 200, 50);
    expect(runtime.cols).toBe(200);
    expect(runtime.rows).toBe(50);
    // Disconnecting a client never recomputes — the PTY keeps its last size.
    runtime.removeClient('a');
    expect(runtime.cols).toBe(200);
    expect(runtime.clientCount()).toBe(1);
    runtime.removeClient('b');
    expect(runtime.cols).toBe(200);
    expect(runtime.clientCount()).toBe(0);
    runtime.kill();
    await new Promise<void>((resolve) => runtime.on('exit', () => resolve()));
  });

  it('emits exit when the shell exits naturally', async () => {
    // Auto-type `exit` into the shell — it should terminate cleanly.
    const runtime = new PaneRuntime({
      id: 'p5',
      shell: '/bin/sh',
      startup_cmd: 'exit 0',
      cwd: '/tmp',
    });
    runtime.start();
    const code = await new Promise<number>((resolve) => runtime.on('exit', resolve));
    expect(code).toBe(0);
    expect(runtime.isExited()).toBe(true);
  });
});
