/**
 * The Slack Web API calls, moved off the CLI and into the one process that
 * holds the token.
 *
 * Nothing here decides WHETHER a call is allowed — that is routes/slack.ts,
 * which resolves the caller's pane to a workspace and checks the capability
 * before any of this runs. This file is the wire, deliberately dull.
 *
 * ONE IDENTITY, and it is the user's. There is no bot token and no parameter
 * to ask for one: a bot DM lands in the recipient's separate conversation with
 * "muxpad", which the sender cannot see and, if the timestamp is lost, cannot
 * delete. That is not a default anybody should be able to fall back to by
 * accident, so the capability does not exist in the code.
 */

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly slackCode: string,
  ) {
    super(`${method} → ${slackCode}${hint(slackCode)}`);
  }
}

function hint(code: string): string {
  if (code === 'missing_scope' || code === 'not_allowed_token_type')
    return ' — the token lacks the scope for this call';
  if (code === 'channel_not_found')
    return ' — no conversation by that name is visible to this token';
  if (code === 'invalid_auth' || code === 'token_revoked')
    return ' — the stored token is no longer valid; set a new one in workspace settings';
  return '';
}

async function call(
  method: string,
  token: string,
  fields: Record<string, string | number>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) throw new SlackError(method, String(json.error ?? 'unknown'));
  return json;
}

/**
 * `#channel` / `@user` / a raw id → a conversation id.
 *
 * The SAME token resolves the conversation and then uses it, which is not a
 * detail: a previous version defaulted the lookup to one token and the post to
 * another, and reported `channel_not_found` on a channel that plainly existed —
 * because it existed for the other identity. One token in, one token through.
 */
export async function resolveChannel(token: string, ref: string): Promise<string> {
  if (/^[CDG][A-Z0-9]+$/.test(ref)) return ref;
  if (ref.startsWith('@')) {
    const name = ref.slice(1);
    const users = (await call('users.list', token, { limit: 1000 })) as {
      members?: Array<{
        id: string;
        name?: string;
        real_name?: string;
        profile?: { display_name?: string };
      }>;
    };
    const u = users.members?.find(
      (m) => m.name === name || m.profile?.display_name === name || m.real_name === name,
    );
    if (!u) throw new SlackError('users.list', `no user '@${name}'`);
    const opened = (await call('conversations.open', token, { users: u.id })) as {
      channel?: { id: string };
    };
    if (!opened.channel?.id) throw new SlackError('conversations.open', 'no channel');
    return opened.channel.id;
  }
  const name = ref.replace(/^#/, '');
  const list = (await call('conversations.list', token, {
    limit: 1000,
    types: 'public_channel,private_channel',
  })) as { channels?: Array<{ id: string; name: string }> };
  const c = list.channels?.find((x) => x.name === name);
  if (!c) throw new SlackError('conversations.list', `no channel '#${name}'`);
  return c.id;
}

/**
 * Post, as the user, prefixed 🤖.
 *
 * The prefix is added HERE rather than asked of the caller, because a rule
 * every caller has to remember is a rule that gets forgotten — and the one
 * thing a reader is owed is that a machine composed this, even though the
 * person's name is on it. Already-prefixed text is left alone so a relayed
 * message is not 🤖 🤖.
 */
export async function post(
  token: string,
  ref: string,
  text: string,
): Promise<{ channel: string; ts: string }> {
  const channel = await resolveChannel(token, ref);
  const body = text.startsWith('🤖') ? text : `🤖 ${text}`;
  const r = (await call('chat.postMessage', token, { channel, text: body })) as { ts?: string };
  return { channel, ts: String(r.ts ?? '') };
}

export async function unpost(token: string, channel: string, ts: string): Promise<void> {
  await call('chat.delete', token, { channel, ts });
}

export interface Message {
  ts: string;
  who: string;
  text: string;
  channel?: string;
}

export async function read(
  token: string,
  ref: string,
  opts: { limit?: number; oldest?: number } = {},
): Promise<Message[]> {
  const channel = await resolveChannel(token, ref);
  const fields: Record<string, string | number> = { channel, limit: opts.limit ?? 50 };
  if (opts.oldest) fields.oldest = opts.oldest;
  const r = (await call('conversations.history', token, fields)) as {
    messages?: Array<{ ts: string; user?: string; bot_id?: string; text?: string }>;
  };
  // Oldest first, which is reading order; Slack answers newest first.
  return (r.messages ?? [])
    .slice()
    .reverse()
    .map((m) => ({ ts: m.ts, who: m.user ?? m.bot_id ?? '?', text: m.text ?? '' }));
}

export async function search(token: string, query: string, limit = 20): Promise<Message[]> {
  const r = (await call('search.messages', token, { query, count: limit })) as {
    messages?: {
      matches?: Array<{
        ts: string;
        username?: string;
        user?: string;
        text?: string;
        channel?: { name?: string };
      }>;
    };
  };
  return (r.messages?.matches ?? []).map((m) => ({
    ts: m.ts,
    who: m.username ?? m.user ?? '?',
    text: m.text ?? '',
    channel: m.channel?.name ?? '',
  }));
}

export interface Channel {
  id: string;
  name: string;
  private: boolean;
}

export async function channels(token: string): Promise<Channel[]> {
  const r = (await call('conversations.list', token, {
    limit: 1000,
    types: 'public_channel,private_channel',
  })) as {
    channels?: Array<{ id: string; name: string; is_private?: boolean; is_archived?: boolean }>;
  };
  return (r.channels ?? [])
    .filter((c) => !c.is_archived)
    .map((c) => ({ id: c.id, name: c.name, private: !!c.is_private }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
