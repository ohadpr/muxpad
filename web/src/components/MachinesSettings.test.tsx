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
   * READ-ONLY ON PURPOSE. Pairing writes a credential to disk at 0600 on two
   * machines, which a dialog cannot honestly do; and a default-host picker is
   * worth having only once every lifecycle path is node-aware — one that
   * silently kept creating panes on the mac would be worse than none.
   */
  it('offers no add button and no default-host picker yet', () => {
    // Asserted against the JSX ONLY: the phrase appears in the file's own
    // comment explaining why there is no such button, and a negative match
    // over the whole source finds the explanation and fails. (Third time a
    // comment has matched one of my own negative assertions tonight.)
    const jsx = SRC.slice(SRC.indexOf('export function MachinesSettings'));
    expect(jsx).not.toMatch(/<button/i);
    expect(jsx).not.toMatch(/<select/i);
    // And it says why, rather than looking unfinished.
    expect(SRC).toMatch(/paired from the command line/i);
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
