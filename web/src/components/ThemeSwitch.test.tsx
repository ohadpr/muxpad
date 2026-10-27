import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeSwitch } from './ThemeSwitch';

vi.mock('../settings', () => ({
  useSettings: () => ({ theme: 'system' }),
  updateSettings: vi.fn(),
  SYSTEM_PAIR: { light: 'alucard', dark: 'dracula' },
  THEME_CHOICES: [
    { value: 'system', label: 'System' },
    { value: 'riso', label: 'Riso' },
  ],
}));

const HERE = dirname(fileURLToPath(import.meta.url));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const open = async () => {
  await act(async () => root.render(<ThemeSwitch />));
  const b = host.querySelector<HTMLButtonElement>('button[aria-label="Theme"]');
  expect(b).toBeTruthy();
  await act(async () => b!.click());
};

describe('the rail’s theme switch', () => {
  it('opens a picker with the real tiles', async () => {
    await open();
    const pop = host.querySelector('.themeswitch-pop');
    expect(pop).toBeTruthy();
    // The tiles, not a second rendering of the names: `data-theme` is what
    // makes a tile paint the actual palette.
    expect(pop?.querySelectorAll('.theme-mock[data-theme]').length).toBeGreaterThan(0);
    expect(
      [...pop!.querySelectorAll('input[type=radio]')].map((i) => (i as HTMLInputElement).value),
    ).toEqual(['system', 'riso']);
  });

  it('uses its OWN radio group', async () => {
    // Two pickers sharing `name="theme"` are ONE group to the browser: the
    // dialog's checked radio and this one's fight over a single selection and
    // arrow-keys walk between surfaces.
    await open();
    const names = new Set(
      [...host.querySelectorAll('input[type=radio]')].map((i) => (i as HTMLInputElement).name),
    );
    expect(names).toEqual(new Set(['theme-rail']));
  });

  it('closes on Escape and on a click outside', async () => {
    await open();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(host.querySelector('.themeswitch-pop')).toBeNull();
    await open();
    await act(async () => document.body.click());
    expect(host.querySelector('.themeswitch-pop')).toBeNull();
  });

  it('dismisses on CLICK, never on mousedown', () => {
    // A radio inside the popover must get its own event before the dismissal
    // runs; on mousedown the popover unmounts first and the pick never lands.
    const src = readFileSync(join(HERE, 'ThemeSwitch.tsx'), 'utf8');
    expect(src).toMatch(/addEventListener\('click'/);
    expect(src).not.toMatch(/addEventListener\('mousedown'/);
  });

  it('anchors to the rail’s footer, not to its own 20px button', () => {
    // At `position: relative` on the button the 272px popover rendered from
    // x = -32 and the tiles were half off the screen.
    const css = readFileSync(join(HERE, 'SettingsMenu.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const wrap = /\.themeswitch\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(wrap).not.toMatch(/position:\s*relative/);
    const pop = /\.themeswitch-pop\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(pop).toMatch(/left:\s*0/);
    expect(pop).toMatch(/bottom:\s*calc\(100%/);
  });
});
