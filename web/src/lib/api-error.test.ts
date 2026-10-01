// The API's error envelope must reach the user as a sentence, not as JSON.
// Regression: a refused conversion rendered literally as
//   409 {"error":{"code":"conflict","message":"…"}}
// inside the chat's empty state.
import { describe, expect, it } from 'vitest';
import { ApiError, req } from '../api';

function stubFetch(status: number, body: string, contentType = 'application/json') {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { 'content-type': contentType } })) as typeof fetch;
}

describe('req() error surfacing', () => {
  it('unwraps {error:{message}} to the bare human sentence', async () => {
    stubFetch(
      409,
      JSON.stringify({
        error: {
          code: 'conflict',
          message: 'this chat already has messages — open a new tab instead',
        },
      }),
    );
    await expect(req('/api/x')).rejects.toThrow(
      'this chat already has messages — open a new tab instead',
    );
  });

  it('never leaks the JSON envelope or the bare status into the message', async () => {
    stubFetch(409, JSON.stringify({ error: { code: 'conflict', message: 'nope' } }));
    const err = (await req('/api/x').catch((e) => e)) as Error;
    expect(err.message).toBe('nope');
    expect(err.message).not.toContain('{');
    expect(err.message).not.toContain('409');
  });

  it('carries the envelope’s CODE, so 409s that mean different things can be told apart', async () => {
    stubFetch(
      409,
      JSON.stringify({ error: { code: 'has_messages', message: 'already has messages' } }),
    );
    const err = (await req('/api/x').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect({ status: err.status, code: err.code }).toEqual({ status: 409, code: 'has_messages' });
  });

  it('a code-less envelope yields null rather than an invented code', async () => {
    stubFetch(500, JSON.stringify({ error: { message: 'boom' } }));
    expect(((await req('/api/x').catch((e) => e)) as ApiError).code).toBeNull();
  });

  it('falls back to status + body for a non-envelope error (proxy, HTML page)', async () => {
    stubFetch(502, '<html>Bad Gateway</html>', 'text/html');
    await expect(req('/api/x')).rejects.toThrow(/502/);
  });

  it('an empty body still yields something sayable', async () => {
    stubFetch(500, '');
    await expect(req('/api/x')).rejects.toThrow('request failed (500)');
  });

  it('an envelope with a blank message falls back rather than throwing empty', async () => {
    stubFetch(400, JSON.stringify({ error: { code: 'bad_request', message: '   ' } }));
    const err = (await req('/api/x').catch((e) => e)) as Error;
    expect(err.message.trim().length).toBeGreaterThan(0);
  });
});
