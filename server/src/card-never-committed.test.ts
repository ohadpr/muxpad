import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE STORED CARD IS NOT IN THIS REPOSITORY, AND THIS REPOSITORY IS PUBLIC.
 *
 * Not a hypothetical. While documenting `muxpad pay`, an agent wrote the
 * example card block straight from the real file — the actual sixteen digits,
 * in `docs/connectors.md`, staged. It was caught by eye one command before the
 * commit, and by eye is not a control.
 *
 * `scripts/hooks/pre-commit` is the control; this is the backstop for a clone
 * that never ran `scripts/install-hooks.sh`, and the thing that notices a
 * number already in the tree.
 *
 * It reads the card only to know what to look FOR, never prints it, and skips
 * entirely when there is no card on this machine — so it is a no-op for
 * everybody but the person who stored one.
 */
const CARD =
  process.env.MUXPAD_CARD_FILE ?? join(homedir(), '.config', 'muxpad', 'payment-card.json');

describe('the stored card', () => {
  it('appears nowhere in the working tree', () => {
    if (!existsSync(CARD)) return; // no card on this machine — nothing to leak
    let num: string;
    try {
      num = String(JSON.parse(readFileSync(CARD, 'utf8')).num ?? '').replace(/\D/g, '');
    } catch {
      return; // an unreadable card file is not this test's business
    }
    if (num.length < 12) return;

    // Every spelling a careless paste might take.
    const spellings = [
      num,
      num.replace(/(.{4})/g, '$1 ').trim(),
      num.replace(/(.{4})/g, '$1-').replace(/-$/, ''),
    ];
    const root = join(import.meta.dirname, '..', '..');
    const args = ['grep', '-l', '-I', '--no-color'];
    for (const s of spellings) args.push('-e', s);
    let found = '';
    try {
      // `git grep` searches tracked files; it exits 1 with no output when
      // there is no match, which is the case this test wants.
      found = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    } catch {
      found = '';
    }
    expect(found.trim(), 'files containing the stored card number').toBe('');
  });
});
