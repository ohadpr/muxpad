import { describe, expect, it } from 'vitest';
import { UNSCOPED, mayUse, readPolicy } from './scope.js';

/**
 * The function that decides whether a personal chat can touch the work Slack.
 * Pinned case by case, including the ones where failing open would be quiet.
 */
const P = (enforce: boolean, allow: Record<string, string[]>) => ({ enforce, allow });

describe('host scoping', () => {
  it('allows anything while enforcement is off — and SAYS it was not scoped', () => {
    // The flag travels with the decision so the prompt and the audit record can
    // state that nothing was checked, rather than implying a check happened.
    const d = mayUse('slack', 'local', UNSCOPED);
    expect(d.ok).toBe(true);
    expect(d.enforced).toBe(false);
  });

  it('refuses a connector with no entry when enforcing — deny is the default', () => {
    const d = mayUse('slack', 'trayo', P(true, {}));
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/no machine is allowed/);
  });

  it('refuses a connector this build has never heard of', () => {
    expect(mayUse('whatsapp', 'trayo', P(true, { slack: ['trayo'] })).ok).toBe(false);
  });

  it('allows the owning host and refuses every other', () => {
    const policy = P(true, { slack: ['trayo'], msgvault: ['local'] });
    expect(mayUse('slack', 'trayo', policy).ok).toBe(true);
    expect(mayUse('msgvault', 'local', policy).ok).toBe(true);
    // The two cases the owner actually asked for.
    const personalSlack = mayUse('slack', 'local', policy);
    expect(personalSlack.ok).toBe(false);
    expect(personalSlack.reason).toMatch(/scoped to trayo.*runs on local/);
    expect(mayUse('msgvault', 'trayo', policy).ok).toBe(false);
  });

  it('carries the resolved origin into the decision, refused or not', () => {
    // The origin is never taken from a request body, so it has to come back
    // with the answer for the audit record to be worth anything.
    expect(mayUse('slack', 'trayo', P(true, { slack: ['local'] })).origin).toBe('trayo');
    expect(mayUse('slack', 'trayo', P(true, { slack: ['trayo'] })).origin).toBe('trayo');
  });
});

describe('reading the stored policy', () => {
  it('treats absent, empty and corrupt as UNSCOPED, never as deny-all', () => {
    // A corrupt pref must not silently switch a working connector off…
    for (const raw of [null, undefined, '', 'not json', '[]', '7', '{']) {
      expect(readPolicy(raw), String(raw)).toEqual(UNSCOPED);
    }
  });

  it('…and never as enforcement that was not asked for', () => {
    // …nor silently switch scoping ON, which would read as a working rule.
    expect(readPolicy('{"allow":{"slack":["trayo"]}}').enforce).toBe(false);
  });

  it('keeps only well-formed entries', () => {
    const p = readPolicy(
      JSON.stringify({
        enforce: true,
        allow: { slack: ['trayo'], 'Bad Name': ['x'], empty: [], notlist: 'trayo', mix: ['a', 7] },
      }),
    );
    expect(p.enforce).toBe(true);
    expect(Object.keys(p.allow).sort()).toEqual(['mix', 'slack']);
    expect(p.allow.mix).toEqual(['a']);
  });

  it('enforce must be exactly true, not truthy', () => {
    expect(readPolicy('{"enforce":"yes","allow":{"slack":["t"]}}').enforce).toBe(false);
    expect(readPolicy('{"enforce":1,"allow":{"slack":["t"]}}').enforce).toBe(false);
  });
});

describe('the policy file', () => {
  const tmp = async () => {
    const { mkdtempSync, writeFileSync, chmodSync, symlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    return {
      dir: mkdtempSync(join(tmpdir(), 'cpol-')),
      writeFileSync,
      chmodSync,
      symlinkSync,
      join,
    };
  };

  it('is UNSCOPED when absent — the state this ships in', async () => {
    const { loadPolicy } = await import('./scope.js');
    expect(loadPolicy('/nonexistent/connectors.json')).toEqual(UNSCOPED);
  });

  it('SEALS everything when the file is not root-owned', async () => {
    // The cheapest attack on a policy you ignore when it looks broken is to
    // break it. So an untrusted file denies rather than disabling scoping.
    const { loadPolicy } = await import('./scope.js');
    const t = await tmp();
    const f = t.join(t.dir, 'connectors.json');
    t.writeFileSync(f, JSON.stringify({ enforce: true, allow: { slack: ['trayo'] } }));
    const p = loadPolicy(f); // owned by the test user, not root
    expect(p.enforce).toBe(true);
    expect(p.allow).toEqual({});
    expect(p.problem).toMatch(/not root-owned/);
    expect(mayUse('slack', 'trayo', p).ok).toBe(false);
  });

  it('seals a symlink even if its target would be fine', async () => {
    const { loadPolicy } = await import('./scope.js');
    const t = await tmp();
    const real = t.join(t.dir, 'real.json');
    const link = t.join(t.dir, 'link.json');
    t.writeFileSync(real, '{"enforce":false,"allow":{}}');
    t.symlinkSync(real, link);
    expect(loadPolicy(link).problem).toMatch(/symlink/);
  });
});
