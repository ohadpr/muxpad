import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * The lazy, unpolled corpus behind the palette's outputs tier. What matters is
 * what it does NOT do: fetch before anybody looks, fetch twice for one open,
 * poll, or let a failed request look like an empty library.
 */
let apps: unknown = { apps: [{ slug: 'notes' }] };
let publishes: unknown = { publishes: [], base: null };
let fail = false;
const calls: string[] = [];

vi.mock('../api', () => ({
  req: (path: string) => {
    calls.push(path);
    if (fail) return Promise.reject(new Error('offline'));
    if (path === '/api/apps') return Promise.resolve(apps);
    if (path === '/api/publish') return Promise.resolve(publishes);
    return Promise.reject(new Error(path));
  },
}));

const mod = await import('./outputs-corpus');

beforeEach(() => {
  mod.resetOutputsCache();
  calls.length = 0;
  fail = false;
  apps = { apps: [{ slug: 'notes', name: 'Notes', cwd: '/n', url: 'u', state: 'running' }] };
  publishes = { publishes: [], base: null };
});

afterEach(() => {
  mod.resetOutputsCache();
});

it('fetches nothing until somebody asks', () => {
  // Importing the module must cost the first paint nothing.
  expect(calls).toEqual([]);
  expect(mod.cachedOutputs()).toBeNull();
});

it('loads both lists and publishes them to its readers', async () => {
  const seen: unknown[] = [];
  const off = mod.subscribeOutputs((o) => seen.push(o));
  await mod.loadOutputs();
  expect(calls.sort()).toEqual(['/api/apps', '/api/publish']);
  expect(mod.cachedOutputs()).toHaveLength(1);
  expect(seen).toHaveLength(1);
  off();
});

it('reuses a fresh copy rather than asking again', async () => {
  await mod.loadOutputs(1000);
  await mod.loadOutputs(1000 + mod.OUTPUTS_TTL_MS - 1);
  expect(calls).toHaveLength(2); // the first load's two requests, and no more
});

it('asks again once the copy has gone stale', async () => {
  await mod.loadOutputs(1000);
  await mod.loadOutputs(1000 + mod.OUTPUTS_TTL_MS + 1);
  expect(calls).toHaveLength(4);
});

it('makes ONE request set for two opens in the same moment', async () => {
  // Opening the palette twice in a second must not ask twice.
  await Promise.all([mod.loadOutputs(), mod.loadOutputs(), mod.loadOutputs()]);
  expect(calls).toHaveLength(2);
});

it('fails silently, and does not cache the failure as an empty library', async () => {
  // The tier is a supplement: a failed request must cost the search this tier
  // and nothing else — no throw into a keystroke handler, no error to dismiss.
  fail = true;
  await expect(mod.loadOutputs()).resolves.toBeUndefined();
  expect(mod.cachedOutputs()).toBeNull();
  // …and the NEXT open asks again rather than sitting on the hole for a minute.
  fail = false;
  await mod.loadOutputs();
  expect(mod.cachedOutputs()).toHaveLength(1);
});

it('survives a malformed answer instead of throwing', async () => {
  // These are the oldest routes in the app. A shape surprise must cost the
  // palette a tier, never a crash inside typing.
  apps = { apps: 'nope' };
  publishes = null;
  await expect(mod.loadOutputs()).resolves.toBeUndefined();
  expect(mod.cachedOutputs()).toEqual([]);
});
