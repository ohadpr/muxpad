import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

// Every grant mechanism the platform has, not only the Unix mode bits. A file
// at 0600 owned by root is still readable by somebody holding an ACL entry, a
// POSIX ACL, or (on Linux) a file capability, and each of those is invisible in
// `st.mode`. An arm that cannot verify its platform's mechanisms REFUSES: a
// skipped check reads exactly like a passed one at the call site, and these
// calls are what stand between an agent account and a Slack token.
const INSPECTORS = {
  // Reject ALL ACLs, including inherited grants. Do not try to infer effective
  // permissions from Unix mode bits alone.
  darwin: (path) => {
    const acl = run('/bin/ls', ['-lde', path]);
    if (/^\s*\d+:\s/m.test(acl)) throw Error('ACL on protected file or ancestor');
  },
  linux: (path) => {
    // `--skip-base` prints nothing when the file carries only the three base
    // entries that mirror the mode bits — so any output at all is an extended
    // ACL. Default ACLs on a directory print here too, and they are refused as
    // well: an ancestor that grants by default is a misconfiguration whether or
    // not it has granted anything yet.
    if (tool('getfacl', ['--absolute-names', '--omit-header', '--skip-base', '--', path]).trim())
      throw Error('ACL on protected file or ancestor');
    // Linux-only, and no macOS analogue: a binary carrying file capabilities
    // can escalate without being setuid, which the mode check would pass.
    if (tool('getcap', ['--', path]).trim())
      throw Error('File capabilities on protected file or ancestor');
  },
};

/** Run a system tool, or refuse. An absent tool is not an absent risk. */
function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw Error(`Protected deployment requires ${file}`);
  }
}

/** The same, for tools whose location differs by distribution. `getcap` is in
 *  /sbin on Debian and /usr/sbin elsewhere, and neither is on a daemon's PATH
 *  — which is why every path here is absolute. */
function tool(name, args) {
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    try {
      return execFileSync(`${dir}/${name}`, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      // A tool that RAN and refused is an answer; only "no such file" is a
      // reason to keep looking. Anything else is this path failing its check.
      if (e.code !== 'ENOENT') throw Error(`${name} refused to inspect a protected path`);
    }
  }
  throw Error(`Protected deployment requires ${name} (install the acl/libcap tools)`);
}

export function assertProtectedPath(path, owners, { mode, inspectACL = true } = {}) {
  if (!isAbsolute(path)) throw Error('Protected paths must be absolute');
  const inspect = INSPECTORS[process.platform];
  if (inspectACL && !inspect)
    throw Error(`Protected deployment is not supported on ${process.platform}`);
  let current = path;
  while (true) {
    const st = lstatSync(current);
    if (st.isSymbolicLink() || !owners.includes(st.uid) || st.mode & 0o022)
      throw Error('Unprotected file or ancestor');
    if (current === path && mode !== undefined && (st.mode & 0o777) !== mode)
      throw Error('Incorrect protected file mode');
    if (st.isFile() && st.nlink !== 1) throw Error('Hardlinked protected file');
    if (inspectACL) inspect(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
