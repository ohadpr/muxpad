import { createHash } from 'node:crypto';
const SAFE_ERRORS = new Set([
  'missing_scope',
  'invalid_auth',
  'token_revoked',
  'not_authed',
  'ratelimited',
  'channel_not_found',
  'not_in_channel',
  'invalid_arguments',
  'user_not_found',
  'cant_update_message',
  'message_not_found',
  'already_reacted',
  'no_reaction',
  'file_too_large',
]);
// Only errors created here can carry an allowlisted diagnostic into the broker.
// Never retain Slack body/message/scopes/headers or a fetch/JSON exception.
const safeFailures = new WeakMap();
function slackFailure(code) {
  const error = new Error('Slack request failed');
  if (typeof code === 'string' && SAFE_ERRORS.has(code)) safeFailures.set(error, code);
  return error;
}
export function safeSlackErrorCode(error) {
  return safeFailures.get(error);
}

export function slackClient(token, team, channels = []) {
  async function call(method, payload = {}) {
    let response;
    try {
      if (
        ['search.messages', 'users.list', 'users.info', 'conversations.replies'].includes(method)
      ) {
        const params = new URLSearchParams(
          Object.entries(payload).map(([key, value]) => [key, String(value)]),
        );
        if (method === 'search.messages') params.set('team_id', team);
        response = await fetch(`https://slack.com/api/${method}?${params}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
      } else {
        response = await fetch(`https://slack.com/api/${method}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
      }
    } catch {
      throw slackFailure();
    }
    // 429 may have a non-JSON body. Do not read it or Retry-After, and never retry.
    if (response.status === 429) throw slackFailure('ratelimited');
    let result;
    try {
      result = await response.json();
    } catch {
      throw slackFailure();
    }
    if (!response.ok || result?.ok !== true) throw slackFailure(result?.error);
    return result;
  }
  return {
    async verify() {
      const result = await call('auth.test');
      if (result.team_id !== team) throw new Error('Slack token belongs to a different team');
    },
    async run(action, p, upload) {
      if (action === 'slack.users') {
        let members = [];
        if (/^[UW][A-Z0-9]+$/.test(p.name)) {
          const r = await call('users.info', { user: p.name });
          if (r.user) members = [r.user];
        } else {
          let cursor = '';
          for (let page = 0; page < 5; page++) {
            const r = await call('users.list', {
              limit: 200,
              ...(cursor ? { cursor } : {}),
              team_id: team,
            });
            members.push(...(r.members || []));
            cursor = r.response_metadata?.next_cursor || '';
            if (!cursor) break;
          }
          if (cursor) throw slackFailure('invalid_arguments'); // Never choose from an incomplete directory.
        }
        const matches = members.filter(
          (u) => !u.deleted && !u.is_bot && (u.id === p.name || u.name === p.name),
        );
        if (matches.length !== 1 || !/^[UW][A-Z0-9]+$/.test(matches[0].id))
          throw slackFailure('user_not_found');
        const u = matches[0];
        return {
          user: {
            id: u.id,
            name: u.name,
            display_name: u.profile?.display_name || u.real_name || u.name,
          },
        };
      }
      if (action === 'slack.dm') {
        const r = await call('conversations.open', { users: p.user });
        if (!/^D[A-Z0-9]+$/.test(r.channel?.id)) throw slackFailure();
        return { channel: r.channel.id };
      }
      if (action === 'slack.thread') {
        const r = await call('conversations.replies', {
          channel: p.channel,
          ts: p.ts,
          limit: p.limit,
          ...(p.cursor ? { cursor: p.cursor } : {}),
        });
        return {
          messages: (r.messages || []).map((m) => ({
            ts: m.ts,
            who: m.user || m.bot_id || '?',
            text: m.text || '',
            thread_ts: m.thread_ts,
          })),
          has_more: !!r.has_more,
          next_cursor: r.response_metadata?.next_cursor || '',
        };
      }
      if (action === 'slack.react') {
        await call(p.operation === 'remove' ? 'reactions.remove' : 'reactions.add', {
          channel: p.channel,
          timestamp: p.ts,
          name: p.name,
        });
        return { ok: true };
      }
      if (action === 'slack.edit') {
        const r = await call('chat.update', { channel: p.channel, ts: p.ts, text: p.text });
        return { channel: r.channel, ts: r.ts };
      }
      if (action === 'slack.upload') {
        if (
          !Buffer.isBuffer(upload) ||
          upload.length !== p.bytes ||
          createHash('sha256').update(upload).digest('hex') !== p.sha256
        )
          throw slackFailure('invalid_arguments');
        const r = await call('files.getUploadURLExternal', {
          filename: p.filename,
          length: upload.length,
        });
        let url;
        try {
          url = new URL(r.upload_url);
        } catch {
          throw slackFailure();
        }
        if (
          url.protocol !== 'https:' ||
          url.hostname !== 'files.slack.com' ||
          url.port ||
          url.username ||
          url.password ||
          url.hash ||
          !url.pathname.startsWith('/upload/')
        )
          throw slackFailure();
        if (typeof r.file_id !== 'string' || !/^F[A-Z0-9]+$/.test(r.file_id)) throw slackFailure();
        let sent;
        try {
          sent = await fetch(url.href, {
            method: 'POST',
            body: upload,
            headers: { 'content-type': 'application/octet-stream' },
            redirect: 'error',
            signal: AbortSignal.timeout(60000),
          });
        } catch {
          throw slackFailure();
        }
        if (!sent.ok || sent.status !== 200) throw slackFailure();
        await call('files.completeUploadExternal', {
          files: [{ id: r.file_id, title: p.filename }],
          channel_id: p.channel,
          ...(p.text ? { initial_comment: p.text } : {}),
          ...(p.thread_ts ? { thread_ts: p.thread_ts } : {}),
        });
        return { file: r.file_id, channel: p.channel };
      }
      if (action === 'slack.post') {
        const r = await call('chat.postMessage', {
          channel: p.channel,
          text: p.text,
          unfurl_links: false,
          unfurl_media: false,
          ...(p.thread_ts ? { thread_ts: p.thread_ts } : {}),
        });
        return { channel: r.channel, ts: r.ts };
      }
      if (action === 'slack.unpost') {
        await call('chat.delete', { channel: p.channel, ts: p.ts });
        return { ok: true };
      }
      if (action === 'slack.read') {
        const r = await call('conversations.history', p);
        return {
          messages: (r.messages || [])
            .reverse()
            .map((m) => ({ ts: m.ts, who: m.user || m.bot_id || '?', text: m.text || '' })),
        };
      }
      if (action === 'slack.search') {
        if (
          typeof p.query !== 'string' ||
          !p.query.trim() ||
          !Number.isInteger(p.limit) ||
          p.limit < 1 ||
          p.limit > 100 ||
          typeof team !== 'string' ||
          !team
        )
          throw slackFailure('invalid_arguments');
        const r = await call('search.messages', { query: p.query, count: p.limit });
        return {
          messages: (r.messages?.matches || []).map((m) => ({
            ts: m.ts,
            who: m.user || m.username || '?',
            text: m.text || '',
            channel: m.channel?.name || '',
          })),
        };
      }
      if (action === 'slack.channels') {
        const r = await call('conversations.list', {
          limit: 1000,
          types: 'public_channel,private_channel',
        });
        return {
          channels: (r.channels || [])
            .filter((c) => !c.is_archived && (!channels.length || channels.includes(c.id)))
            .map((c) => ({ id: c.id, name: c.name, private: !!c.is_private })),
        };
      }
      throw new Error('Unsupported action');
    },
  };
}
