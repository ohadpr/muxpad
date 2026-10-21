import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { checkOrigin, parseAllowedOrigins } from '../same-origin.js';

const count = z.number().int().min(0).max(64);
const rect = z
  .object({
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
    w: z.number().finite().min(0).max(100000),
    h: z.number().finite().min(0).max(100000),
  })
  .strict()
  .nullable();
const poll = z
  .object({
    state: z.enum(['absent', 'never', 'in-flight', 'failed', 'success']),
    http: z.number().int().min(0).max(599).nullable(),
    pending: count.nullable(),
    stale: z.boolean().nullable(),
    ageMs: z.number().int().min(0).max(600000).nullable(),
  })
  .strict();
const sample = z
  .object({
    build: z.string().regex(/^(?:index-[A-Za-z0-9_-]{1,80}\.js|dev|unknown)$/),
    visibility: z.enum(['visible', 'hidden', 'prerender']),
    viewportW: z.number().int().min(0).max(100000),
    viewportH: z.number().int().min(0).max(100000),
    shells: count,
    shellActive: z.boolean().nullable(),
    face: z.enum(['chat', 'web', 'terminal']).nullable(),
    chats: count,
    chatActive: z.boolean().nullable(),
    hasSession: z.boolean().nullable(),
    alerts: count,
    shellRect: rect,
    chatRect: rect,
    visualViewport: rect,
    alertRect: rect,
    composerRect: rect,
    ancestorHidden: z.boolean(),
    ancestorDisplayNone: z.boolean(),
    ancestorVisibilityHidden: z.boolean(),
    alertInViewport: z.boolean(),
    alertHitTest: z.boolean().nullable(),
    poll,
    server: z
      .object({
        state: z.enum(['success', 'failed', 'mismatch']),
        http: z.number().int().min(0).max(599),
        pending: count.nullable(),
      })
      .strict(),
  })
  .strict();
const report = z
  .object({
    nonce: z.string().uuid(),
    pane: z.string().min(1).max(64),
    client: z.string().uuid(),
    sample,
  })
  .strict();

/** Temporary, untrusted UI evidence only. Never used for approval or persisted. */
export function slackNoticeDiagnosticRoutes(paneExists: (id: string) => boolean, now = Date.now) {
  const app = new Hono();
  const allowedOrigins = parseAllowedOrigins(process.env.MUXPAD_ALLOWED_ORIGINS);
  let armed: {
    nonce: string;
    pane: string;
    expires: number;
    clients: Map<
      string,
      {
        last: number;
        reports: Array<{ received: number; sample: z.infer<typeof sample> }>;
      }
    >;
  } | null = null;
  const current = () => {
    if (armed && (armed.expires <= now() || !paneExists(armed.pane))) armed = null;
    return armed;
  };
  let inFlight = 0;
  let rateStart = now();
  let rateCount = 0;
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const origin = c.req.header('origin');
    if (
      !checkOrigin(
        {
          origin,
          host: c.req.header('host') ?? new URL(c.req.url).host,
          secFetchSite: c.req.header('sec-fetch-site'),
        },
        allowedOrigins,
      ).ok
    )
      return c.json({ error: 'origin' }, 403);
    if (
      c.req.method === 'POST' &&
      (!origin || c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json')
    )
      return c.json({ error: 'origin or type' }, 403);
    if (c.req.method !== 'POST') {
      await next();
      return;
    }
    if (now() - rateStart >= 60000) {
      rateStart = now();
      rateCount = 0;
    }
    if (++rateCount > 120 || inFlight >= 4) return c.json({ error: 'capacity' }, 429);
    inFlight++;
    try {
      await next();
    } finally {
      inFlight--;
    }
  });
  // Bound bytes before JSON parsing, including chunked bodies without Content-Length.
  const body = async (req: Request) => {
    const reader = req.body?.getReader();
    if (!reader) throw Error('body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timeout: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(Error('deadline')), 1000);
    });
    try {
      while (true) {
        const v = await Promise.race([reader.read(), expired]);
        if (v.done) break;
        size += v.value.byteLength;
        if (size > 4096) throw Error('size');
        chunks.push(v.value);
      }
    } finally {
      clearTimeout(timeout!);
      void reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  };
  app.get('/', (c) => {
    const a = current();
    return c.json(
      a
        ? {
            enabled: true,
            nonce: a.nonce,
            pane: a.pane,
            remainingMs: a.expires - now(),
          }
        : { enabled: false },
    );
  });
  app.get('/results', (c) => {
    const a = current();
    return c.json(
      a
        ? {
            enabled: true,
            pane: a.pane,
            expires: a.expires,
            clients: [...a.clients].map(([client, v]) => ({
              client,
              reports: v.reports,
            })),
          }
        : { enabled: false },
    );
  });
  app.post('/arm', async (c) => {
    let input: { pane: string };
    try {
      input = z
        .object({ pane: z.string().min(1).max(64) })
        .strict()
        .parse(await body(c.req.raw));
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }
    if (!paneExists(input.pane)) return c.json({ error: 'unknown pane' }, 404);
    armed = {
      nonce: randomUUID(),
      pane: input.pane,
      expires: now() + 300000,
      clients: new Map(),
    };
    return c.json({ enabled: true, pane: armed.pane, nonce: armed.nonce, expires: armed.expires });
  });
  app.post('/disarm', async (c) => {
    try {
      z.object({})
        .strict()
        .parse(await body(c.req.raw));
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }
    armed = null;
    return c.json({ enabled: false });
  });
  app.post('/report', async (c) => {
    let input: z.infer<typeof report>;
    try {
      input = report.parse(await body(c.req.raw));
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }
    const a = current();
    if (!a || input.nonce !== a.nonce || input.pane !== a.pane)
      return c.json({ error: 'inactive' }, 409);
    let client = a.clients.get(input.client);
    if (!client) {
      if (a.clients.size >= 4) return c.json({ error: 'capacity' }, 429);
      client = { last: Number.NEGATIVE_INFINITY, reports: [] };
      a.clients.set(input.client, client);
    }
    if (now() - client.last < 2000 || client.reports.length >= 20)
      return c.json({ error: 'capacity' }, 429);
    client.last = now();
    client.reports.push({ received: now(), sample: input.sample });
    return c.json({ accepted: true });
  });
  return app;
}
