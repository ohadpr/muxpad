import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(import.meta.dirname, 'MachinesSettings.tsx'), 'utf8');
const MENU = readFileSync(join(import.meta.dirname, 'SettingsMenu.tsx'), 'utf8');
const CSS = readFileSync(join(import.meta.dirname, 'SettingsMenu.css'), 'utf8');

describe('Settings → Machines', () => {
  it('is a section in the settings dialog', () => {
    expect(MENU).toContain("'machines'");
    expect(MENU).toContain('<MachinesSettings />');
  });

  /**
   * PAIRING IS HALF A DIALOG AND SAYS SO. This machine's half is automatic —
   * the server mints the credential and writes it 0600 — and what is left for
   * a person is one line on the other box, which is what the form hands back.
   */
  describe('pairing', () => {
    const jsx = SRC.slice(SRC.indexOf('export function MachinesSettings'));

    it('mints through POST /api/nodes and shows what to run over there', () => {
      expect(jsx).toMatch(/'\/api\/nodes',\s*\{\s*\n?\s*method: 'POST'/);
      expect(jsx).toMatch(/paired\.install/);
    });

    it('does not pretend to have finished', () => {
      // The other machine needs the repo and a build; a form that said
      // "paired" and stopped would be describing half an operation.
      expect(SRC).toMatch(/needs the muxpad repo and a build/i);
    });

    it('says why this machine issues the credential', () => {
      expect(SRC).toMatch(/unauthenticated listener/i);
    });

    it('forgets a machine, but never offers it for THIS one', () => {
      // `local` has no endpoint, and that is the condition the button is
      // behind — a cockpit cannot be configured out of existence.
      expect(jsx).toMatch(/n\.endpoint \? \(/);
      expect(jsx).toMatch(/Forget this machine/);
    });

    it('shows the server’s refusal verbatim rather than retrying with force', () => {
      // "1 pane still live on that machine" is the whole answer, and a confirm
      // here would be a button that deletes conversations.
      expect(jsx).toMatch(/setPairError\(messageOf\(e\)\)/);
      expect(jsx).not.toMatch(/force=1/);
    });
  });

  /**
   * THE DEFAULT-HOST PICKER. Held back until a chat on another machine worked
   * end to end; it does, and this is what makes more than one machine usable
   * rather than a toggle you forget.
   */
  describe('where new chats go', () => {
    const jsx = SRC.slice(SRC.indexOf('export function MachinesSettings'));

    it('is a select per workspace, over the machine list', () => {
      expect(jsx).toMatch(/<select/);
      expect(jsx).toMatch(/machines-default-hosts/);
      expect(jsx).toMatch(/default_node_id/);
    });

    it('hides itself on a one-machine install — one option is not a question', () => {
      expect(jsx).toMatch(/nodes\.length > 1/);
    });

    it('sends `null` for this machine, not the string `local`', () => {
      // The column means "somewhere else"; storing 'local' in it would make
      // every fallback path have two values to mean the same thing.
      expect(jsx).toMatch(/nodeId === LOCAL \? null : nodeId/);
    });

    it('rolls the select back when the write fails', () => {
      // The select IS the feedback here, so an optimistic value left behind
      // after a failure is a lie about where the next chat will open.
      expect(jsx).toMatch(/default_node_id: before/);
    });

    it('says what happens when that machine is away', () => {
      expect(SRC).toMatch(/falls back to this/i);
    });
  });

  it('keeps all FOUR states distinct', () => {
    // `unauthorized` must not read as `down`: it is a machine running fine
    // with no token here, and showing it as offline sends you to restart a
    // healthy VM.
    for (const s of ['up', 'down', 'unauthorized', 'unknown']) {
      expect(SRC, s).toContain(`${s}:`);
    }
    expect(SRC).toMatch(/needs a token/);
    expect(SRC).toMatch(/not checked yet/);
  });

  it('tells you what to DO about a machine with no credential', () => {
    // The old advice was to run `muxpad-node --init` there and copy the value
    // in by hand. There is a button for that now, so the advice is the button:
    // remove it and pair it again, which mints a fresh token.
    expect(SRC).toMatch(/Remove it and pair it again/);
  });

  it('a failed read degrades to a note, never a broken dialog', () => {
    expect(SRC).toMatch(/Could not read the machine list/);
  });

  it('colours the dot from the rail’s own status tokens', () => {
    // "reachable" and "working" are the same kind of fact; two palettes for
    // it is a tax on the reader.
    // Double quotes: biome normalises attribute selectors, so matching the
    // quoting as authored would pass locally and break on the next format.
    expect(CSS).toMatch(/\.machine\[data-state="up"\][^}]*--status-ready/);
    expect(CSS).toMatch(/\.machine\[data-state="down"\][^}]*--status-dead/);
    expect(CSS).toMatch(/\.machine\[data-state="unauthorized"\][^}]*--status-blocked/);
  });

  it('polls, because link state changes with nothing clicking', () => {
    expect(SRC).toMatch(/setInterval\(load, 10_000\)/);
  });
});
