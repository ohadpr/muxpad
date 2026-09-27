import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../store/AppStore.js';
import {
  browserHostCommand,
  cdpPortFromViewerUrl,
  ensureBrowserApp,
  listBrowserApps,
  takenBrowserPorts,
} from './BrowserApps.js';
import { BROWSER_PORT_RANGE } from './BrowserProfile.js';

/**
 * One profile, one app row, one owner.
 *
 * This is where the September bug is actually prevented. Everything upstream
 * makes the slug a pure function of the profile name; this is the thing that
 * refuses to create a second row when asked twice.
 */

let db: Database.Database;
let registry: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

function deps(overrides: Partial<Parameters<typeof ensureBrowserApp>[1]> = {}) {
  return {
    db,
    dataDir: '/data',
    chromePath: '/bin/chrome',
    hostEntry: '/opt/muxpad/dist/browser/host/cli.js',
    registry,
    cwd: '/home/me',
    log: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE apps (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    cwd TEXT NOT NULL, command TEXT NOT NULL, url TEXT NOT NULL,
    autostart INTEGER NOT NULL, enabled INTEGER NOT NULL, pane_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  registry = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
});

describe('registering', () => {
  it('creates one row named after the profile and starts it', async () => {
    const state = await ensureBrowserApp('Shopping', deps());
    expect(state.slug).toBe('browser-shopping');
    expect(state.state).toBe('started');
    expect(registry.start).toHaveBeenCalledOnce();
    expect(new AppStore(db).getBySlug('browser-shopping')).not.toBeNull();
  });

  it('is idempotent — asking twice cannot make two owners', async () => {
    // The whole subsystem exists because ~20 processes opened one profile
    // directory. If this ever creates a second row, that is back.
    await ensureBrowserApp('shopping', deps());
    await ensureBrowserApp('shopping', deps());
    expect(new AppStore(db).list().filter((a) => a.slug === 'browser-shopping')).toHaveLength(1);
  });

  it('treats two spellings of a profile as the same owner', async () => {
    await ensureBrowserApp('Shopping', deps());
    await ensureBrowserApp('  shopping  ', deps());
    expect(new AppStore(db).list()).toHaveLength(1);
  });

  it('can register without opening a browser', async () => {
    const state = await ensureBrowserApp('shopping', deps({ start: false }));
    expect(state.state).toBe('registered');
    expect(registry.start).not.toHaveBeenCalled();
  });

  it('stores the VIEWER url, because that is what a person opens', async () => {
    const state = await ensureBrowserApp('shopping', deps());
    const row = new AppStore(db).getBySlug('browser-shopping');
    expect(row?.url).toBe(state.viewerUrl);
    expect(state.viewerUrl).not.toBe(state.cdpUrl);
  });
});

describe('ports', () => {
  it('gives two profiles different CDP ports', async () => {
    await ensureBrowserApp('shopping', deps());
    await ensureBrowserApp('research', deps());
    const ports = [...takenBrowserPorts(db)];
    expect(new Set(ports).size).toBe(2);
  });

  it('never hands a second profile a port already registered', async () => {
    // Two owners on one debugging port is the same collision as two owners on
    // one profile directory — just later, and much harder to see.
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) await ensureBrowserApp(name, deps());
    const ports = [...takenBrowserPorts(db)];
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('keeps every CDP port inside the reserved range', async () => {
    const [lo, hi] = BROWSER_PORT_RANGE;
    for (const name of ['a', 'b', 'c']) await ensureBrowserApp(name, deps());
    for (const port of takenBrowserPorts(db)) {
      expect(port).toBeGreaterThanOrEqual(lo);
      expect(port).toBeLessThanOrEqual(hi);
    }
  });

  it('recovers the CDP port from a stored viewer url', () => {
    expect(cdpPortFromViewerUrl('http://127.0.0.1:9510')).toBe(9410);
    expect(cdpPortFromViewerUrl('http://127.0.0.1:80')).toBeNull();
    expect(cdpPortFromViewerUrl('nonsense')).toBeNull();
  });
});

describe('the command', () => {
  it('quotes paths, so a data dir with a space does not split', () => {
    const cmd = browserHostCommand({
      hostEntry: '/opt/my apps/cli.js',
      profile: 'shopping',
      port: 9410,
      dataDir: '/Users/me/Library/Application Support/muxpad',
      chromePath: '/opt/browsers/Chrome for Testing/chrome',
    });
    expect(cmd).toContain('"/opt/my apps/cli.js"');
    expect(cmd).toContain('"/Users/me/Library/Application Support/muxpad"');
    expect(cmd).toContain('"/opt/browsers/Chrome for Testing/chrome"');
    expect(cmd).toContain('--profile=shopping');
    expect(cmd).toContain('--port=9410');
  });

  it('refuses a profile name that is not a bare slug', () => {
    expect(() =>
      browserHostCommand({
        hostEntry: '/x.js',
        profile: '../../etc',
        port: 9410,
        dataDir: '/d',
        chromePath: '/c',
      }),
    ).toThrow(/profile name/i);
  });
});

describe('listing', () => {
  it('reports only browser rows, never somebody else’s app', async () => {
    await ensureBrowserApp('shopping', deps());
    new AppStore(db).create({
      slug: 'tunnel',
      name: 'cloudflare tunnel',
      cwd: '/',
      command: 'muxpad tunnel',
      url: 'http://127.0.0.1:8080',
    });
    const listed = listBrowserApps(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.profile).toBe('shopping');
  });
});
