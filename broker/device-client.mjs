const LOCK = 'muxpad-private-device';
const encoder = new TextEncoder();
function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
function keyStore() {
  let opened;
  const open = () => {
    if (!opened)
      opened = new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
          reject(Error('Browser storage unavailable'));
          return;
        }
        const request = indexedDB.open('muxpad-private-device', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('keys');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(Error('Browser storage busy'));
      });
    return opened;
  };
  const operation = async (mode, work) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('keys', mode);
      const request = work(transaction.objectStore('keys'));
      let result;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || Error('Browser storage failed'));
      transaction.onabort = () => reject(transaction.error || Error('Browser storage aborted'));
    });
  };
  return {
    get: () => operation('readonly', (s) => s.get('primary')),
    put: (value) => operation('readwrite', (s) => s.put(value, 'primary')),
    clear: () => operation('readwrite', (s) => s.delete('primary')),
  };
}
async function request(path, body, csrf) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-muxpad-csrf': csrf || '' },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = Error(data.error || 'Approval connection unavailable');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
export function createDeviceClient({
  store = keyStore(),
  subtle = globalThis.crypto?.subtle,
  locks = globalThis.navigator?.locks,
  call = request,
  origin = globalThis.location?.origin,
} = {}) {
  const canonical = (k) => ({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });
  const deviceID = async (jwk) =>
    base64url(await subtle.digest('SHA-256', encoder.encode(JSON.stringify(canonical(jwk)))));
  async function checkStored(record) {
    if (
      !record ||
      record.privateKey?.type !== 'private' ||
      record.privateKey.extractable ||
      record.privateKey.algorithm?.name !== 'ECDSA' ||
      record.privateKey.algorithm?.namedCurve !== 'P-256' ||
      (await deviceID(record.publicKey)) !== record.deviceID
    )
      throw Error('Saved browser credential unavailable');
    const bytes = encoder.encode('muxpad local browser-storage signing test');
    const signature = await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      record.privateKey,
      bytes,
    );
    const publicKey = await subtle.importKey(
      'jwk',
      record.publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    if (!(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, bytes)))
      throw Error('Saved browser key mismatch');
    return record;
  }
  async function renew(record) {
    await checkStored(record);
    const challenge = await call('/device/challenge', { deviceID: record.deviceID });
    if (typeof challenge.message !== 'string' || challenge.message.length > 2048)
      throw Error('Invalid device challenge');
    const value = JSON.parse(challenge.message);
    if (
      Object.keys(value).sort().join(',') !== 'challengeID,deviceID,nonce,origin,purpose,version' ||
      value.version !== 1 ||
      value.purpose !== 'muxpad-human-session-renewal' ||
      value.origin !== origin ||
      value.deviceID !== record.deviceID ||
      value.challengeID !== challenge.challengeID ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.challengeID || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.nonce || '')
    )
      throw Error('Invalid device challenge');
    const signature = base64url(
      await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        record.privateKey,
        encoder.encode(challenge.message),
      ),
    );
    // A lost response is not retried with this proof. A later ensure obtains a fresh challenge.
    await call('/device/session', {
      deviceID: record.deviceID,
      challengeID: challenge.challengeID,
      signature,
    });
    return call('/human/session');
  }
  async function getSession() {
    try {
      return await call('/human/session');
    } catch (error) {
      if (error.status !== 401 || error.data?.authMode !== 'tailnet-peer' || !error.data.bootstrap)
        throw error;
      // Same-origin JSON POST, never a side effect of cross-origin GET.
      // A lost issuance response is not replayed by this attempt.
      await call('/human/node/session', {});
      return call('/human/session');
    }
  }
  async function ensure() {
    if (!subtle || !locks?.request) {
      const session = await getSession();
      return { ...session, durable: session.authMode === 'tailnet-peer' };
    }
    return locks.request(LOCK, { mode: 'exclusive' }, async () => {
      let session;
      try {
        session = await getSession();
      } catch (error) {
        if (error.status !== 401 || error.data?.authMode === 'tailnet-peer') throw error;
        session = await renew(await store.get());
      }
      if (session.authMode === 'tailnet-peer') return { ...session, durable: true };
      try {
        let record;
        try {
          record = await store.get();
        } catch {
          return { ...session, durable: false };
        }
        if (!record && session.deviceEnrolled) return { ...session, durable: false };
        if (!record) {
          const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
            'sign',
            'verify',
          ]);
          const publicKey = canonical(await subtle.exportKey('jwk', keys.publicKey));
          record = {
            privateKey: keys.privateKey,
            publicKey,
            deviceID: await deviceID(publicKey),
            registered: false,
          };
          try {
            await store.put(record);
            record = await checkStored(await store.get());
          } catch {
            return { ...session, durable: false };
          }
        } else await checkStored(record);
        if (!record.registered || !session.deviceEnrolled) {
          const response = await call(
            '/human/device/register',
            { publicKey: record.publicKey },
            session.csrf,
          );
          if (response.deviceID !== record.deviceID) throw Error('Device registration mismatch');
          await store.put({ ...record, registered: true });
        }
        return { ...session, durable: true };
      } catch {
        // Optional durable setup must not discard an already authenticated session.
        // Retain any saved key: an uncertain registration is recovered idempotently.
        return { ...session, durable: false };
      }
    });
  }
  async function revoke() {
    const work = async () => {
      let session;
      try {
        session = await getSession();
      } catch (error) {
        if (error.status !== 401 || !subtle || error.data?.authMode === 'tailnet-peer') throw error;
        session = await renew(await store.get());
      }
      await call('/human/logout', {}, session.csrf);
      if (session.authMode !== 'tailnet-peer') await store.clear();
    };
    return locks?.request ? locks.request(LOCK, { mode: 'exclusive' }, work) : work();
  }
  async function resume() {
    const { challenge } = await call('/human/node/challenge', {});
    await call('/human/node/resume', { challenge });
    return ensure();
  }
  async function revokeNode() {
    const session = await call('/human/session');
    if (session.authMode !== 'tailnet-peer') throw Error('Tailnet node session required');
    await call('/human/node/revoke', {}, session.csrf);
  }
  return { ensure, revoke, resume, revokeNode };
}
export const deviceClient = createDeviceClient();
