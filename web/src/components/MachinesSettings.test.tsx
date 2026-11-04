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
   * NO PAIRING BUTTON. Pairing writes a credential to disk at 0600 on two
   * machines, which a dialog cannot honestly do.
   */
  it('offers no add button, and says why rather than looking unfinished', () => {
    // Asserted against the JSX ONLY: the phrase appears in the file's own
    // comment explaining why there is no such button, and a negative match
    // over the whole source finds the explanation and fails. (Third time a
    // comment has matched one of my own negative assertions tonight.)
    const jsx = SRC.slice(SRC.indexOf('export function MachinesSettings'));
    expect(jsx).not.toMatch(/<button/i);
    expect(SRC).toMatch(/paired from the command line/i);
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

  it('tells you what to DO about a machine with no token', () => {
    expect(SRC).toContain('muxpad-node --init');
    expect(SRC).toContain('node-tokens');
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
