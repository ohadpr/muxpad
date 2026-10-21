export async function passkeyAPI(path: string, body?: Record<string, unknown>) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), path === 'decision' ? 130000 : 35000);
  try {
    const r = await fetch(`/api/slack/passkey/${path}`, {
      cache: 'no-store',
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ body }),
          }),
    });
    const value = await r.json();
    if (!r.ok) throw Error('Approval unavailable. Check status before trying another decision.');
    return value;
  } finally {
    clearTimeout(deadline);
  }
}
const dec = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const enc = (v: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(v)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
export function canonicalIntent(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalIntent).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalIntent((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw Error('Invalid intent');
  return text;
}
async function verifyIntent(
  envelope: Record<string, any>,
  expected: Record<string, unknown> | undefined,
) {
  if (!expected) throw Error('Visible approval intent required');
  const i = envelope.intent;
  const common = [
    'version',
    'purpose',
    'id',
    'credentialID',
    'epoch',
    'grantEpoch',
    'expires',
    'elapsedExpires',
    'nonce',
  ];
  const decision = [
    'requestID',
    'fingerprint',
    'action',
    'teamID',
    'payload',
    'decision',
    'duration',
    'scope',
  ];
  const keys =
    expected.purpose === 'slack-decision'
      ? [...common, ...decision]
      : expected.purpose === 'revoke-timed-permissions'
        ? common
        : [];
  const expectedKeys =
    expected.purpose === 'slack-decision' ? ['purpose', ...decision] : ['purpose'];
  if (
    !i ||
    keys.length === 0 ||
    Object.keys(i).sort().join(',') !== keys.sort().join(',') ||
    Object.keys(expected).sort().join(',') !== expectedKeys.sort().join(',') ||
    i.version !== 1 ||
    i.id !== envelope.ceremonyID
  )
    throw Error('Invalid approval intent');
  for (const [key, value] of Object.entries(expected))
    if (canonicalIntent(i[key]) !== canonicalIntent(value))
      throw Error('Approval intent differs from the displayed request');
  if (
    typeof i.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(i.nonce) ||
    typeof i.credentialID !== 'string' ||
    ![i.epoch, i.grantEpoch, i.expires, i.elapsedExpires].every(Number.isSafeInteger)
  )
    throw Error('Invalid approval binding');
  const challenge = enc(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalIntent(i))),
  );
  if (
    envelope.options?.allowCredentials?.length !== 1 ||
    envelope.options.allowCredentials[0]?.id !== i.credentialID
  )
    throw Error('Unexpected approval credential');
  if (envelope.options?.challenge !== challenge)
    throw Error('Approval challenge does not bind the displayed intent');
}
/** Browser passkey ceremony: 1Password is selected by the user/provider, never its CLI. */
export async function passkeyCeremony(
  raw: Record<string, any>,
  registration = false,
  expected?: Record<string, unknown>,
) {
  const rpID = registration ? raw.rp?.id : raw.options?.rpId;
  if (typeof rpID !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(rpID))
    throw Error('Approval address unavailable');
  const secure = new URL(`https://${rpID}`);
  if (secure.hostname !== rpID) throw Error('Approval address unavailable');
  if (window.location.protocol !== 'https:' || window.location.hostname !== rpID) {
    // This is navigation guidance, never approval authority. Preserve the chat,
    // and never carry user-info or the old HTTP port into the secure address.
    secure.pathname = window.location.pathname;
    secure.search = window.location.search;
    secure.hash = window.location.hash;
    throw Object.assign(Error('Open this chat at its secure muxpad address to use 1Password.'), {
      secureURL: secure.href,
    });
  }
  // The AUTHENTICATION shape wraps its options one level down, and intent is
  // verified against the outer envelope before unwrapping. A local rather than
  // a reassigned parameter, so the envelope stays readable afterwards — and so
  // the rest of this function cannot be confused about which object it holds.
  let spec = raw;
  if (!registration) {
    await verifyIntent(raw, expected);
    spec = raw.options;
  }
  if (typeof spec.challenge !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(spec.challenge))
    throw Error('Invalid passkey challenge');
  const expectedRP = window.location.hostname;
  let credential: Credential | null;
  if (registration) {
    if (
      spec.rp?.id !== expectedRP ||
      !['discouraged', 'required'].includes(spec.authenticatorSelection?.userVerification) ||
      spec.authenticatorSelection?.residentKey !== 'required' ||
      !spec.user ||
      !Array.isArray(spec.pubKeyCredParams)
    )
      throw Error('Unexpected registration origin or policy');
    const options: PublicKeyCredentialCreationOptions = {
      challenge: dec(spec.challenge),
      rp: { id: spec.rp.id, name: spec.rp.name },
      user: { id: dec(spec.user.id), name: spec.user.name, displayName: spec.user.displayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 120000,
      attestation: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: spec.authenticatorSelection.userVerification,
      },
      extensions: { credProps: true },
      excludeCredentials: (spec.excludeCredentials ?? []).map((c: { id: string }) => ({
        type: 'public-key',
        id: dec(c.id),
      })),
    };
    credential = await navigator.credentials.create({ publicKey: options });
  } else {
    if (spec.rpId !== expectedRP || !['discouraged', 'required'].includes(spec.userVerification))
      throw Error('Unexpected approval origin or policy');
    const options: PublicKeyCredentialRequestOptions = {
      challenge: dec(spec.challenge),
      rpId: spec.rpId,
      userVerification: spec.userVerification,
      timeout: 120000,
      allowCredentials: (spec.allowCredentials ?? []).map((c: { id: string }) => ({
        type: 'public-key',
        id: dec(c.id),
      })),
    };
    credential = await navigator.credentials.get({ publicKey: options });
  }
  if (!credential || !('rawId' in credential)) throw Error('Passkey cancelled');
  const c = credential as PublicKeyCredential;
  const response = c.response;
  const result: Record<string, unknown> = { clientDataJSON: enc(response.clientDataJSON) };
  let localKeyFingerprint: string | undefined;
  if (registration) {
    const r = response as AuthenticatorAttestationResponse;
    const spki = r.getPublicKey?.();
    if (!spki || r.getPublicKeyAlgorithm?.() !== -7)
      throw Error('This browser cannot verify the enrollment public key');
    const key = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    localKeyFingerprint = enc(
      await crypto.subtle.digest('SHA-256', await crypto.subtle.exportKey('spki', key)),
    );
    result.attestationObject = enc(r.attestationObject);
    result.transports = r.getTransports?.() ?? [];
  } else {
    const r = response as AuthenticatorAssertionResponse;
    result.authenticatorData = enc(r.authenticatorData);
    result.signature = enc(r.signature);
    result.userHandle = r.userHandle ? enc(r.userHandle) : null;
  }
  return {
    ...(localKeyFingerprint ? { localKeyFingerprint } : {}),
    id: c.id,
    rawId: enc(c.rawId),
    type: c.type,
    response: result,
    clientExtensionResults: c.getClientExtensionResults(),
    ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
  };
}
