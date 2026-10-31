import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { branchPrefill, draftKeyFor } from './chat-branch';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('the branch prefill', () => {
  const text = branchPrefill({ name: 'Signal archive', paneId: '01HZZPANE000000000000000AB' });

  it('names the chat and the command that reads it', () => {
    expect(text).toContain('Signal archive');
    expect(text).toContain('muxpad agent transcript 01HZZPANE000000000000000AB');
  });

  it('ends mid-sentence, so the caret lands where the request goes', () => {
    // A complete prompt is a prompt somebody has to delete first. The one
    // thing this cannot know is what you branched in order to do.
    expect(text.trimEnd()).toMatch(/Then:$/);
    expect(text.endsWith(' ')).toBe(true);
  });

  it('says the source chat is still running and must not be messaged', () => {
    // A branch is a PEER, not a sub-chat: it reports to nobody and it must not
    // start a conversation in a chat the user walked away from.
    expect(text).toMatch(/still running/);
    expect(text).toMatch(/do not\s+message it/);
  });

  it('copies no context, and does not pretend to', () => {
    const src = readFileSync(join(HERE, 'chat-branch.ts'), 'utf8');
    // The reference is an instruction to go and read, which stays true as the
    // source chat keeps moving. A copied snapshot would not.
    expect(src).not.toMatch(/\bevents\b|transcriptText|copyContext/);
  });
});

describe('the draft key', () => {
  it('is the one ChatPane restores from, so a branch is an ordinary draft', () => {
    const pane = readFileSync(join(HERE, '..', 'components', 'ChatPane.tsx'), 'utf8');
    expect(pane).toContain('`muxpad.chatDraft.${paneId}`');
    expect(draftKeyFor('abc')).toBe('muxpad.chatDraft.abc');
  });
});
