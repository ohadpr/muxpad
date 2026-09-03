import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import {
  AGENT_BACKENDS,
  HOUSE_CHAT_CREATE,
  HOUSE_CHAT_PANE_CREATE,
  backendLabel,
  conversionFailure,
  isPendingHarnessPick,
} from './agent-backend';

describe('the house chat', () => {
  it('is a claude agent pane wearing the house overlay, with NO pinned model', () => {
    expect(HOUSE_CHAT_CREATE).toEqual({ bootstrap: 'agent', backend: 'claude', mode: 'do' });
    // A pinned model here would silently override the account default and go
    // stale as models ship.
    expect(JSON.stringify(HOUSE_CHAT_CREATE)).not.toContain('model');
  });

  it('the pane form runs the same command a house-chat TAB runs', () => {
    expect(HOUSE_CHAT_PANE_CREATE).toEqual({
      startup_cmd: 'muxpad agent --mode do',
      face: 'chat',
      mode: 'do',
    });
  });

  it('names every backend exactly once', () => {
    expect(AGENT_BACKENDS.map((b) => b.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(backendLabel('codex')).toBe('Codex');
  });

  it('still recognises a legacy --pick pane', () => {
    expect(isPendingHarnessPick('muxpad agent --pick')).toBe(true);
    expect(isPendingHarnessPick('muxpad agent --backend codex --pick')).toBe(true);
    expect(isPendingHarnessPick('muxpad agent --mode do')).toBe(false);
    expect(isPendingHarnessPick(null)).toBe(false);
  });
});

/**
 * EVERY "+" MAKES THE SAME THING.
 *
 * This is the regression that shipped: four buttons all worded "+ New tab",
 * three of which quietly passed `bootstrap: 'shell'` and made a terminal
 * instead. Nothing said so, so which one you pressed silently decided what you
 * got. A unit test on the constant could not have caught it — the constant was
 * always right; the CALL SITES disagreed with it. So this scans them.
 *
 * The rule: every `api.createTab` / `api.createPane` call in the app spreads a
 * HOUSE_CHAT_* constant, unless it is on the deliberate, documented allowlist
 * below. Add a call site that opens a bare shell and this fails.
 */
describe('every creation path', () => {
  const srcRoot = join(import.meta.dirname, '..');

  /** Call sites that are NOT the "+" button and are deliberately different. */
  const ALLOWED: Array<{ file: string; why: string }> = [
    {
      file: 'lib/doc-store.ts',
      why: 'the document surface builds its own pane kind, not a "+ New tab"',
    },
  ];

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
    });

  const sites = walk(srcRoot).flatMap((file) => {
    const rel = file.slice(srcRoot.length + 1);
    const src = readFileSync(file, 'utf8');
    const out: Array<{ rel: string; call: string }> = [];
    for (const m of src.matchAll(/api\.create(?:Tab|Pane)\(/g)) {
      // Take a generous window — the argument object is multi-line.
      out.push({ rel, call: src.slice(m.index, m.index + 400) });
    }
    return out;
  });

  it('finds the creation call sites at all (the scan is not vacuous)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it('opens the house chat — no call site quietly makes a bare shell', () => {
    const offenders = sites
      .filter((s) => !ALLOWED.some((a) => a.file === s.rel))
      .filter((s) => !/HOUSE_CHAT_(CREATE|PANE_CREATE)/.test(s.call))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  it('nothing passes bootstrap:"shell" any more', () => {
    const offenders = sites.filter((s) => /bootstrap:\s*'shell'/.test(s.call)).map((s) => s.rel);
    expect(offenders).toEqual([]);
  });
});

describe('a refused conversion', () => {
  it('marks has_messages as REFUSED and as evidence our render was wrong', () => {
    const e = new ApiError(
      'this chat already has messages — open a new tab instead',
      409,
      'has_messages',
    );
    expect(conversionFailure(e, 'fallback')).toEqual({
      message: 'this chat already has messages — open a new tab instead',
      refused: true,
      hasMessages: true,
    });
  });

  it('mid_turn is refused but is NOT evidence of messages — the chat is still empty', () => {
    // Flipping hasMessages here would strand a genuinely empty chat on a
    // "Loading conversation…" spinner with nothing to load.
    const e = new ApiError('this chat is mid-turn — wait for it to finish', 409, 'mid_turn');
    expect(conversionFailure(e, 'x')).toEqual({
      message: 'this chat is mid-turn — wait for it to finish',
      refused: true,
      hasMessages: false,
    });
  });

  it('does NOT mark other failures refused — those are retryable', () => {
    expect(conversionFailure(new ApiError('ptyd is unreachable', 503), 'x').refused).toBe(false);
    expect(conversionFailure(new TypeError('network'), 'x')).toEqual({
      message: 'network',
      refused: false,
      hasMessages: false,
    });
  });

  it('falls back to a human sentence when the throw carries none', () => {
    expect(conversionFailure({}, 'could not start the agent')).toEqual({
      message: 'could not start the agent',
      refused: false,
      hasMessages: false,
    });
  });
});
