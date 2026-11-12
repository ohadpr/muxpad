import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MUTE_RUNNER_DETAIL, MUTE_RUNNER_LINE } from './lib/voice/session';

/**
 * "PANE" IS HOW THE SERVER STORES A ROW, NOT WHAT A PERSON CALLS IT.
 *
 * A sidebar row holds one thing — a chat, an agent or a terminal — and the
 * word for the storage had leaked into tooltips, menus, empty states and
 * errors. This pins the surfaces a person reads: the attributes a browser
 * shows or announces, the error notices, and the window title. Identifiers,
 * class names, event names and comments are free to keep the word; they are
 * read by nobody but us.
 *
 * Line-based and deliberately narrow, so a hit is always a real sentence and
 * never a variable name. A string that has to say "pane" can't, here — find
 * the reader's word instead (`rowNoun` in @muxpad/shared names the row).
 */
const SRC = import.meta.dirname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const VISIBLE = [
  // What a tooltip shows and a screen reader says.
  /\b(?:title|aria-label|placeholder|idleTitle|armedTitle|armedLabel|label)=["{`][^"`\n]*\bpanes?\b/i,
  // Errors raised to the notice tray, and the browser tab's title.
  /\b(?:noticeFromError|useDocumentTitle)\([^)\n]*\bpanes?\b/i,
  // JSX text on one line: `>Close pane<`.
  />[^<>{}\n]*\bpanes?\b[^<>{}\n]*</i,
];

describe('the word "pane" never reaches a person', () => {
  it('is in no tooltip, label, notice or title in the web source', () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (/^(\/\/|\/?\*|\{\/\*)/.test(code)) return;
          if (VISIBLE.some((re) => re.test(line))) hits.push(`${relative(SRC, file)}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('is not in what voice says aloud, or the line shown when it hangs up', () => {
    expect(MUTE_RUNNER_LINE).not.toMatch(/\bpanes?\b/i);
    expect(MUTE_RUNNER_DETAIL).not.toMatch(/\bpanes?\b/i);
  });
});
