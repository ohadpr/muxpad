import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalIntent, passkeyCeremony } from './slack-passkey';
afterEach(() => vi.unstubAllGlobals());
const encoded = (v: string) => btoa(v).replace(/=/g, '');
const fixture = () => {
  const dom = new JSDOM('', { url: 'https://muxpad.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('crypto', webcrypto);
  const get = vi.fn(async (_options: CredentialRequestOptions) => ({
    id: encoded('credential'),
    rawId: new TextEncoder().encode('credential').buffer,
    type: 'public-key',
    response: {
      clientDataJSON: Uint8Array.from([4]).buffer,
      authenticatorData: Uint8Array.from([5]).buffer,
      signature: Uint8Array.from([6]).buffer,
      userHandle: null,
    },
    getClientExtensionResults: () => ({}),
  }));
  const create = vi.fn();
  vi.stubGlobal('navigator', { credentials: { get, create } });
  return { get, create, dom };
};
const envelope = (extra: Record<string, unknown> = {}) => {
  const intent = {
    version: 1,
    purpose: 'revoke-timed-permissions',
    id: 'one-use',
    credentialID: encoded('credential'),
    epoch: 0,
    grantEpoch: 0,
    expires: 123000,
    elapsedExpires: 123000,
    nonce: 'a'.repeat(43),
    ...extra,
  };
  return {
    ceremonyID: intent.id,
    intent,
    options: {
      challenge: createHash('sha256').update(canonicalIntent(intent)).digest('base64url'),
      rpId: 'muxpad.test',
      userVerification: 'discouraged',
      allowCredentials: [{ id: intent.credentialID }],
    },
  };
};
it.each(['discouraged', 'required'])(
  'button ceremony accepts intended presence policy or safe old required policy: %s',
  async (policy) => {
    const f = fixture();
    const e = envelope();
    e.options.userVerification = policy;
    const result = await passkeyCeremony(e, false, { purpose: 'revoke-timed-permissions' });
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.get.mock.calls[0]![0]).toMatchObject({
      publicKey: { rpId: 'muxpad.test', userVerification: policy },
    });
    expect(result).toMatchObject({
      type: 'public-key',
      response: { userHandle: null },
      clientExtensionResults: {},
    });
    expect(Object.keys(result.response)).toEqual([
      'clientDataJSON',
      'authenticatorData',
      'signature',
      'userHandle',
    ]);
  },
);
it('wrong RP or unknown/missing verification policy cannot start browser credential access', async () => {
  const f = fixture();
  for (const raw of [
    { rpId: 'other.test', userVerification: 'discouraged' },
    { rpId: 'muxpad.test', userVerification: 'preferred' },
    { rpId: 'muxpad.test', userVerification: undefined },
    { rpId: 'muxpad.test', userVerification: 'unknown' },
  ]) {
    const e = envelope();
    e.options = { ...e.options, ...raw } as typeof e.options;
    await expect(
      passkeyCeremony(e, false, { purpose: 'revoke-timed-permissions' }),
    ).rejects.toThrow();
  }
  expect(f.get).not.toHaveBeenCalled();
});
it('untrusted relay duration/payload/purpose substitutions never reach authenticator', async () => {
  const f = fixture();
  const expected = {
    purpose: 'slack-decision',
    requestID: 'request',
    fingerprint: 'fp',
    action: 'slack.post',
    teamID: 'T1',
    payload: { channel: 'C1', text: 'shown' },
    decision: 'approve',
    duration: 'once',
    scope: null,
  };
  const e = envelope({ ...expected, duration: '1d', scope: 'slack-team-all-v1' });
  await expect(passkeyCeremony(e, false, expected)).rejects.toThrow('differs');
  const forged = { ...e, intent: { ...e.intent, ...expected } };
  await expect(passkeyCeremony(forged, false, expected)).rejects.toThrow('challenge');
  await expect(passkeyCeremony(envelope(), false, expected)).rejects.toThrow();
  const payload = envelope({ ...expected, payload: { channel: 'C1', text: 'different' } });
  await expect(passkeyCeremony(payload, false, expected)).rejects.toThrow('differs');
  expect(f.get).not.toHaveBeenCalled();
});
it('canonical intent matches specified key ordering and does not alter exact text', () => {
  expect(canonicalIntent({ b: 'x', a: { z: 2, y: [1, true] } })).toBe(
    '{"a":{"y":[1,true],"z":2},"b":"x"}',
  );
});

it.each(['discouraged', 'required'])(
  'registration derives local canonical fingerprint under intended or old policy: %s',
  async (policy) => {
    const f = fixture();
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    f.create.mockResolvedValue({
      id: encoded('credential'),
      rawId: new TextEncoder().encode('credential').buffer,
      type: 'public-key',
      response: {
        clientDataJSON: Uint8Array.from([1]).buffer,
        attestationObject: Uint8Array.from([2]).buffer,
        getTransports: () => ['internal'],
        getPublicKey: () => Uint8Array.from(spki).buffer,
        getPublicKeyAlgorithm: () => -7,
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    });
    const value = await passkeyCeremony(
      {
        challenge: 'a'.repeat(43),
        rp: { id: 'muxpad.test', name: 'muxpad' },
        user: { id: encoded('owner'), name: 'owner', displayName: 'Owner' },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
        authenticatorSelection: { residentKey: 'required', userVerification: policy },
      },
      true,
    );
    expect(value.localKeyFingerprint).toBe(createHash('sha256').update(spki).digest('base64url'));
    expect(f.create.mock.calls[0]![0]).toMatchObject({
      publicKey: { authenticatorSelection: { userVerification: policy } },
    });
    expect(f.get).not.toHaveBeenCalled();
  },
);
it.each(['missing', 'algorithm'])(
  'registration refuses unsupported key export: %s',
  async (kind) => {
    const f = fixture();
    f.create.mockResolvedValue({
      id: encoded('credential'),
      rawId: new TextEncoder().encode('credential').buffer,
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array().buffer,
        attestationObject: new Uint8Array().buffer,
        ...(kind === 'algorithm'
          ? { getPublicKey: () => new Uint8Array([1]).buffer, getPublicKeyAlgorithm: () => -257 }
          : {}),
      },
      getClientExtensionResults: () => ({}),
    });
    await expect(
      passkeyCeremony(
        {
          challenge: 'a'.repeat(43),
          rp: { id: 'muxpad.test', name: 'muxpad' },
          user: { id: encoded('owner'), name: 'owner', displayName: 'Owner' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'discouraged' },
        },
        true,
      ),
    ).rejects.toThrow('public key');
  },
);

it('HTTP points to the configured HTTPS RP and preserves the chat before requiring browser crypto', async () => {
  const f = fixture();
  f.dom.reconfigure({ url: 'http://127.0.0.1:7777/w/work/t/chat?pane=p#last' });
  vi.stubGlobal('crypto', undefined);
  await expect(
    passkeyCeremony(envelope(), false, { purpose: 'revoke-timed-permissions' }),
  ).rejects.toMatchObject({
    secureURL: 'https://muxpad.test/w/work/t/chat?pane=p#last',
  });
  expect(f.get).not.toHaveBeenCalled();
});
it.each(['evil.test/path', 'user@evil.test', 'evil.test:443', 'evil.test?x=1'])(
  'never creates an approval navigation link for malformed RP %s',
  async (rpId) => {
    const f = fixture();
    const e = envelope();
    e.options.rpId = rpId;
    await expect(
      passkeyCeremony(e, false, { purpose: 'revoke-timed-permissions' }),
    ).rejects.toThrow('address unavailable');
    expect(f.get).not.toHaveBeenCalled();
  },
);
