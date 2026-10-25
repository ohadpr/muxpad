import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPushState } from '../lib/push';
import { passkeyAPI, passkeyCeremony } from '../lib/slack-passkey';
import { SettingsMenu } from './SettingsMenu';
vi.mock('../lib/slack-passkey', () => ({ passkeyAPI: vi.fn(), passkeyCeremony: vi.fn() }));
vi.mock('./SlackSetupGuide', () => ({ SlackSetupGuide: () => null }));
vi.mock('../lib/push', () => ({
  getPushState: vi.fn().mockResolvedValue('unsupported'),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  sendTestPush: vi.fn(),
}));
vi.mock('../settings', () => ({
  useSettings: () => ({ theme: 'system' }),
  updateSettings: vi.fn(),
  THEME_CHOICES: [{ value: 'system', label: 'System' }],
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(getPushState).mockResolvedValue('unsupported');
  // jsdom does not implement the native dialog's top layer or focus algorithm.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
      this.querySelector<HTMLButtonElement>('button')?.focus();
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  vi.mocked(passkeyAPI).mockResolvedValue({
    mode: 'passkey-inline',
    registered: false,
    teamID: 'T1',
    grants: [],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text,
  );
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};
const visible = () =>
  [...document.querySelectorAll<HTMLElement>('section')]
    .filter((e) => !e.hidden)
    .map((e) => e.textContent)
    .join(' ') + (document.querySelector('[role=alert]')?.textContent ?? '');
async function open() {
  await act(async () => root.render(<SettingsMenu />));
  await click('Settings');
}
it('opens a named modal, navigates sections, cancels with Escape and restores focus and scrolling', async () => {
  document.body.style.overflow = 'auto';
  await open();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute('aria-labelledby')).toBe('settings-title');
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  await click('Integrations');
  expect(visible()).toContain('Create passkey');
  expect(visible()).not.toContain('Font size');
  await click('General');
  expect(visible()).toContain('Theme');
  expect(document.querySelector('#font-size')).toBeNull();
  await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(document.querySelector('dialog')?.open).toBe(false);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Settings');
  expect(document.body.style.overflow).toBe('auto');
  await click('Settings');
  await click('Close settings');
  expect(document.querySelector('dialog')?.open).toBe(false);
});
it.each(['legacy', 'unavailable'])(
  'keeps Slack and actionable prerequisites visible when %s',
  async (mode) => {
    if (mode === 'unavailable') vi.mocked(passkeyAPI).mockRejectedValue(Error('offline'));
    else vi.mocked(passkeyAPI).mockResolvedValue({ mode });
    await open();
    await click('Integrations');
    expect(visible()).toContain('Slack');
    expect(visible()).not.toContain('paste Slack tokens here');
    expect(document.querySelector('input[type=password]')).toBeNull();
    expect(document.querySelector('input[type=password]')).toBeNull();
    expect(visible()).toContain(mode === 'unavailable' ? 'Service unreachable' : 'Setup required');
    vi.mocked(passkeyAPI).mockResolvedValue({
      mode: 'passkey-inline',
      registered: true,
      grants: [],
    });
    await click('Refresh status');
    expect(visible()).toContain('Ask each time.');
  },
);
it('shows loading without hiding Slack', async () => {
  vi.mocked(passkeyAPI).mockReturnValue(new Promise(() => {}));
  await open();
  await click('Integrations');
  expect(visible()).toContain('Checking service');
  expect(visible()).toContain('Slack');
});
it('shows existing grants and revokes through the bound management ceremony once', async () => {
  const status = {
    mode: 'passkey-inline',
    registered: true,
    grants: [{ id: 'g1', expires: Date.now() + 60000 }],
  };
  vi.mocked(passkeyAPI).mockImplementation(async (path) =>
    path === 'management-options' ? { ceremonyID: 'c1' } : status,
  );
  vi.mocked(passkeyCeremony).mockResolvedValue({
    id: 'key',
    rawId: 'key',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
  });
  await open();
  await click('Integrations');
  expect(visible()).toContain('Slack access · expires');
  await click('Revoke timed permissions');
  expect(passkeyCeremony).toHaveBeenCalledWith({ ceremonyID: 'c1' }, false, {
    purpose: 'revoke-timed-permissions',
  });
  expect(
    vi.mocked(passkeyAPI).mock.calls.filter(([path]) => path === 'management-verify'),
  ).toHaveLength(1);
});
it('retains a locally verified enrollment receipt across sections until trusted-host confirmation', async () => {
  const candidate = {
    candidateID: 'candidate',
    credentialID: 'key',
    fingerprint: 'fingerprint',
    rpID: window.location.hostname,
    origin: window.location.origin,
    generation: 1,
  };
  let created = false;
  vi.mocked(passkeyAPI).mockImplementation(async (path) => {
    if (path === 'registration-verify') {
      created = true;
      return { candidate, registered: false };
    }
    return { mode: 'passkey-inline', registered: false, ...(created ? { candidate } : {}) };
  });
  vi.mocked(passkeyCeremony).mockResolvedValue({
    id: 'key',
    rawId: 'key',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
    localKeyFingerprint: 'fingerprint',
  });
  await open();
  await click('Integrations');
  const input = document.querySelector('input[type=password]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'one-time-code',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Create passkey');
  expect(passkeyAPI).toHaveBeenCalledWith('registration-options', { secret: 'one-time-code' });
  expect(visible()).toContain('not active');
  expect(document.querySelector('pre')?.textContent).toContain('fingerprint');
  await click('General');
  await click('Integrations');
  expect(document.querySelector('pre')?.textContent).toContain('fingerprint');
  expect(document.querySelector('input[type=password]')).toBeNull();
  await click('Close settings');
  await click('Settings');
  expect(document.querySelector('pre')?.textContent).toContain('fingerprint');
});
it('does not promote a relayed candidate to a trusted receipt', async () => {
  vi.mocked(passkeyAPI).mockResolvedValue({
    mode: 'passkey-inline',
    registered: false,
    candidate: { fingerprint: 'untrusted' },
  });
  await open();
  await click('Integrations');
  expect(visible()).toContain('Return to the window');
  expect(document.querySelector('pre')).toBeNull();
  expect(document.querySelector('input[type=password]')).toBeNull();
});
it('rejects mismatched enrollment receipts without exposing confirmation', async () => {
  vi.mocked(passkeyAPI).mockImplementation(async (path) =>
    path === 'registration-verify'
      ? { candidate: { credentialID: 'other', fingerprint: 'wrong' } }
      : { mode: 'passkey-inline', registered: false },
  );
  vi.mocked(passkeyCeremony).mockResolvedValue({
    id: 'key',
    rawId: 'key',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
    localKeyFingerprint: 'fingerprint',
  });
  await open();
  await click('Integrations');
  const input = document.querySelector('input[type=password]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'code');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Create passkey');
  expect(document.querySelector('pre')).toBeNull();
  expect(visible()).toContain('No approval authority was activated');
});

it('keeps its close control outside every scrolling settings panel', async () => {
  await open();
  const dialog = document.querySelector('dialog')!;
  const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!;
  expect(close.closest('.settings-chrome')?.parentElement).toBe(dialog);
  expect(close.closest('.settings-body')).toBeNull();
  await click('Integrations');
  await click('Close settings');
  expect(dialog.open).toBe(false);
});

it('shows the current Slack state without a completed setup checklist or empty revoke action', async () => {
  vi.mocked(passkeyAPI).mockResolvedValue({
    mode: 'passkey-inline',
    registered: true,
    teamID: 'T1',
    grants: [],
  });
  await open();
  await click('Integrations');
  const integration = document.querySelector('[aria-label="Slack integration"]')!;
  expect(integration.querySelector('.settings-steps')).toBeNull();
  expect(integration.textContent).toContain('Ask each time.');
  expect(integration.querySelector('details')?.open).toBe(false);
  const approvals = integration;
  expect(
    [...document.querySelectorAll('.settings-sidebar button')].map((b) => b.textContent),
  ).toEqual(['General', 'Integrations']);
  expect(document.querySelector('[aria-label="Slack approvals"]')).toBeNull();
  expect(approvals.textContent).toContain('Ask each time.');
  expect(
    [...approvals.querySelectorAll('button')].some((b) => b.textContent?.includes('Revoke')),
  ).toBe(false);
  expect(approvals.querySelector('details')?.open).toBe(false);
});
it('a deliberately renewed or restarted enrollment clears only the obsolete local receipt and exposes the new-code flow', async () => {
  const candidate = {
    candidateID: 'old',
    credentialID: 'key',
    fingerprint: 'fp',
    rpID: window.location.hostname,
    origin: window.location.origin,
    generation: 'g',
  };
  let created = false;
  let retired = false;
  vi.mocked(passkeyAPI).mockImplementation(async (path) => {
    if (path === 'registration-verify') {
      created = true;
      return { candidate, registered: false };
    }
    return {
      mode: 'passkey-inline',
      registered: false,
      ...(created && !retired ? { candidate } : {}),
    };
  });
  vi.mocked(passkeyCeremony).mockResolvedValue({
    id: 'key',
    rawId: 'key',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
    localKeyFingerprint: 'fp',
  });
  await open();
  await click('Integrations');
  const input = document.querySelector('input[type=password]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'code');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Create passkey');
  expect(document.querySelector('pre')?.textContent).toContain('fp');
  await click('Close settings');
  retired = true;
  await click('Settings');
  expect(document.querySelector('pre')).toBeNull();
  expect(document.querySelector('input[type=password]')).not.toBeNull();
});

/**
 * GETTING OUT OF SETTINGS ON A PHONE.
 *
 * Reported from a foldable: "settings is weird on mobile I can't close it, the
 * chrome is so tiny". Two compounding causes, both checked here against the
 * stylesheet because both are CSS facts:
 *
 *   1. The touch treatment was keyed on `max-width: 700px`. A foldable open is
 *      ~890 CSS px and still a phone, so it got the DESKTOP dialog: a 172px
 *      sidebar and 0.8125rem labels on a 7.6" screen.
 *   2. The only ways out were Escape (no key), an 8px strip of backdrop (the
 *      dialog covers the screen to within 8px), and a muted 1.5rem `×`.
 */
describe('settings can be dismissed by a thumb', () => {
  const CSS = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'SettingsMenu.css'),
    'utf8',
  );
  const touchArm = (() => {
    const i = CSS.indexOf('@media (max-width: 700px), (pointer: coarse)');
    return i === -1 ? '' : CSS.slice(i, CSS.length);
  })();

  it('asks about the INPUT, not just the width', () => {
    // The foldable is the case width gets wrong, in both directions.
    expect(CSS).toMatch(/@media \(max-width: 700px\), \(pointer: coarse\)/);
  });

  it('gives the close control a word and a real target on touch', () => {
    expect(touchArm).toMatch(/\.settings-close-word\s*\{[^}]*display:\s*block/);
    expect(touchArm).toMatch(/\.settings-close-x\s*\{[^}]*display:\s*none/);
    // 44px is the floor every other touch target in this file already uses.
    expect(touchArm).toMatch(/height:\s*44px/);
  });

  it('clears the status bar — the actual reason the close was untappable', () => {
    // index.html ships viewport-fit=cover + a black-translucent status bar, so
    // the top ~59px of a full-screen dialog is UNDER the clock and the battery.
    // Seven other stylesheets inset for this; this one had none, and the close
    // control rendered beneath the battery icon.
    expect(touchArm).toMatch(
      /\.settings-chrome\s*\{[^}]*padding-top:\s*calc\([^)]*safe-area-inset-top/,
    );
  });

  it('insets all four edges, because a foldable is landscape', () => {
    // Unfolded, the cut-out is on a SIDE: left/right are the ones that matter.
    expect(touchArm).toMatch(/safe-area-inset-left/);
    expect(touchArm).toMatch(/safe-area-inset-right/);
    expect(touchArm).toMatch(/safe-area-inset-bottom/);
  });

  it('keeps the close pinned, so it cannot scroll out of reach', () => {
    expect(touchArm).toMatch(/\.settings-chrome\s*\{[^}]*position:\s*sticky/);
  });

  it('the word is hidden for pointer devices, which keep the glyph', () => {
    const before = CSS.slice(0, CSS.indexOf('@media (max-width: 700px), (pointer: coarse)'));
    expect(before).toMatch(/\.settings-close-word\s*\{\s*display:\s*none/);
  });

  it('renders both labels in one control, with one accessible name', () => {
    const tsx = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'SettingsMenu.tsx'),
      'utf8',
    );
    expect(tsx).toMatch(/aria-label="Close settings"/);
    expect(tsx).toMatch(/settings-close-word[\s\S]{0,80}Done/);
    // Both spans are decorative: the button already has its name.
    expect(tsx).toMatch(/className="settings-close-word" aria-hidden="true"/);
    expect(tsx).toMatch(/className="settings-close-x" aria-hidden="true"/);
  });
});
