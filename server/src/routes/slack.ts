import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { z } from 'zod';
import { verifyPaneKey } from '../pane-key.js';
import * as slack from '../slack-api.js';
import { SlackError } from '../slack-api.js';
import {
  SecretsModeError,
  clearSlackToken,
  setSlackToken,
  slackToken,
  slackTokenHint,
} from '../slack-secrets.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';

/**
 * EVERY SLACK CALL, AND THE ONE PLACE THAT DECIDES WHETHER IT HAPPENS.
 *
 * The CLI used to hold the token and check the capability itself. Both halves
 * were wrong:
 *
 *   · it SOURCED `~/.claude/secrets/slack.env`, so a chat that was refused
 *     could read the token out of the file and curl Slack directly, and a chat
 *     that was allowed left the token in its pane's environment;
 *   · it identified itself with `$MUXPAD_PANE_ID`, a variable the caller sets.
 *     `MUXPAD_PANE_ID=<a Trayo pane> muxpad slack post …` walked through.
 *
 * So the token lives here and never leaves, and the caller proves which pane
 * it is with a key the server minted for that pane and handed over at spawn
 * (see pane-key.ts). It cannot name a pane it is not in.
 *
 * READ IS GATED LIKE POST. The first version gated only sending, reasoning
 * that the risk is data going out — but a personal chat could run
 * `slack channels` and list every private channel in the company. A workspace
 * either touches the work surface or it does not.
 */

interface Deps {
  db: Database.Database;
  dataDir: string;
}

/** What a refused call is told, and what it is NOT told. */
function refusal(why: string, detail?: string) {
  return { error: { code: 'slack_refused', message: why, detail } } as const;
}

export function slackRoutes(deps: Deps): Hono {
  const app = new Hono();
  const workspaces = new WorkspaceStore(deps.db);
  const tabs = new TabStore(deps.db);
  const panes = new PaneStore(deps.db);

  /**
   * Resolve the CALLER — not the caller's claim about itself — and check the
   * capability. Returns the token only when every step says yes.
   *
   * Fails closed at each step on purpose: an unidentifiable caller, a pane with
   * no tab, a tab with no workspace and a workspace with the switch off are all
   * cases where nobody has said this may happen.
   */
  async function authorize(
    paneId: unknown,
    paneKey: unknown,
  ): Promise<
    { ok: true; token: string } | { ok: false; status: 403 | 400; body: ReturnType<typeof refusal> }
  > {
    if (typeof paneId !== 'string' || !paneId)
      return {
        ok: false,
        status: 400,
        body: refusal('no caller pane — this works only from inside a muxpad pane'),
      };

    // THE KEY, NOT THE CLAIM. `$MUXPAD_PANE_ID` is a value the caller sets;
    // the key beside it is one the server minted for that pane and handed
    // over at spawn, so naming somebody else's pane does not survive here.
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

    if (!ws.slack)
      return {
        ok: false,
        status: 403,
        body: refusal(
          `the "${ws.name}" workspace does not have Slack enabled`,
          'This fails closed on purpose: a workspace holding personal chats must never reach a work surface. Turn it on, if it belongs on, in the muxpad UI — the workspace row’s settings button. It cannot be enabled from the CLI, because the CLI is what agents drive.',
        ),
      };

    let token: string | null;
    try {
      token = slackToken(deps.dataDir);
    } catch (e) {
      if (e instanceof SecretsModeError)
        return { ok: false, status: 403, body: refusal(e.message) };
      throw e;
    }
    if (!token)
      return {
        ok: false,
        status: 403,
        body: refusal('no Slack token is set', 'Add one in the workspace settings panel.'),
      };
    return { ok: true, token };
  }

  /** Slack’s own failures are the caller’s to read — they name a scope or a
   *  channel and are actionable. 502, because the refusal above is 403 and the
   *  two must not be confused by anything reading status codes. */
  const relay = async <T>(work: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await work() };
    } catch (e) {
      if (e instanceof SlackError)
        return { ok: false as const, body: { error: { code: 'slack_api', message: e.message } } };
      throw e;
    }
  };

  app.post('/post', async (c) => {
    const body = z
      .object({
        pane: z.string(),
        key: z.string(),
        ref: z.string().min(1),
        text: z.string().min(1),
      })
      .parse(await c.req.json());
    const auth = await authorize(body.pane, body.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    const r = await relay(() => slack.post(auth.token, body.ref, body.text));
    return r.ok ? c.json(r.value) : c.json(r.body, 502);
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
    const auth = await authorize(body.pane, body.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    const r = await relay(() => slack.unpost(auth.token, body.channel, body.ts));
    return r.ok ? c.json({ ok: true }) : c.json(r.body, 502);
  });

  app.get('/read', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    const r = await relay(() =>
      slack.read(auth.token, q.ref ?? '', {
        ...(q.limit ? { limit: Number(q.limit) } : {}),
        ...(q.oldest ? { oldest: Number(q.oldest) } : {}),
      }),
    );
    return r.ok ? c.json({ messages: r.value }) : c.json(r.body, 502);
  });

  app.get('/search', async (c) => {
    const q = c.req.query();
    const auth = await authorize(q.pane, q.key);
    if (!auth.ok) return c.json(auth.body, auth.status);
    const r = await relay(() =>
      slack.search(auth.token, q.q ?? '', q.limit ? Number(q.limit) : 20),
    );
    return r.ok ? c.json({ messages: r.value }) : c.json(r.body, 502);
  });

  app.get('/channels', async (c) => {
    const auth = await authorize(c.req.query('pane'), c.req.query('key'));
    if (!auth.ok) return c.json(auth.body, auth.status);
    const r = await relay(() => slack.channels(auth.token));
    return r.ok ? c.json({ channels: r.value }) : c.json(r.body, 502);
  });

  /**
   * THE TOKEN ITSELF — UI ONLY, AND WRITE ONLY.
   *
   * Same `Origin` rule as the capability switch, for the same reason: the CLI
   * is what agents drive, and an agent that can set the credential can set it
   * to one it controls, or read the one that is there by replacing it. GET
   * answers whether there is one and four characters of its tail — enough to
   * tell two tokens apart, not enough to use.
   */
  const uiOnly = (c: { req: { header: (n: string) => string | undefined } }) =>
    !c.req.header('Origin');

  app.get('/token', (c) => {
    if (uiOnly(c)) return c.json({ error: { code: 'ui_only', message: 'UI only' } }, 403);
    try {
      const hint = slackTokenHint(deps.dataDir);
      return c.json({ set: hint !== null, hint });
    } catch (e) {
      if (e instanceof SecretsModeError)
        return c.json({ set: false, hint: null, problem: e.message });
      throw e;
    }
  });

  app.put('/token', async (c) => {
    if (uiOnly(c))
      return c.json(
        {
          error: {
            code: 'ui_only',
            message:
              'the Slack token can only be set from the muxpad UI, not from the CLI — an agent must not be able to install a credential',
          },
        },
        403,
      );
    const body = z.object({ token: z.string().min(1) }).parse(await c.req.json());
    const token = body.token.trim();
    // The app-level token is the trap: it sits next to the OAuth ones on the
    // Slack app page and is useless for every Web API call there is, and
    // Slack's own error for it names the method rather than the mistake.
    if (token.startsWith('xapp-'))
      return c.json(
        {
          error: {
            code: 'wrong_token',
            message:
              'that is an app-level token (xapp-…), which is for Socket Mode and cannot make Web API calls. Take the "User OAuth Token" (xoxp-…) from OAuth & Permissions.',
          },
        },
        400,
      );
    if (!token.startsWith('xoxp-'))
      return c.json(
        {
          error: {
            code: 'wrong_token',
            message:
              'a user token (xoxp-…) is the only kind muxpad uses — every message goes out as you, so there is no bot identity to configure.',
          },
        },
        400,
      );
    setSlackToken(deps.dataDir, token);
    return c.json({ set: true, hint: slackTokenHint(deps.dataDir) });
  });

  app.delete('/token', (c) => {
    if (uiOnly(c)) return c.json({ error: { code: 'ui_only', message: 'UI only' } }, 403);
    clearSlackToken(deps.dataDir);
    return c.json({ set: false, hint: null });
  });

  return app;
}
