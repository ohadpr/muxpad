import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export function assertProtectedPath(path, owners, { mode, inspectACL = true } = {}) {
  if (!isAbsolute(path)) throw Error('Protected paths must be absolute');
  let current = path;
  while (true) {
    const st = lstatSync(current);
    if (st.isSymbolicLink() || !owners.includes(st.uid) || st.mode & 0o022)
      throw Error('Unprotected file or ancestor');
    if (current === path && mode !== undefined && (st.mode & 0o777) !== mode)
      throw Error('Incorrect protected file mode');
    if (st.isFile() && st.nlink !== 1) throw Error('Hardlinked protected file');
    if (inspectACL) {
      if (process.platform !== 'darwin')
        throw Error('Protected deployment requires macOS ACL verification');
      const acl = execFileSync('/bin/ls', ['-lde', current], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // Reject ALL ACLs, including inherited grants. Do not try to infer
      // effective permissions from Unix mode bits alone.
      if (/^\s*\d+:\s/m.test(acl)) throw Error('ACL on protected file or ancestor');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
