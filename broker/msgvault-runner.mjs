import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertProtectedPath } from './protected-path.mjs';
import { msgvaultArgv } from './msgvault.mjs';

/**
 * RUNNING msgvault, FROM THE SIDE THE AGENT CANNOT REACH.
 *
 * The broker holds the grant; the agent holds nothing. This module is the
 * only place the two meet, and it is deliberately small: a declaration is
 * read, a command line is composed elsewhere, a process is run with no shell.
 *
 * ── THE DECLARATION IS TRUSTED THE SAME WAY THE SLACK TOKEN IS ───────────
 * It names the binary to run and the file to present as a credential, so an
 * agent that could edit it could point the broker at a program of its own and
 * be handed the grant. `assertProtectedPath` is the same check the Slack token
 * goes through — root-owned, no group or other write, no ACLs, all the way up
 * the ancestor chain — and a failure REFUSES rather than falling back.
 *
 * ── AND IT IS READ PER CALL, NOT CACHED ──────────────────────────────────
 * A declaration edited to something untrusted must stop working at the next
 * call, not at the next restart. This runs once per approved request, which
 * is a human-paced rate.
 */
export function msgvaultRunner({
  declarationPath = '/Library/muxpad/integrations.json',
  io = { readFileSync, assertProtectedPath },
  run = execFile,
  timeoutMs = 30_000,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  return async (action, payload) => {
    // NO `mode` OPTION. It is an EXACT expected mode, not a mask — passing
    // 0o022 asserted "this file is mode ----w--w-", which no readable file
    // ever is, so every call threw 'Incorrect protected file mode' and the
    // whole path was dead on arrival. The walk itself already refuses any
    // group/other write (`st.mode & 0o022`) on the file and every ancestor,
    // which is the property wanted here.
    io.assertProtectedPath(declarationPath, [0]);
    const declared = JSON.parse(io.readFileSync(declarationPath, 'utf8'))?.msgvault;
    if (!declared) throw new Error('msgvault is not declared on this machine');
    // Loopback only, re-asserted here rather than assumed from the writer:
    // this is the step that would send the grant somewhere.
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(String(declared.agentUrl)))
      throw new Error('msgvault agentUrl must be loopback');
    // The binary must be as protected as the declaration that names it.
    io.assertProtectedPath(declared.binary, [0]);
    const { binary, args } = msgvaultArgv(action, payload, declared);
    return await new Promise((resolve, reject) => {
      run(
        binary,
        args,
        // NO SHELL, and an empty environment: msgvault reads MSGVAULT_HOME and
        // friends, and inheriting the broker's would be a second way to
        // re-point it that nobody approved.
        { timeout: timeoutMs, maxBuffer: maxBytes, env: {}, shell: false },
        (err, stdout, stderr) => {
          if (err) {
            // msgvault's own refusals are the useful half of this — "query is
            // not available in agent-delegated mode" tells the agent what to
            // do instead. The grant itself is never in this text: it was
            // passed as a path.
            const detail = String(stderr || err.message).trim().split('\n')[0];
            reject(new Error(detail.slice(0, 300) || 'msgvault failed'));
            return;
          }
          const text = String(stdout);
          try {
            resolve({ action, result: JSON.parse(text) });
          } catch {
            resolve({ action, text: text.slice(0, maxBytes) });
          }
        },
      );
    });
  };
}
