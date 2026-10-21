import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { assertProtectedPath } from './protected-path.mjs';
import { listenPrivateSocket } from './socket-listener.mjs';
export async function listenPasskeyAdmin(
  server,
  path,
  { uid = process.getuid(), inspectACL = true } = {},
) {
  assertProtectedPath(dirname(path), [0, uid], { mode: 0o700, inspectACL });
  let exists = false;
  try {
    const st = lstatSync(path);
    if (!st.isSocket() || st.uid !== uid || (st.mode & 0o777) !== 0o600)
      throw Error('Unsafe admin socket');
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (exists) {
    const stale = await new Promise((resolve, reject) => {
      const client = createConnection(path);
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client.destroy();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(Error('Admin socket status unknown')), 500);
      client.once('connect', () => finish(null, false));
      client.once('error', (e) =>
        ['ECONNREFUSED', 'ENOENT'].includes(e.code)
          ? finish(null, true)
          : finish(Error('Admin socket unavailable')),
      );
    });
    if (!stale) throw Error('Admin socket is already live');
  }
  await listenPrivateSocket(server, path, { uid, inspectACL });
}
