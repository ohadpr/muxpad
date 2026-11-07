import { describe, expect, it } from 'vitest';
import { INSTALLS_PATH, loadInstalls, parseInstalls } from './install.js';
import type { FileIO } from './trusted-file.js';

/**
 * The declarations are what stopped one machine's paths being compiled into a
 * program whose job is checking installs. They are also, therefore, a thing an
 * agent would very much like to edit — so they are read with the same
 * discipline as the connector policy.
 */
describe('parsing a declaration', () => {
  it('keeps an entry that says where and who', () => {
    const got = parseInstalls({
      msgvault: {
        home: '/srv/mv',
        binary: '/opt/mv/bin/mv',
        account: 'mvd',
        libraries: ['/opt/mv/lib/x.dylib'],
        logs: ['/srv/mv/out.log'],
        statusCommand: 'sudo launchctl print system/mv',
      },
    });
    expect(got.msgvault).toEqual({
      home: '/srv/mv',
      binary: '/opt/mv/bin/mv',
      account: 'mvd',
      libraries: ['/opt/mv/lib/x.dylib'],
      logs: ['/srv/mv/out.log'],
      statusCommand: 'sudo launchctl print system/mv',
    });
  });

  it('drops an entry missing what a check cannot do without', () => {
    // Not a stricter install — an unanswerable one. A check with no path to
    // look at would have to invent one, which is the hardcoding again.
    for (const bad of [
      { msgvault: { binary: '/b', account: 'a' } },
      { msgvault: { home: '/h', account: 'a' } },
      { msgvault: { home: '/h', binary: '/b' } },
      { msgvault: { home: 'relative', binary: '/b', account: 'a' } },
      { msgvault: { home: '/h', binary: 'relative', account: 'a' } },
    ])
      expect(Object.keys(parseInstalls(bad)), JSON.stringify(bad)).toEqual([]);
  });

  it('refuses a junk id, and cannot be reached through Object’s own properties', () => {
    expect(
      Object.keys(parseInstalls({ 'Bad Id': { home: '/h', binary: '/b', account: 'a' } })),
    ).toEqual([]);
    const got = parseInstalls({ constructor: { home: '/h', binary: '/b', account: 'a' } });
    expect(Object.getPrototypeOf(got)).toBeNull();
  });

  it('drops non-absolute entries from the lists rather than the whole install', () => {
    const got = parseInstalls({
      mv: { home: '/h', binary: '/b', account: 'a', libraries: ['/ok', 'nope', 7], logs: [] },
    });
    expect(got.mv?.libraries).toEqual(['/ok']);
    expect(got.mv?.logs).toBeUndefined();
  });

  it('is empty for anything that is not an object of entries', () => {
    for (const junk of [null, 7, 'x', [], undefined])
      expect(Object.keys(parseInstalls(junk))).toEqual([]);
  });
});

describe('loading it', () => {
  const io = (over: Partial<FileIO> = {}): FileIO => ({
    open: () => 7,
    fstat: () => ({ isFile: () => true, uid: 0, mode: 0o644, nlink: 1 }) as never,
    read: () => '{"mv":{"home":"/h","binary":"/b","account":"a"}}',
    close: () => {},
    lstat: () =>
      ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 0, mode: 0o755 }) as never,
    ...over,
  });

  it('reads a root-owned file', () => {
    const got = loadInstalls(INSTALLS_PATH, io());
    expect(got.problem).toBeUndefined();
    expect(got.installs.mv?.home).toBe('/h');
  });

  it('is empty and silent when there is no file — nothing is declared yet', () => {
    const missing = io({
      open: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    });
    const got = loadInstalls(INSTALLS_PATH, missing);
    expect(got.problem).toBeUndefined();
    expect(Object.keys(got.installs)).toEqual([]);
  });

  it('reports a file it cannot trust, and declares NOTHING from it', () => {
    // A file an agent can edit is a file that can point these checks — and the
    // exec path — at a directory the agent owns.
    const theirs = io({
      fstat: () => ({ isFile: () => true, uid: 501, mode: 0o644, nlink: 1 }) as never,
    });
    const got = loadInstalls(INSTALLS_PATH, theirs);
    expect(got.problem).toMatch(/not root-owned/);
    expect(Object.keys(got.installs)).toEqual([]);
  });

  it('reports unparseable rather than treating it as absent', () => {
    const got = loadInstalls(INSTALLS_PATH, io({ read: () => '{oops' }));
    expect(got.problem).toMatch(/not valid JSON/);
  });
});
