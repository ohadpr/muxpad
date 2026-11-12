import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { classify } from '../connectors/registry.js';
import {
  type ConnectorPolicy,
  directingOrigin,
  loadPolicy,
  mayPaneUse,
} from '../connectors/scope.js';
import { verifyPaneKey } from '../pane-key.js';
import { recordSlackAction, recordSlackRefusal, resolveSlackAction } from '../slack-actions.js';
import { slackBrokerRequest, slackBrokerURL } from '../slack-broker.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { slackNoticeDiagnosticRoutes } from './slack-notice-diagnostic.js';
import { slackPasskeyRoutes } from './slack-passkey.js';
import { slackSetupRoutes } from './slack-setup.js';

/** Slack credentials and execution belong exclusively to the protected broker. */
interface Deps {
  db: Database.Database;
  dataDir: string;
  /**
   * How the host-scoping policy is read. Injected only by tests.
   *
   * A path would not have been enough: the real policy must be ROOT-OWNED to
   * be trusted at all, so a file a test can write is refused by design and
   * every connector would read as blocked. The loader is the seam; the
   * file-trust rules themselves are covered in connectors/scope.test.ts.
   */
  policy?: () => ConnectorPolicy & { problem?: string };
  /**
   * Ask a remote host to prove the request it is relaying is its own.
   *
   * Absent on an install with no hosts, and resolving to null is ORDINARY —
   * no key over there, the link dropped, or the action does not match what
   * the host's own caller asked for. The request then goes to the broker
   * unproven and a human approves it once. See HostLink#signOrigin.
   */
  signOrigin?: (
    nodeId: string,
    callId: string,
    action: string,
    payload: unknown,
  ) => Promise<unknown | null>;
}

/** What a refused call is told, and what it is NOT told. */
function refusal(why: string, detail?: string) {
  return { error: { code: 'slack_refused', message: why, detail } } as const;
}

/**
 * muxpad refused the send before the broker saw it.
 *
 * Thrown from the one funnel and mapped to a 403 by `app.onError` below, so
 * the gate lives in a single place instead of being returned through six
 * routes that each build their own response. The agent gets the reason
 * verbatim, because its useful next move is to say so rather than retry.
 */
class SlackRefused extends Error {
  constructor(
    readonly action: string,
    readonly payload: unknown,
    readonly pane: string,
    readonly why: string,
  ) {
    super(why);
  }
}

export function connectorRoutes(deps: Deps): { slack: Hono; archive: Hono } {
  const app = new Hono();
  app.route('/setup', slackSetupRoutes());
  const workspaces = new WorkspaceStore(deps.db);
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);
  app.route(
    '/notice-diagnostic',
    slackNoticeDiagnosticRoutes((id) => !!panes.getById(id)),
  );

  /** Identify the originating pane for chat-local notices; the broker authorizes Slack. */
  /**
   * Which host's in-flight call this is, if any.
   *
   * Written by {@link HostApi#dispatch} on the way in — a header this server
   * built, not one a host sent. On a local call it is absent, which is right:
   * `local` needs no proof.
   */
  const callerOf = (c: {
    req: { header: (name: string) => string | undefined };
  }): { nodeId: string; callId: string } | undefined => {
    const [nodeId, callId] = (c.req.header('x-muxpad-host-call') ?? '').split(' ');
    return nodeId && callId ? { nodeId, callId } : undefined;
  };

  async function authorize(
    paneId: unknown,
    paneKey: unknown,
    caller?: { nodeId: string; callId: string },
  ): Promise<
    | { ok: true; pane: string; caller?: { nodeId: string; callId: string } }
    | { ok: false; status: 403 | 400; body: ReturnType<typeof refusal> }
  > {
    if (typeof paneId !== 'string' || !paneId)
      return {
        ok: false,
        status: 400,
        body: refusal('no caller pane — this works only from inside a muxpad pane'),
      };

    // Pane keys route ordinary requests; they are not
    // a security boundary against agents sharing the server OS account.
    if (!verifyPaneKey(paneId, typeof paneKey === 'string' ? paneKey : null))
      return {
        ok: false,
        status: 403,
        body: refusal(
          'this pane cannot prove which workspace it is in',
          'A pane started before muxpad issued per-pane keys has none, and nothing can put one into a running process. Restart this pane (or open a new one) and try again. Setting MUXPAD_PANE_ID by hand will not help — the key is what is checked.',
        ),
      };

    const pane = panes.getById(paneId);
    const tab = pane ? tabs.getById(pane.tab_id) : null;
    const ws = tab ? workspaces.getById(tabs.getWorkspaceId(tab.id) ?? '') : null;
    if (!ws)
      return { ok: false, status: 403, body: refusal('cannot resolve this pane’s workspace') };

    if (!slackBrokerURL())
      return {
        ok: false,
        status: 403,
        body: refusal(
          'Protected Slack broker is not configured',
          'Configure the protected broker; local Slack credentials are unsupported.',
        ),
      };
    return { ok: true, pane: paneId, ...(caller ? { caller } : {}) };
  }

  // Advisory ownership comes only from an authenticated action caller, never a
  // status lookup. Payloads and human credentials stay in the protected broker.
  deps.db.exec(
    'CREATE TABLE IF NOT EXISTS slack_approval_notices (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, pane_id TEXT)',
  );
  const columns = deps.db.prepare('PRAGMA table_info(slack_approval_notices)').all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'pane_id'))
    deps.db.exec('ALTER TABLE slack_approval_notices ADD COLUMN pane_id TEXT');
  // Legacy notices have no provable owner. Retire them instead of broadcasting.
  deps.db.exec('DELETE FROM slack_approval_notices WHERE pane_id IS NULL');
  const remove = deps.db.prepare('DELETE FROM slack_approval_notices WHERE id = ?');
  const saveNotice = deps.db.prepare(
    'INSERT OR REPLACE INTO slack_approval_notices (id, expires, pane_id) VALUES (?, ?, ?)',
  );
  type Notice = { expires: number; pane: string; stale: boolean };
  const pending = new Map<string, Notice>();
  const overflow = new Map<string, number>();
  const noticeUnavailable = new Map<string, number>();
  const rows = deps.db
    .prepare('SELECT id, expires, pane_id FROM slack_approval_notices')
    .all() as Array<{ id: string; expires: number; pane_id: string }>;
  for (const row of rows) {
    if (!panes.getById(row.pane_id) || row.expires <= Date.now()) {
      remove.run(row.id);
      continue;
    }
    if (row.id === `overflow:${row.pane_id}`) overflow.set(row.pane_id, row.expires);
    else if (/^[a-f0-9-]{36}$/.test(row.id) && pending.size < 64)
      pending.set(row.id, { expires: row.expires, pane: row.pane_id, stale: true });
    else remove.run(row.id);
  }
  const forget = (id: string) => {
    remove.run(id);
    pending.delete(id);
  };
  const prune = () => {
    for (const [pane, expires] of noticeUnavailable)
      if (expires <= Date.now() || !panes.getById(pane)) noticeUnavailable.delete(pane);
    for (const [id, notice] of pending)
      if (notice.expires <= Date.now() || !panes.getById(notice.pane)) forget(id);
    for (const [pane, expires] of overflow)
      if (expires <= Date.now() || !panes.getById(pane)) {
        remove.run(`overflow:${pane}`);
        overflow.delete(pane);
      }
  };
  const track = (result: Record<string, unknown>, owner?: string) => {
    // Every status the broker reports, however it arrived — the action's own
    // reply, the approvals poll, a passkey ceremony — lands here, which makes
    // this the one place a card learns how its act ended.
    resolveSlackAction(deps.db, result);
    if (typeof result.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.id)) return;
    prune();
    const existing = pending.get(result.id);
    const pane = existing?.pane ?? owner;
    if (!pane || !panes.getById(pane)) return;
    if (
      result.state === 'pending' &&
      typeof result.expires === 'number' &&
      Number.isFinite(result.expires) &&
      result.expires > Date.now()
    ) {
      const expires = Math.min(
        result.expires,
        existing?.expires ?? Number.POSITIVE_INFINITY,
        Date.now() + 300_000,
      );
      if (existing || pending.size < 64) {
        saveNotice.run(result.id, expires, pane);
        pending.set(result.id, { expires, pane, stale: false });
      } else {
        const until = Math.max(overflow.get(pane) ?? 0, expires);
        saveNotice.run(`overflow:${pane}`, until, pane);
        overflow.set(pane, until);
      }
    } else if (
      ['verifying', 'executing', 'complete', 'rejected', 'failed', 'expired'].includes(
        String(result.state),
      )
    ) {
      forget(result.id);
    }
  };
  const safeTrack = (result: Record<string, unknown>, owner?: string) => {
    try {
      track(result, owner);
    } catch {
      const pane =
        (typeof result.id === 'string' ? pending.get(result.id)?.pane : undefined) ?? owner;
      if (pane)
        noticeUnavailable.set(
          pane,
          Math.max(
            noticeUnavailable.get(pane) ?? 0,
            Math.min(
              typeof result.expires === 'number' && Number.isFinite(result.expires)
                ? result.expires
                : Date.now() + 300_000,
              Date.now() + 300_000,
            ),
          ),
        );
    }
  };
  const brokerAction = async (
    action: string,
    payload: unknown,
    /** The authorized caller: the pane, and the host relaying for it. */
    caller: { pane: string; caller?: { nodeId: string; callId: string } } | string,
  ) => {
    const pane = typeof caller === 'string' ? caller : caller.pane;
    const relay = typeof caller === 'string' ? undefined : caller.caller;
    // ── THE CONNECTOR GATE ────────────────────────────────────────────────
    //
    // Here rather than in each route, for the reason the card below is here:
    // `post`/`dm`/`react`/`edit`/`unpost`/`upload` are six chances to forget.
    //
    // Two questions, both from server/src/connectors:
    //   · may a chat on THIS MACHINE use Slack at all, and was this chat told
    //     to by a chat on a machine that may not (scope.ts);
    //   · is this verb one muxpad can say anything about (registry.ts) —
    //     `calendar.invite` is the shape of verb that gets refused outright.
    //
    // While host scoping is switched off — which is how it ships, and how it
    // stays until the owner's chats have moved to the machines they belong on
    // — `mayPaneUse` allows everything and this costs one policy read. The
    // refusal path is therefore dormant rather than absent, which is the only
    // way to have it tested before the day it matters.
    // WHICH CONNECTOR, FROM THE ACTION ITSELF. `slack.post` is Slack's,
    // `msgvault.search` is the archive's, and the prefix is the only place
    // that answers it — so a verb cannot be checked against the wrong
    // connector's host policy, which is the mistake a second hardcoded
    // 'slack' here would eventually become.
    const connector = action.slice(0, action.indexOf('.'));
    const policy = (deps.policy ?? loadPolicy)();
    const scope = mayPaneUse(deps.db, connector, pane, policy, directingOrigin(deps.db, pane));
    if (!scope.ok) throw new SlackRefused(action, payload, pane, scope.reason ?? 'refused');
    const verb = classify(action);
    if (!verb.ok) throw new SlackRefused(action, payload, pane, verb.reason ?? 'refused');

    // ── CAN THIS PANE BE ASKED? ───────────────────────────────────────────
    //
    // The approval dialog is mounted by ChatPane and the broker's pending
    // list is scoped to the pane that asked. So a connector call from a
    // TERMINAL pane created a request nobody was ever shown: it sat for five
    // minutes and expired, and the caller saw a hang with no explanation.
    //
    // Refused HERE rather than in the CLI, and AFTER the policy gate above,
    // because those are the two halves of getting this right:
    //
    //   · after the gate, so a policy refusal still reaches a terminal — the
    //     whole point of "slack is scoped to trayo" is that you can run it
    //     anywhere and be told clearly;
    //   · before the broker request, because the broker has no cancel
    //     endpoint. A request made and then abandoned is exactly the silent
    //     expiry this is removing.
    //
    // THE COST, stated rather than hidden: a terminal pane also loses calls
    // that would have ridden an existing timed grant and needed no dialog at
    // all. muxpad cannot know which those are without asking the broker, and
    // a call that sometimes hangs is worse than one that always explains
    // itself.
    const asking = panes.getById(pane);
    if (asking && asking.face !== 'chat')
      throw new SlackRefused(
        action,
        payload,
        pane,
        `${connector} needs your approval, and approvals appear in a chat — this is a ${asking.face} pane, so the request would wait for a dialog nobody can see. Run it from a chat pane, or ask that chat to run it.`,
      );

    // ── WHICH MACHINE IS ASKING ──────────────────────────────────────────
    // `mayPaneUse` already resolved it from the pane's own row, and it was
    // being thrown away: every request reached the broker as `origin:
    // unknown`, which by the broker's own rule never matches a grant minted
    // for a named machine. So timed approvals could not be spent at all, and
    // the machine binding the owner asked for — "I think machine is good" —
    // was never actually on.
    //
    // The broker treats this as a LABEL muxpad asserts, not a fact it can
    // verify, which is exactly right: it is shown to the human before they
    // approve, and the grant is bound to it afterwards.
    /**
     * ── AND THE MACHINE PROVES IT ────────────────────────────────────────
     *
     * `origin` above is a LABEL this server asserts on the host's behalf, and
     * the broker has no way to check it — so a lasting permission bound to a
     * remote machine would have been spendable by anything on THIS one
     * willing to claim the name, and the broker rightly refused to offer one.
     *
     * So the host signs the action itself, with a key this machine does not
     * have. Asked for HERE, at the one funnel every connector verb goes
     * through, and only for a call a host is actually relaying: a local call
     * needs no proof, because believing "this came from here" adds nothing.
     *
     * A null proof is ORDINARY — no key over there, a dropped link, a slow
     * answer, or an action that does not match what the host's own caller
     * asked for. The request goes on without it and a human approves it once,
     * which is exactly where this stood before. A connector must not go off
     * the air because a key was rotated on one side.
     */
    const proof =
      relay && deps.signOrigin
        ? await deps.signOrigin(relay.nodeId, relay.callId, action, payload)
        : null;
    const result = await slackBrokerRequest(
      '/requests',
      { action, payload, origin: scope.origin, ...(proof ? { proof } : {}) },
      action === 'slack.upload' ? 125000 : 35000,
    );
    // The broker is the only thing that holds a credential for either of
    // them, so from here down nothing is Slack-specific: a request is
    // tracked for the approval dialog and recorded as a card the same way
    // whichever connector it names.
    safeTrack(result, pane);
    // ── AND A CARD IN THE CHAT THAT SENT IT ──────────────────────────────
    //
    // Recorded HERE, at the one funnel every Slack verb goes through, rather
    // than in each route: the per-route version is how one of them ends up
    // not doing it, and `post`/`dm`/`edit`/`upload` are four chances to
    // forget. The act's own id is what a later status poll resolves against.
    recordSlackAction(deps.db, { action, payload, pane, result });
    return result;
  };
  app.route(
    '/passkey',
    slackPasskeyRoutes({
      paneExists: (id) => !!panes.getById(id),
      owned: (pane) => {
        prune();
        return [...pending].filter(([, v]) => v.pane === pane).map(([id]) => id);
      },
      track: (r) => safeTrack(r),
    }),
  );
  let refreshing: Promise<void> | null = null;
  let nextRefresh = 0;
  let delay = 1500;
  let cursor = 0;
  app.get('/approvals', (c) => {
    c.header('Cache-Control', 'no-store');
    const pane = c.req.query('pane');
    if (!pane) return c.json(refusal('Approval status requires a caller pane'), 400);
    if (!panes.getById(pane)) return c.json(refusal('Unknown caller pane'), 404);
    prune();
    if (!refreshing && pending.size && Date.now() >= nextRefresh) {
      const ids = [...pending.keys()];
      const batch = Array.from(
        { length: Math.min(8, ids.length) },
        (_, i) => ids[(cursor + i) % ids.length],
      );
      cursor = (cursor + batch.length) % ids.length;
      let failed = false;
      let index = 0;
      const worker = async () => {
        while (index < batch.length) {
          const id = batch[index++];
          if (!id) break;
          try {
            const result = await slackBrokerRequest(`/requests/${id}`, undefined, 3000);
            if (result.id !== id) throw Error('Mismatched request status');
            safeTrack(result);
          } catch (error) {
            // A valid GET for a known UUID returns 400/404 when the broker no longer has it.
            const status = (error as { status?: number }).status;
            const notice = pending.get(id);
            if (notice) notice.stale = true;
            if (status === 400 || status === 404) {
              forget(id);
            } else {
              failed = true;
            }
          }
        }
      };
      // Two status calls at most; leave broker capacity for human decisions.
      refreshing = Promise.allSettled([worker(), worker()])
        .then((results) => {
          failed ||= results.some((result) => result.status === 'rejected');
          delay = failed ? Math.min(delay * 2, 30_000) : 1500;
        })
        .catch(() => {
          delay = Math.min(delay * 2, 30_000);
        })
        .finally(() => {
          nextRefresh = Date.now() + delay;
          refreshing = null;
        });
    }
    return c.json({
      pane,
      pending: [...pending.values()].filter((notice) => notice.pane === pane).length,
      incomplete: (overflow.get(pane) ?? 0) > Date.now(),
      stale:
        [...pending.values()].some((notice) => notice.pane === pane && notice.stale) ||
        (noticeUnavailable.get(pane) ?? 0) > Date.now(),
      approval_url: slackBrokerURL() ? `${slackBrokerURL()}/review` : null,
    });
  });

  app.get('/requests/:id', async (c) => {
    const auth = await authorize(c.req.query('pane'), c.req.query('key'), callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    const id = c.req.param('id');
    if (!/^[a-f0-9-]{36}$/.test(id) || !slackBrokerURL())
      return c.json(refusal('Unknown broker request'), 404);
    try {
      const result = await slackBrokerRequest(`/requests/${id}`);
      if (result.id !== id) throw Error('Mismatched request status');
      safeTrack(result);
      return c.json(result);
    } catch (error) {
      if ([400, 404].includes((error as { status?: number }).status ?? 0)) {
        forget(id);
        return c.json(refusal('Unknown broker request'), 404);
      }
      return c.json(refusal('Protected Slack broker unavailable'), 502);
    }
  });

  // ONE handler, because Hono keeps only the last one registered — a second
  // `onError` for the connector gate silently replaced this and every refusal
  // came back as 502.
  /**
   * ONE ERROR HANDLER, ON BOTH APPS.
   *
   * It used to be registered on the Slack app alone, which was the whole
   * surface at the time. Splitting the archive onto its own app left it with
   * NO handler, so a policy refusal — the one case this exists for — came
   * back as a bare 500 with no reason in it. Measured, not reasoned about:
   * the end-to-end policy test caught it on the first run.
   *
   * A second copy would be the same defect waiting to happen, so there is one
   * and both apps are given it.
   */
  const onError =
    (who: string) => (error: Error, c: Parameters<Parameters<Hono['onError']>[0]>[1]) => {
      // muxpad refused it before the broker saw it: a 403 with the reason, and a
      // declined card in the chat that asked.
      if (error instanceof SlackRefused) {
        recordSlackRefusal(deps.db, {
          action: error.action,
          payload: error.payload,
          pane: error.pane,
          why: error.why,
        });
        return c.json(refusal(error.why), 403);
      }
      // THE BROKER SAID WHY. A 4xx from it is a decision — a review verdict,
      // a validation failure — and its sentence is the only thing that tells
      // the caller how to fix the call. A 5xx is a fault, and keeps the
      // generic line rather than leaking internals.
      const reason = (error as { brokerReason?: string }).brokerReason;
      const status = (error as { status?: number }).status;
      if (reason && typeof status === 'number' && status >= 400 && status < 500)
        return c.json(refusal(reason), 400);
      // Names the capability that failed rather than always saying Slack.
      return c.json(
        refusal(
          `${who} request failed; protected broker mode never falls back to local credentials`,
        ),
        502,
      );
    };
  app.onError(onError('Slack'));

  app.post('/post', async (c) => {
    const body = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string().min(1),
        text: z.string().min(1),
        thread_ts: z.string().optional(),
      })
      .parse(await c.req.json());
    const auth = await authorize(body.pane, body.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.post',
        {
          ref: body.ref,
          text: body.text,
          ...(body.thread_ts ? { thread_ts: body.thread_ts } : {}),
        },
        auth.pane,
      ),
      202,
    );
  });

  app.post('/unpost', async (c) => {
    const body = z
      .object({
        pane: z.string(),
        key: z.string(),
        channel: z.string().min(1),
        ts: z.string().min(1),
      })
      .parse(await c.req.json());
    const auth = await authorize(body.pane, body.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction('slack.unpost', { ref: body.channel, ts: body.ts }, auth),
      202,
    );
  });

  app.get('/read', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.read',
        {
          ref: q.ref,
          limit: q.limit,
          ...(q.oldest ? { oldest: q.oldest } : {}),
        },
        auth.pane,
      ),
      202,
    );
  });

  app.get('/search', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('slack.search', { query: q.q, limit: q.limit }, auth), 202);
  });

  app.get('/channels', async (c) => {
    const auth = await authorize(c.req.query('pane'), c.req.query('key'), callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('slack.channels', {}, auth), 202);
  });

  app.get('/users', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('slack.users', { name: q.name }, auth), 202);
  });
  app.get('/thread', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.thread',
        { ref: q.ref, ts: q.ts, limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) },
        auth.pane,
      ),
      202,
    );
  });
  app.post('/dm', async (c) => {
    const b = z
      .object({ pane: z.string(), key: z.string(), user: z.string() })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('slack.dm', { user: b.user }, auth), 202);
  });
  app.post('/react', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string(),
        ts: z.string(),
        name: z.string(),
        operation: z.enum(['add', 'remove']),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.react',
        { ref: b.ref, ts: b.ts, name: b.name, operation: b.operation },
        auth.pane,
      ),
      202,
    );
  });
  app.post('/edit', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string(),
        ts: z.string(),
        text: z.string(),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction('slack.edit', { ref: b.ref, ts: b.ts, text: b.text }, auth),
      202,
    );
  });
  app.post('/upload', bodyLimit({ maxSize: 14 * 1024 * 1024 }), async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string(),
        filename: z.string().max(200),
        content: z.string().max(13981016),
        text: z.string().max(35000).optional(),
        thread_ts: z.string().optional(),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'slack.upload',
        {
          ref: b.ref,
          filename: b.filename,
          content: b.content,
          text: b.text,
          thread_ts: b.thread_ts,
        },
        auth.pane,
      ),
      202,
    );
  });

  app.get('/token', (c) =>
    c.json({
      set: false,
      hint: null,
      broker: true,
      configured: !!slackBrokerURL(),
      approval_url: slackBrokerURL() ? `${slackBrokerURL()}/review` : null,
    }),
  );
  app.on(['PUT', 'DELETE'], '/token', (c) =>
    c.json(refusal('Manage credentials directly in the protected broker'), 403),
  );
  /**
   * ── THE ARCHIVE, THROUGH THE SAME DOOR ───────────────────────────────────
   *
   * Mounted from inside this closure deliberately. Everything that makes an
   * approval real is here and nowhere else: the host-scoping gate, the
   * pending-notice table the inline dialog polls, the card recorded in the
   * chat that asked, and the one `onError` that turns a refusal into a 403.
   * A second route file would have been a second copy of all four, and the
   * owner's requirement was the opposite of that:
   *
   *   "I WANT ALL APPROVAL MECHANISM TO BE SINGULAR."
   *
   * So msgvault is a set of routes over the same funnel, not a second
   * mechanism that happens to look similar.
   *
   * NO PAYLOAD IS SHAPED HERE. Each route hands the query through and the
   * BROKER validates it and composes the command line (broker/msgvault.mjs).
   * Validating here as well would be a second opinion about what is legal,
   * and the one that matters is the one on the far side of the wall.
   */
  // FOUR VERBS. `list-senders`, `meetings` and `person` were advertised and
  // cannot work against msgvault 0.22.0 — `list-senders` is refused by
  // delegated mode, the other two are parent commands with no positional and
  // no --json. Verified against the real binary; see broker/msgvault.mjs.
  const archive = new Hono();
  const count = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const ARCHIVE_ROUTES: Array<[string, string, (q: Record<string, string>) => unknown]> = [
    ['/search', 'msgvault.search', (q) => ({ query: q.q, limit: count(q.limit) })],
    ['/message', 'msgvault.show-message', (q) => ({ id: q.id })],
    ['/thread', 'msgvault.show-thread', (q) => ({ id: q.id })],
    ['/attachment', 'msgvault.export-attachment', (q) => ({ hash: q.hash })],
    ['/stats', 'msgvault.stats', () => ({})],
  ];
  for (const [path, action, payload] of ARCHIVE_ROUTES)
    archive.get(path, async (c) => {
      const q = c.req.query();
      const auth = await authorize(q.pane, q.key, callerOf(c));
      if (!auth.ok) return c.json(auth.body, auth.status);
      return c.json(await brokerAction(action, payload(q), auth), 202);
    });
  /**
   * ── THE ONE WRITE ─────────────────────────────────────────────────────
   *
   * POST, not GET, and not in the table above: a draft carries a body that
   * does not belong in a URL, and the difference between a verb that reads
   * and one that writes into the owner's mailbox should be visible in this
   * file without reading a payload builder.
   *
   * There is no `/draft` to compose a new email. A Gmail source refuses
   * `draft-compose` with `draft_disabled` while `draft-reply` creates a real
   * draft in the thread, so composing was a route that could only 502 after
   * somebody had approved it. See broker/msgvault.mjs for the measurement.
   *
   * The shape is checked HERE as well as in the broker. The broker's check
   * is the one that matters — it is what stands between an agent and the
   * tool — and this one exists so a mistake gets a 400 with a sentence
   * instead of an approval dialog for a request that will fail after the
   * person approves it.
   */
  archive.post('/draft-reply', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        id: z.string().min(1).max(128),
        body: z.string().min(1).max(20000),
        /** Reply to everyone on the thread. Opt in — see the broker. */
        all: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'msgvault.draft-reply',
        { id: b.id, body: b.body, all: b.all === true },
        auth,
      ),
      202,
    );
  });

  /**
   * ── THE REST OF THE DRAFT LIFECYCLE ───────────────────────────────────
   *
   * Read, replace and delete a draft the agent (or the owner) already has.
   * POST for all three, like the reply above: these carry a draft id and, for
   * an edit, a body that has no business in a URL — and the difference
   * between a verb that reads your mail and one that changes something in
   * your mailbox should be visible in the method.
   *
   * `draft-get` is a READ of a draft and still sits here rather than in the
   * GET table, because what it reads is the write surface: the table above
   * is the archive, this is the mailbox.
   */
  for (const [path, action] of [
    ['/draft-get', 'msgvault.draft-get'],
    ['/draft-delete', 'msgvault.draft-delete'],
  ] as const) {
    archive.post(path, async (c) => {
      const b = z
        .object({ pane: z.string(), key: z.string(), id: z.string().min(1).max(128) })
        .parse(await c.req.json());
      const auth = await authorize(b.pane, b.key, callerOf(c));
      if (!auth.ok) return c.json(auth.body, auth.status);
      return c.json(await brokerAction(action, { id: b.id }, auth), 202);
    });
  }

  /**
   * A NEW email. See the broker for why this exists despite a Gmail source
   * having been measured refusing it: reply-only cannot serve the case
   * people actually hit, which is writing to somebody with no prior thread.
   */
  archive.post('/draft-compose', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        to: z.array(z.string().min(3).max(256)).min(1).max(20),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(20000),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(
      await brokerAction(
        'msgvault.draft-compose',
        { to: b.to, subject: b.subject, body: b.body },
        auth,
      ),
      202,
    );
  });

  /**
   * A CALENDAR EVENT. No guests and no reminders — the broker refuses both,
   * so this reaches nobody but the owner's own calendar.
   */
  /**
   * The calendar READS, and the two writes that fix an event afterwards.
   * POST for all of them: a calendar id, an account and a window do not
   * belong in a URL, and an id in a querystring ends up in logs.
   */
  for (const [path, action] of [
    ['/calendar-freebusy', 'msgvault.calendar-freebusy'],
    ['/calendar-conflicts', 'msgvault.calendar-conflicts'],
  ] as const) {
    archive.post(path, async (c) => {
      const b = z
        .object({
          pane: z.string(),
          key: z.string(),
          account: z.string().min(3).max(256),
          calendar: z.string().min(1).max(256).optional(),
          start: z.string().min(10).max(40),
          end: z.string().min(10).max(40),
          tz: z.string().min(1).max(64),
        })
        .parse(await c.req.json());
      const auth = await authorize(b.pane, b.key, callerOf(c));
      if (!auth.ok) return c.json(auth.body, auth.status);
      const { pane: _p, key: _k, ...window } = b;
      return c.json(await brokerAction(action, window, auth), 202);
    });
  }

  /**
   * THE ARGV PATH. muxpad adds no flags of its own here: the broker reviews
   * what the agent sent against msgvault's own `--help` and refuses the
   * shapes that change whose call it is, or who hears about it. See
   * broker/msgvault-argv.mjs.
   */
  archive.post('/run', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        args: z.array(z.string().max(20000)).min(1).max(60),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('msgvault.run', { args: b.args }, auth), 202);
  });

  archive.post('/calendar-update', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        account: z.string().min(3).max(256),
        calendar: z.string().min(1).max(256).optional(),
        event: z.string().min(1).max(256),
        summary: z.string().min(1).max(500).optional(),
        start: z.string().min(10).max(40).optional(),
        end: z.string().min(10).max(40).optional(),
        tz: z.string().min(1).max(64).optional(),
        location: z.string().max(500).optional(),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    const { pane: _p, key: _k, ...change } = b;
    return c.json(await brokerAction('msgvault.calendar-update', change, auth), 202);
  });

  archive.post('/calendar-delete', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        account: z.string().min(3).max(256),
        calendar: z.string().min(1).max(256).optional(),
        event: z.string().min(1).max(256),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    const { pane: _p, key: _k, ...target } = b;
    return c.json(await brokerAction('msgvault.calendar-delete', target, auth), 202);
  });

  archive.post('/calendar-create', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        account: z.string().min(3).max(256),
        calendar: z.string().min(1).max(256).optional(),
        summary: z.string().min(1).max(500),
        start: z.string().min(10).max(40),
        end: z.string().min(10).max(40),
        tz: z.string().min(1).max(64),
        location: z.string().max(500).optional(),
        description: z.string().max(5000).optional(),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    const { pane: _p, key: _k, ...event } = b;
    return c.json(await brokerAction('msgvault.calendar-create', event, auth), 202);
  });

  archive.post('/draft-edit', async (c) => {
    const b = z
      .object({
        pane: z.string(),
        key: z.string(),
        id: z.string().min(1).max(128),
        body: z.string().min(1).max(20000),
      })
      .parse(await c.req.json());
    const auth = await authorize(b.pane, b.key, callerOf(c));
    if (!auth.ok) return c.json(auth.body, auth.status);
    return c.json(await brokerAction('msgvault.draft-edit', { id: b.id, body: b.body }, auth), 202);
  });

  archive.onError(onError('msgvault'));
  return { slack: app, archive };
}

/**
 * Backwards-compatible shape: the Slack app alone.
 *
 * The archive's routes are built inside `connectorRoutes` so they share the
 * one funnel — the gate, the pending-notice table, the card, the single
 * onError. What they must NOT share is the URL: mounting them inside the
 * Slack app put them at `/api/slack/msgvault/...`, which says the archive is
 * part of Slack and was a 404 against the path the CLI actually calls.
 */
export function slackRoutes(deps: Deps): Hono {
  return connectorRoutes(deps).slack;
}
