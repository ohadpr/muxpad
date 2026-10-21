import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertProtectedPath } from './protected-path.mjs';

// No TCP fallback. The private parent directory prevents listener substitution.
export function listenPrivateSocket(
  server,
  path,
  { uid = process.getuid(), inspectACL = true } = {},
) {
  assertProtectedPath(dirname(path), [0, uid], { mode: 0o700, inspectACL });
  try {
    const st = lstatSync(path);
    if (!st.isSocket() || st.uid !== uid) throw Error('Refusing unexpected socket path');
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(path, () => {
      try {
        chmodSync(path, 0o600);
        server.off('error', onError);
        resolve();
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
}
