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
      onEvents: (es, phase) => {
        for (const e of es) events.push({ e, phase });
      },
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
      minHistoryLines: 1, // window-boundary behavior under test
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
      onEvents: (es, p) => {
        for (const e of es) events.push({ e, phase: p });
      },
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
      minHistoryLines: 1, // pure byte-window paging under test
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

  it('tailBytes: loadOlder makes progress past lines far larger than the window', () => {
    // A giant line (base64 image paste) directly before the tail used to
    // stall loadOlder forever: the window's only newline was its last byte,
    // so historyStart never moved and hasMore stayed true — zero events,
    // infinite loop ("chat shows one message and can't scroll").
    const texts = ['aa', 'bb'];
    const giant = userLine('big', 'X'.repeat(2000)); // ~16× the 120B window
    const last = userLine('u9', 'zz');
    writeFileSync(file, texts.map((t, i) => userLine(`u${i}`, t)).join('') + giant + last);
    const hist: string[] = [];
    const older: string[] = [];
    const tail = new TranscriptTail(SID, {
      dir,
      tailBytes: 120,
      minHistoryLines: 1, // pure byte-window paging under test
      onEvents: (es, p) => {
        for (const e of es) (p === 'older' ? older : hist).push((e as { text: string }).text);
      },
    });
    tail.tick();
    expect(hist).toEqual(['zz']); // the giant line ate the rest of the window

    let more = true;
    let guard = 30;
    while (more && guard-- > 0) more = tail.loadOlder();
    expect(more).toBe(false);
    expect(guard).toBeGreaterThan(0); // terminated, not guard-exhausted

    const all = [...hist, ...older].sort();
    expect(all).toEqual(['aa', 'bb', 'X'.repeat(2000), 'zz'].sort());
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

describe('TranscriptReader — muxpad-owned log (codex/cursor backends)', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;
  const CSID = 'codex-thread-1234';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'muxlog-'));
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dataDir;
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: restoring an env var that wasn't set
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('locate returns null until the log exists, then appendTranscriptEvent + identity tail replay it', async () => {
    const { appendTranscriptEvent, identityNormalize, muxpadLocate } = await import(
      './TranscriptReader.js'
    );
    // No log yet → locate null → tail emits nothing.
    expect(muxpadLocate(CSID)).toBeNull();
    const seen: ChatEvent[] = [];
    const tail = new TranscriptTail(CSID, {
      locate: muxpadLocate,
      normalize: identityNormalize,
      onEvents: (e) => seen.push(...e),
    });
    tail.tick();
    expect(seen).toEqual([]);

    // Runner writes ready-made ChatEvents; the identity tail replays them 1:1.
    appendTranscriptEvent(CSID, { kind: 'user', id: 'u1', ts: 1, text: 'hi' });
    appendTranscriptEvent(CSID, { kind: 'assistant', id: 'a1', ts: 2, text: 'yo', model: 'codex' });
    expect(muxpadLocate(CSID)).not.toBeNull();
    tail.tick();
    expect(seen).toEqual([
      { kind: 'user', id: 'u1', ts: 1, text: 'hi' },
      { kind: 'assistant', id: 'a1', ts: 2, text: 'yo', model: 'codex' },
    ]);
    tail.close();
  });
});

/**
 * THE WINDOW THAT WASN'T.
 *
 * `loadHistory` grows a tail window until it holds enough complete records,
 * capped at `tailBytes * 8`. If it finds NO newline in that whole window it used
 * to `readBytes(0, size)` — the entire transcript — which is the one outcome
 * windowing exists to prevent.
 *
 * It fires whenever a transcript's last record is bigger than the cap. These
 * files already contain such records: the conversation this was found on has six
 * lines over 1 MB in a 130 MB file. One of them landing last would have shipped
 * 130 MB through a websocket on every open, on every device.
 */
describe('a single oversized record cannot drag the whole file through the socket', () => {
  let dir: string;
  let file: string;
  const BIG_SID = 'ffffffff-1111-2222-3333-444444444444';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tr-big-'));
    const proj = join(dir, 'proj');
    mkdirSync(proj);
    file = join(proj, `${BIG_SID}.jsonl`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('skips history rather than reading the whole file, and tails live', () => {
    // Real records, then one final record longer than the 8× cap, unterminated
    // — exactly the shape that triggered it.
    const tailBytes = 1024; // cap is 8 KB
    const head = userLine('u1', 'early') + assistantLine('a1', 'also early');
    writeFileSync(
      file,
      `${head}${JSON.stringify({ type: 'user', uuid: 'huge', message: { role: 'user', content: 'x'.repeat(20_000) } })}`,
    );

    const events: Array<{ e: ChatEvent; phase: string }> = [];
    const tail = new TranscriptTail(BIG_SID, {
      dir,
      tailBytes,
      onEvents: (es, phase) => {
        for (const e of es) events.push({ e, phase });
      },
    });
    tail.tick();

    // No history at all — NOT the early records read from byte 0. Shipping them
    // would mean having read everything in between.
    expect(events).toEqual([]);
  });

  it('a later COMPLETE record still arrives live', () => {
    // The pane is thin, not broken: the unreadable record is dropped and the
    // conversation continues from the next newline.
    const tailBytes = 1024;
    writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        uuid: 'huge',
        message: { role: 'user', content: 'x'.repeat(20_000) },
      }),
    );
    const events: Array<{ e: ChatEvent; phase: string }> = [];
    const tail = new TranscriptTail(BIG_SID, {
      dir,
      tailBytes,
      onEvents: (es, phase) => {
        for (const e of es) events.push({ e, phase });
      },
    });
    tail.tick();
    expect(events).toEqual([]);

    appendFileSync(file, `\n${userLine('u2', 'after the monster')}`);
    tail.tick();
    expect(events.map((x) => x.e.kind)).toEqual(['user']);
    expect(events.map((x) => x.phase)).toEqual(['live']);
  });

  it('a file SMALLER than the window is still read whole', () => {
    // The guard must not catch the ordinary small-file case, which reaches the
    // same branch by a different route (`win >= size`).
    writeFileSync(file, userLine('u1', 'one') + assistantLine('a1', 'two'));
    const events: ChatEvent[] = [];
    const tail = new TranscriptTail(BIG_SID, {
      dir,
      tailBytes: 1024,
      onEvents: (es) => events.push(...es),
    });
    tail.tick();
    expect(events.map((e) => e.kind)).toEqual(['user', 'assistant']);
  });
});
