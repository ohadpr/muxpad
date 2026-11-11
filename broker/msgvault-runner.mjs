import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { msgvaultArgv } from './msgvault.mjs';
import { assertProtectedPath } from './protected-path.mjs';

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
  // An attachment comes back base64'd inside JSON, so 4 MiB of output is a
  // 3 MiB file — smaller than a scanned PDF. Past this, execFile fails with
  // "maxBuffer exceeded" rather than truncating, so the cap is loud.
  attachmentMaxBytes = 32 * 1024 * 1024,
  // Injected in tests. The attachment path does not shell the binary — see
  // below — so it needs its own seam.
  fetchImpl = fetch,
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
    // ── ATTACHMENTS GO STRAIGHT TO THE DAEMON ──────────────────────────
    //
    // msgvault's CLI refuses every export verb in agent-delegated mode —
    // `export-attachment`, `export-attachments`, `export-eml` all fail with
    // "not available in agent-delegated mode", and they fail CLIENT-SIDE,
    // before the daemon is contacted. So the verb muxpad shipped could never
    // work through argv, however the broker was updated.
    //
    // The daemon itself has no such objection: `/api/v1/cli/attachment` is on
    // the same `/api/v1/cli/*` surface the ALLOWED verbs already use (search,
    // message, thread, stats), authenticated by the same `X-Api-Key`, and it
    // answers with the bytes.
    //
    // So this one action skips the binary. That is not a widening: the
    // broker already names this token file and hands it to a process it
    // spawns; reading it to set a header is the same privilege, spent the
    // same way, on a read that was already in the read scope and already
    // approved per call. The url is loopback (asserted above) and the token
    // file is protected-path checked like the binary.
    if (action === 'msgvault.export-attachment') {
      const hash = String(payload?.hash ?? '');
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('attachment needs a 64-hex content hash');
      io.assertProtectedPath(declared.tokenFile, [0]);
      const token = String(io.readFileSync(declared.tokenFile, 'utf8')).trim();
      const url = `${String(declared.agentUrl).replace(/\/+$/, '')}/api/v1/cli/attachment?content_hash=${hash}`;
      const res = await fetchImpl(url, {
        headers: { 'X-Api-Key': token },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // The daemon's own refusal, kept: a 401 here means the agent key is
        // not accepted for attachments, which is a msgvault-side decision an
        // agent must be told plainly rather than left to retry.
        throw new Error(
          `msgvault refused the attachment (${res.status}) — ${(await res.text().catch(() => '')).slice(0, 160) || 'no detail'}`,
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > attachmentMaxBytes)
        throw new Error(`attachment is larger than the ${attachmentMaxBytes} byte cap`);
      // `filename*=` first — RFC 5987 is what carries a non-ASCII name — then
      // the plain form. Absent, muxpad's CLI names the file after the hash.
      const cd = res.headers.get('content-disposition') ?? '';
      const name =
        /filename\*=(?:UTF-8'')?"?([^";]+)/i.exec(cd)?.[1] ??
        /filename="?([^";]+)/i.exec(cd)?.[1] ??
        '';
      return {
        action,
        result: {
          content_hash: hash,
          data_base64: buf.toString('base64'),
          size: buf.byteLength,
          ...(name ? { filename: decodeURIComponent(name) } : {}),
          ...(res.headers.get('content-type')
            ? { mime_type: String(res.headers.get('content-type')).split(';')[0] }
            : {}),
        },
      };
    }

    const { binary, args } = msgvaultArgv(action, payload, declared);
    const limit = action === 'msgvault.export-attachment' ? attachmentMaxBytes : maxBytes;
    return await new Promise((resolve, reject) => {
      run(
        binary,
        args,
        // NO SHELL, and an empty environment: msgvault reads MSGVAULT_HOME and
        // friends, and inheriting the broker's would be a second way to
        // re-point it that nobody approved.
        { timeout: timeoutMs, maxBuffer: limit, env: {}, shell: false },
        (err, stdout, stderr) => {
          if (err) {
            // msgvault's own refusals are the useful half of this — "query is
            // not available in agent-delegated mode" tells the agent what to
            // do instead. The grant itself is never in this text: it was
            // passed as a path.
            const detail = String(stderr || err.message)
              .trim()
              .split('\n')[0];
            reject(new Error(detail.slice(0, 300) || 'msgvault failed'));
            return;
          }
          const text = String(stdout);
          try {
            resolve({ action, result: JSON.parse(text) });
          } catch {
            resolve({ action, text: text.slice(0, limit) });
          }
        },
      );
    });
  };
}
