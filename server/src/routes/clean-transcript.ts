import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import {
  CleanupError,
  type CleanupModel,
  agentSdkModel,
  cleanTranscript,
} from '../chat/clean-transcript.js';
import { glossaryCache } from '../chat/glossary.js';

/**
 * `POST /api/clean-transcript { text } → { text, changed }`
 *
 * One job: hand back the dictated message with its mis-transcribed domain words
 * repaired. It does not send anything, touch a pane, or persist anything — the
 * client puts the result in the composer and the human decides.
 *
 * The glossary is rebuilt from this install's live names (see chat/glossary.ts)
 * behind a short time cache, so the endpoint costs one bounded set of SELECTs
 * per minute rather than per request.
 *
 * Failure is always visible: 400 on empty text, 413 on oversized, 502 when the
 * model can't be reached or answers with something that isn't a correction.
 * There is no path where this returns the input and calls it a success — a user
 * who believes cleanup ran and found nothing wrong is worse off than one who
 * knows it didn't run.
 */
export function cleanTranscriptRoutes(deps: {
  db: Database.Database;
  dataDir: string;
  /** Test seam — defaults to the Agent SDK Haiku completion. */
  model?: CleanupModel;
  /** Test seam — glossary cache TTL. */
  glossaryTtlMs?: number;
}): Hono {
  const app = new Hono();
  const model = deps.model ?? agentSdkModel;
  const glossary = glossaryCache(deps.db, deps.dataDir, {
    ...(deps.glossaryTtlMs !== undefined ? { ttlMs: deps.glossaryTtlMs } : {}),
  });

  app.post('/', async (c) => {
    let body: { text?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown };
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'expected a JSON body' } }, 400);
    }
    try {
      const text = await cleanTranscript({ text: body.text, glossary: glossary(), model });
      // `changed` saves the client a comparison and, more importantly, lets the
      // UI say "nothing to fix" instead of silently doing nothing on a tap.
      return c.json({ text, changed: text !== body.text });
    } catch (err) {
      const envelope =
        err instanceof CleanupError
          ? { code: err.code, message: err.message }
          : { code: 'unavailable' as const, message: 'cleanup failed' };
      if (envelope.code === 'bad_request') return c.json({ error: envelope }, 400);
      if (envelope.code === 'too_large') return c.json({ error: envelope }, 413);
      return c.json({ error: envelope }, 502);
    }
  });

  return app;
}
