import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptTail, findTranscript } from './TranscriptReader.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function userLine(uuid: string, text: string): string {
  return `${JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } })}\n`;
}
function assistantLine(uuid: string, text: string): string {
  return `${JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text }] } })}\n`;
}

describe('TranscriptReader', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tr-'));
    const proj = join(dir, 'some-project');
    mkdirSync(proj);
    file = join(proj, `${SID}.jsonl`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('findTranscript locates the file by session-id across project dirs', () => {
    writeFileSync(file, userLine('u1', 'hi'));
    expect(findTranscript(SID, dir)).toBe(file);
    expect(findTranscript('no-such-id', dir)).toBeNull();
  });

  it('returns null (no throw) until the file exists', () => {
    const seen: ChatEvent[] = [];
    const tail = new TranscriptTail(SID, { dir, onEvents: (e) => seen.push(...e) });
    tail.tick(); // file absent → no-op
    expect(seen).toHaveLength(0);
  });

  it('emits existing content as history, then appends as live', () => {
    writeFileSync(file, userLine('u1', 'hello') + assistantLine('a1', 'hi there'));
    const events: Array<{ e: ChatEvent; phase: string }> = [];
    const tail = new TranscriptTail(SID, {
      dir,
      onEvents: (es, phase) => es.forEach((e) => events.push({ e, phase })),
    });
    tail.tick();
    expect(events.map((x) => x.phase)).toEqual(['history', 'history']);
    expect(events.map((x) => x.e.kind)).toEqual(['user', 'assistant']);

    appendFileSync(file, userLine('u2', 'again'));
    tail.tick();
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ phase: 'live', e: { kind: 'user', text: 'again' } });
    tail.close();
  });

  it('fires onTitle for ai-title records on history and live, but not older pages', () => {
    const titleLine = (t: string) =>
      `${JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: SID })}\n`;
    // Padding so the tailBytes window starts after the first title — that
    // older title must only surface via loadOlder, which must NOT fire onTitle.
    const pad = userLine('u1', 'x'.repeat(300));
    writeFileSync(file, titleLine('Old stale title') + pad + titleLine('Current title'));
    const titles: string[] = [];
    const tail = new TranscriptTail(SID, {
      dir,
      tailBytes: 128,
      onEvents: () => {},
      onTitle: (t) => titles.push(t),
    });
    tail.tick();
    expect(titles).toEqual(['Current title']);
    tail.loadOlder(); // pages in the old title's chunk — must stay silent
    expect(titles).toEqual(['Current title']);
    appendFileSync(file, titleLine('Renamed live'));
    tail.tick();
    expect(titles).toEqual(['Current title', 'Renamed live']);
    tail.close();
  });

  it('does not parse a half-written trailing line until its newline lands', () => {
    const seen: ChatEvent[] = [];
    const tail = new TranscriptTail(SID, { dir, onEvents: (e) => seen.push(...e) });
    // Write a complete line + a partial (no trailing newline yet).
    const partial = JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'world' } });
    writeFileSync(file, `${userLine('u1', 'hello').trimEnd()}\n${partial}`);
    tail.tick();
    expect(seen).toHaveLength(1); // only the complete first line
    expect(seen[0]).toMatchObject({ kind: 'user', text: 'hello' });
    // Now complete the partial line.
    appendFileSync(file, '\n');
    tail.tick();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ kind: 'user', text: 'world' });
    tail.close();
  });

  it('resets and re-emits as history when the file is rewritten smaller (compaction)', () => {
    writeFileSync(file, userLine('u1', 'a') + userLine('u2', 'b') + userLine('u3', 'c'));
    const events: Array<{ e: ChatEvent; phase: string }> = [];
    const tail = new TranscriptTail(SID, {
      dir,
      onEvents: (es, p) => es.forEach((e) => events.push({ e, phase: p })),
    });
    tail.tick();
    expect(events).toHaveLength(3);
    // Rewrite the file smaller (a compaction summary).
    truncateSync(file, 0);
    writeFileSync(file, userLine('s1', 'summary'));
    tail.tick();
    const last = events[events.length - 1];
    expect(last).toMatchObject({ phase: 'history', e: { kind: 'user', text: 'summary' } });
    tail.close();
  });

  it('tailBytes: initial load is the recent tail; loadOlder pages the rest', () => {
    const texts = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'];
    writeFileSync(file, texts.map((t, i) => userLine(`u${i}`, t)).join(''));
    const hist: string[] = [];
    const older: string[] = [];
    const tail = new TranscriptTail(SID, {
      dir,
      tailBytes: 120,
      onEvents: (es, p) => {
        for (const e of es) (p === 'older' ? older : hist).push((e as { text: string }).text);
      },
    });
    tail.tick();
    // Only a suffix loaded initially (not the whole file), and it IS a suffix.
    expect(hist.length).toBeGreaterThan(0);
    expect(hist.length).toBeLessThan(texts.length);
    expect(hist).toEqual(texts.slice(texts.length - hist.length));

    // Page backward until the file start is reached.
    let more = true;
    let guard = 20;
    while (more && guard-- > 0) more = tail.loadOlder();
    expect(more).toBe(false);

    // Every line accounted for exactly once, no dupes, across history + older.
    const all = [...hist, ...older].sort();
    expect(all).toEqual([...texts].sort());
    expect(new Set(all).size).toBe(texts.length);
    tail.close();
  });

  it('tailBytes: appended lines still stream as live after a tail load', () => {
    writeFileSync(file, ['aa', 'bb', 'cc'].map((t, i) => userLine(`u${i}`, t)).join(''));
    const live: string[] = [];
    const tail = new TranscriptTail(SID, {
      dir,
      tailBytes: 60,
      onEvents: (es, p) => {
        if (p === 'live') for (const e of es) live.push((e as { text: string }).text);
      },
    });
    tail.tick();
    appendFileSync(file, userLine('u9', 'zz'));
    tail.tick();
    expect(live).toEqual(['zz']);
    tail.close();
  });

  it('loadOlder returns false when no tail window was ever used (whole file loaded)', () => {
    writeFileSync(file, userLine('u1', 'only'));
    const tail = new TranscriptTail(SID, { dir, onEvents: () => {} });
    tail.tick();
    expect(tail.loadOlder()).toBe(false);
    tail.close();
  });

  it('skips torn/garbage lines without breaking the feed', () => {
    writeFileSync(
      file,
      `${userLine('u1', 'ok').trimEnd()}\n{not json\n${assistantLine('a1', 'still here').trimEnd()}\n`,
    );
    const seen: ChatEvent[] = [];
    const tail = new TranscriptTail(SID, { dir, onEvents: (e) => seen.push(...e) });
    tail.tick();
    expect(seen.map((e) => e.kind)).toEqual(['user', 'assistant']);
    tail.close();
  });
});
