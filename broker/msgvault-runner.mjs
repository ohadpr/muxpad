import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { msgvaultArgv, validateMsgvault } from './msgvault.mjs';
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
/**
 * TURN msgvault's OPAQUE REFUSALS INTO SOMETHING A READER CAN ACT ON.
 *
 * The refusals are returned verbatim on purpose — "query is not available in
 * agent-delegated mode" tells an agent exactly what to do instead. But one of
 * them tells nobody anything, and it has cost more of the owner's time than
 * any other failure in this system: `draft_disabled`.
 *
 * What agents did with it, repeatedly, across sessions in the archive: they
 * reported "the mail tool keeps rejecting new drafts with draft_disabled;
 * only you can re-enable drafts" and stopped. There is no such switch. The
 * actual meaning, measured against the installed binary, is that msgvault
 * composes a NEW email only into an IMAP source, and the configured mailbox
 * is a Gmail (API) source — so compose is refused for everyone, always,
 * while `draft-reply` works fine because replying needs no IMAP.
 *
 * An error nobody can act on is worse than a missing feature: the owner was
 * asked four times to flip a switch that does not exist. So the verbatim text
 * is kept — it is still the ground truth — and what it MEANS is added after
 * it, including the one thing that would change the answer.
 */
export function explainRefusal(action, detail) {
  if (!/draft_disabled/i.test(detail)) return detail;
  const composing = String(action).includes('compose');
  return [
    detail,
    '',
    'What this means: msgvault writes a NEW email only into an IMAP source, and',
    'the mailbox muxpad is configured to draft into is a Gmail (API) source, so',
    'it refuses compose for every caller. There is no "drafts" switch to turn on',
    '— do not ask the owner to re-enable them.',
    '',
    composing
      ? 'What works instead: draft-reply, on any message in the thread you want to answer.'
      : 'Replying to an existing message (draft-reply) is unaffected.',
    'What would change this: the owner adding that mailbox over IMAP with an',
    "[[imap.drafts]] grant in msgvault's own config. That is their machine and",
    'their credential; no agent can do it.',
  ].join('\n');
}

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
  /** Index into the attachment route list that last answered; -1 until one does. */
  let preferredRoute = -1;
  const runner = async (action, payload) => {
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
    // PARSED, NOT PATTERN-MATCHED. The regex this replaces accepted
    // `http://127.0.0.1:@evil.example`, where everything before the `@` is
    // USERINFO and the host is evil.example — so the grant header would have
    // gone off the machine. Reaching it needs write access to the root-owned
    // declaration, but this check exists precisely so it does not rest on
    // that file's author, and as written it did.
    let agent;
    try {
      agent = new URL(String(declared.agentUrl));
    } catch {
      throw new Error('msgvault agentUrl must be loopback');
    }
    if (
      !['http:', 'https:'].includes(agent.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(agent.hostname)
    )
      throw new Error('msgvault agentUrl must be loopback');
    // The binary must be as protected as the declaration that names it.
    io.assertProtectedPath(declared.binary, [0]);
    // ── ATTACHMENTS GO STRAIGHT TO THE DAEMON ──────────────────────────
    //
    // msgvault's CLI refuses every export verb in agent-delegated mode —
    // `export-attachment`, `export-attachments`, `export-eml` all fail with
    // "not available in agent-delegated mode", and they fail CLIENT-SIDE,
    // before the daemon is contacted. So the verbs muxpad shipped could never
    // work through argv, however the broker was updated.
    //
    // The daemon itself has no such objection and answers with the bytes.
    //
    // So these two actions skip the binary. That is not a widening: the
    // broker already names this token file and hands it to a process it
    // spawns; reading it to set a header is the same privilege, spent the
    // same way, on a read that was already in the read scope and already
    // approved per call. The url is loopback (asserted above) and the token
    // file is protected-path checked like the binary.
    if (action === 'msgvault.export-attachment') {
      const hash = String(payload?.hash ?? '');
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('attachment needs a 64-hex content hash');
      return { action, result: await fetchAttachment(hash, attachmentKey(declared), declared) };
    }
    /**
     * ── EVERY ATTACHMENT ON ONE MESSAGE, IN ONE APPROVAL ───────────────
     *
     * The single-hash verb needs a `content_hash`, which is learnable only
     * from an approved `show-message`. So "save the attachments on this
     * email" was two approvals and an agent transcribing hashes between
     * them — and for a message with five scans, six. This does the read
     * itself and fetches what it lists: ONE dialog, naming the message.
     *
     * The hashes come from the archive's own listing, never from the agent,
     * so this grants nothing the single verb did not already allow — it is
     * the same bytes, reached without making the agent hold the hashes.
     */
    if (action === 'msgvault.export-attachments') {
      const id = String(payload?.id ?? '');
      const message = (
        await exec(
          'msgvault.show-message',
          validateMsgvault('msgvault.show-message', { id }),
          declared,
        )
      ).result;
      const listed = Array.isArray(message?.attachments) ? message.attachments : [];
      // Deduped: one content hash is one set of bytes, and a message that
      // carries the same image twice would otherwise be fetched twice and
      // counted twice against the cap.
      const seen = new Set();
      const wanted = [];
      // Counted separately from `wanted`, because the two differ for a reason
      // that matters: a DUPLICATE is dropped from `wanted` and is still
      // retrievable — the same bytes, handed over once.
      let usable = 0;
      for (const a of listed) {
        const hash = String(a?.content_hash ?? '');
        if (!/^[a-f0-9]{64}$/.test(hash)) continue;
        usable += 1;
        if (seen.has(hash)) continue;
        seen.add(hash);
        wanted.push({ hash, filename: typeof a?.filename === 'string' ? a.filename : '' });
      }
      // No attachments means no reason to touch the grant file at all.
      const key = wanted.length ? attachmentKey(declared) : '';
      const attachments = [];
      let total = 0;
      for (const { hash, filename } of wanted) {
        const one = await fetchAttachment(hash, key, declared);
        total += one.size;
        if (total > attachmentMaxBytes)
          // THE HASHES ARE IN THE MESSAGE. It said "fetch them one at a time
          // by content_hash" and returned none, so following the advice took
          // a second approved show-message to learn them.
          throw new Error(
            `this message's attachments come to more than the ${attachmentMaxBytes} byte cap — fetch them one at a time: ${wanted.map((w) => w.hash).join(' ')}`,
          );
        // msgvault's own listing names the file and is preferred: a
        // Content-Disposition is the same sender-chosen string arriving by a
        // worse route. Neither is trusted as a PATH — muxpad's CLI sanitises
        // it to one plain component on the caller's side.
        attachments.push({ ...one, ...(filename ? { filename } : {}) });
      }
      return {
        action,
        result: {
          message_id: Number.isSafeInteger(message?.id) ? message.id : id,
          count: attachments.length,
          // Said out loud rather than silently dropped: a listing entry with
          // no usable content hash is an attachment the archive knows about
          // and cannot hand over.
          //
          // ENTRIES WITH NO USABLE HASH — not "listed minus delivered". That
          // older sum counted DUPLICATES as unretrievable: a message listing
          // the same hash twice had both delivered and was then told one was
          // missing, sending an agent to look for a file that does not
          // exist.
          ...(listed.length !== usable ? { not_retrievable: listed.length - usable } : {}),
          attachments,
        },
      };
    }

    const out = await exec(action, payload, declared);
    if (action === 'msgvault.draft-get') return await checkDraftLifecycle(out, declared);
    if (action === 'msgvault.draft-reply' || action === 'msgvault.draft-compose')
      return await nameMailbox(out, declared);
    return out;
  };

  /**
   * ── AFTER THE DRAFT EXISTS, SAY WHERE IT WENT ──────────────────────────
   *
   * Before approval the dialog can only state the rule ("the mailbox that
   * message came in to"): resolving the address then would hand any agent an
   * unapproved oracle for which account holds any message id. AFTER, there is
   * nothing left to leak — the human approved this act and the receipt is
   * theirs. msgvault's receipt carries `source_id` but no address, so the
   * draft's OWN message is read and its sender reported: the identity the
   * draft was saved under, which is what the owner needs to know to find it.
   *
   * Best-effort: a failed read leaves the receipt exactly as msgvault gave it.
   */
  async function nameMailbox(out, declared) {
    const draft = out?.result;
    const messageID = draft?.message_id;
    if (!draft || typeof draft !== 'object' || !Number.isSafeInteger(messageID) || messageID < 1)
      return out;
    try {
      const message = (
        await exec(
          'msgvault.show-message',
          validateMsgvault('msgvault.show-message', { id: String(messageID) }),
          declared,
        )
      ).result;
      const from = message?.id === messageID ? message?.from?.[0]?.email : undefined;
      if (typeof from !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(from)) return out;
      return { ...out, result: { ...draft, mailbox: { source_id: draft.source_id, from } } };
    } catch {
      return out;
    }
  }

  /**
   * ── A DRAFT'S LIFECYCLE IS CHECKED, NOT REMEMBERED ─────────────────────
   *
   * `draft-get` answers from msgvault's own record of the draft, and that
   * record is not re-checked against Gmail: it said `lifecycle: active`
   * hours after Gmail had dropped the draft, with `provider_observation`
   * sitting at `not_checked` throughout. A state nobody confirmed, presented
   * as the state.
   *
   * msgvault has no verb that asks Gmail. What it does have is the archive's
   * own copy of the draft's message: `show-message` on the draft's
   * `message_id` carries `deleted_from_source_at` once a sync has seen the
   * draft leave the mailbox (measured 2026-11-13 on 339084: present and
   * timestamped for a draft Gmail dropped; absent on a live message). So one
   * more read, of the draft's own message, turns "remembered" into "checked
   * as of the last sync" — and the result says which of the three it is:
   *
   *   · `gone_from_provider` — the archive saw it leave Gmail (sent or
   *     discarded; both remove a draft). `lifecycle` is rewritten from
   *     `active`, and the original is kept as `lifecycle_recorded`.
   *   · `not_marked_deleted_as_of_last_sync` — the best this archive can
   *     say. Not proof it is still there; the note says so.
   *   · `unverified` — the check could not be made. `lifecycle` is then
   *     `unverified` too, rather than an `active` nobody looked at.
   *
   * This runs as the same approved request: it reads only the draft's own
   * message, which the draft-get already reaches, and nothing of it beyond
   * the deletion marker is returned.
   */
  async function checkDraftLifecycle(out, declared) {
    const draft = out?.result;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return out;
    const recorded = draft.lifecycle;
    const messageID = draft.message_id;
    const unverified = (why) => ({
      ...out,
      result: {
        ...draft,
        ...(recorded === 'active' ? { lifecycle: 'unverified', lifecycle_recorded: recorded } : {}),
        lifecycle_check: {
          verdict: 'unverified',
          note: `muxpad could not check this draft against the archive (${why}); its lifecycle is msgvault's record, not an observation`,
        },
      },
    });
    if (!Number.isSafeInteger(messageID) || messageID < 1) return unverified('no message_id');
    let message;
    try {
      message = (
        await exec(
          'msgvault.show-message',
          validateMsgvault('msgvault.show-message', { id: String(messageID) }),
          declared,
        )
      ).result;
    } catch (e) {
      return unverified(String(e?.message ?? e).slice(0, 120));
    }
    if (!message || typeof message !== 'object' || message.id !== messageID)
      return unverified('the archive answered for a different message');
    const gone =
      typeof message.deleted_from_source_at === 'string' && message.deleted_from_source_at;
    return {
      ...out,
      result: {
        ...draft,
        ...(gone && recorded === 'active'
          ? { lifecycle: 'gone_from_provider', lifecycle_recorded: recorded }
          : {}),
        lifecycle_check: gone
          ? {
              verdict: 'gone_from_provider',
              message_id: messageID,
              deleted_from_source_at: message.deleted_from_source_at,
              note: 'the archive saw this draft leave the mailbox (sent or discarded); it is not in Gmail now',
            }
          : {
              verdict: 'not_marked_deleted_as_of_last_sync',
              message_id: messageID,
              note: 'the archive has not seen it leave the mailbox — as of its last sync, not a live check of Gmail',
            },
      },
    };
  }

  /**
   * ── THE GRANT, READ FRESH AND CHECKED FIRST ────────────────────────────
   *
   * Root OR THIS PROCESS, at exactly 0600. The installed token is owned by
   * the broker's own account — it is the one account that may read it — so a
   * root-only check refused every attachment ("Unprotected file or
   * ancestor"). Ancestors still have to be root's: the walk applies the same
   * owner list, and /Library/muxpad-broker is root-owned.
   */
  function attachmentKey(declared) {
    io.assertProtectedPath(declared.tokenFile, [0, process.getuid?.() ?? 0], { mode: 0o600 });
    return String(io.readFileSync(declared.tokenFile, 'utf8')).trim();
  }

  /**
   * ── TWO ROUTES, ONE OF THEM BETTER ────────────────────────────────────
   *
   * muxpad shipped `/api/v1/cli/attachment?content_hash=`, reasoning that it
   * sat on the same `/api/v1/cli/*` surface as the reads that already
   * worked. It does — and it answered every attachment with
   *
   *     401 {"error":"unauthorized","message":"Invalid or missing API key"}
   *
   * which is the OWNER key's refusal, not the grant's: the same wall as
   * `agent-token list`. Five scanned PDFs could not be fetched at all. The
   * `/cli/*` prefix is not one permission surface, and nothing in the spec
   * said which half of it a grant reaches.
   *
   * That reasoning was wrong about the cause — see GRANT_HEADER below, the
   * 401 was a misnamed header and nothing to do with the route — but the
   * route order is still worth keeping: measured, BOTH routes answer with
   * the grant header, and `/api/v1/attachments/{hash}/content` reports the
   * real content type (`application/pdf`) where the cli route reports
   * `application/octet-stream`. So the plain API route is tried first and
   * the cli route stays as a working fallback.
   *
   * The route that works is remembered for the life of the process, so the
   * whole-message verb does not pay a failed request per attachment.
   */
  /**
   * ── THE GRANT IS NOT AN API KEY, AND THE HEADER NAME SAYS SO ───────────
   *
   * muxpad sent the grant as `X-Api-Key`, and every attachment came back
   *
   *     401 {"error":"unauthorized","message":"Invalid or missing API key"}
   *
   * which reads like a rejected credential and is not. msgvault has TWO
   * header names — `X-Api-Key` for the OWNER's key and this one for a grant
   * — and that message is the honest answer to a request carrying no api key
   * at all. The owner's key is the one thing the broker must never hold, so
   * the header muxpad was using could only ever fail. Five scanned PDFs went
   * undownloadable for a day because the error sounded like a permissions
   * decision about attachments rather than a misnamed header.
   *
   * Measured 2026-11-14 against the live daemon, all four combinations:
   * this header returns 200 and 6,793,706 bytes on BOTH routes;
   * `X-Api-Key` returns 401 on both. So there is no api-key fallback —
   * a fallback that cannot succeed only adds a confusing status to an
   * error message.
   */
  const GRANT_HEADER = 'X-Msgvault-Agent-Token';

  async function fetchAttachment(hash, key, declared) {
    const base = String(declared.agentUrl).replace(/\/+$/, '');
    const routes = [
      `/api/v1/attachments/${hash}/content`,
      `/api/v1/cli/attachment?content_hash=${hash}`,
    ];
    const order = routes
      .map((_, i) => i)
      .sort((a, b) => (a === preferredRoute ? -1 : b === preferredRoute ? 1 : a - b));
    const refusals = [];
    /** Did a route refuse on PERMISSION? Only then is a fallback worth keeping. */
    let sticky = false;
    for (const i of order) {
      let res;
      try {
        res = await fetchImpl(`${base}${routes[i]}`, {
          headers: { [GRANT_HEADER]: key },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // A THROW IS A FAILED ROUTE, NOT A FAILED VERB. `fetch` throws on
        // ECONNREFUSED and `AbortSignal.timeout` throws TimeoutError; both
        // escaped this loop, so the second route was never tried and one
        // blip on the first killed the whole download.
        refusals.push(`${routes[i].split('?')[0]} → ${String(e?.message ?? e).slice(0, 60)}`);
        continue;
      }
      if (!res.ok) {
        // The daemon's own refusal, kept verbatim and per route: a 401 on
        // both means the grant is not accepted for attachments at all, which
        // is a msgvault-side decision an agent must be told plainly rather
        // than left to retry.
        const detail = (await res.text().catch(() => '')).slice(0, 120);
        refusals.push(`${routes[i].split('?')[0]} → ${res.status}${detail ? ` ${detail}` : ''}`);
        // ── ONLY AN ANSWER ABOUT PERMISSION IS WORTH REMEMBERING ────────
        // The preference moved on ANY non-OK. One 503 or 404 during a
        // daemon restart therefore pinned the process to the cli route —
        // which keeps working, so it never switched back — and every later
        // attachment reported `application/octet-stream` instead of its
        // real type for the life of the broker. 401/403 is a stable
        // decision about the grant; everything else is weather.
        if (res.status === 401 || res.status === 403) sticky = true;
        continue;
      }
      // Remembered only when the route BEFORE it gave a permission answer, or
      // when it is the first choice anyway. Setting it on any success meant a
      // single 503 moved the process to the cli route permanently: the
      // fallback keeps working, so nothing ever moved it back, and every
      // later attachment reported application/octet-stream.
      if (i === 0 || sticky) preferredRoute = i;
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
        content_hash: hash,
        data_base64: buf.toString('base64'),
        size: buf.byteLength,
        ...(name ? { filename: decodeURIComponent(name) } : {}),
        ...(res.headers.get('content-type')
          ? { mime_type: String(res.headers.get('content-type')).split(';')[0] }
          : {}),
      };
    }
    throw new Error(`msgvault refused the attachment — ${refusals.join('; ')}`);
  }

  function exec(action, payload, declared) {
    const { binary, args } = msgvaultArgv(action, payload, declared);
    const limit = action === 'msgvault.export-attachment' ? attachmentMaxBytes : maxBytes;
    return new Promise((resolve, reject) => {
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
            reject(new Error(explainRefusal(action, detail.slice(0, 300) || 'msgvault failed')));
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
  }
  return runner;
}
