import { readFileSync } from 'node:fs';
import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { findTranscript, identityNormalize, muxpadLocate } from '../chat/TranscriptReader.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';

/**
 * Summarize an agent pane's conversation down to its DELIVERABLE, for the
 * document surface's collapse-to-summary. This is the whole product bet: a
 * collapsed agent block should show WHAT you got, not the pages of work it took
 * — chat buries the payload, this surfaces it.
 *
 * Reads the pane's transcript by its session id, distills user+assistant text,
 * pulls out any attachment filenames (artifacts), and runs a single cheap-model
 * (haiku) completion for the summary. Deliberately best-effort: every failure
 * path returns an empty summary so the client falls back to a raw snippet
 * rather than erroring — a missing summary must never break the document.
 */
export function summaryRoutes(deps: { db: Database.Database }): Hono {
  const app = new Hono();
  const sessions = new AgentSessionStore(deps.db);

  app.post('/:id/summarize', async (c) => {
    const paneId = c.req.param('id');
    const sess = sessions.getByPane(paneId);
    const sid = sess?.current_sid;
    if (!sid) return c.json({ summary: '', title: '', artifacts: [] });

    // Claude writes ~/.claude/projects/**/<sid>.jsonl; codex/cursor write the
    // muxpad-normalized log. Try the backend's native locator, fall back to ours.
    const path = (sess.assistant === 'claude' ? findTranscript(sid) : null) ?? muxpadLocate(sid);
    if (!path) return c.json({ summary: '', title: '', artifacts: [] });

    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return c.json({ summary: '', title: '', artifacts: [] });
    }

    const normalize = sess.assistant === 'claude' ? normalizeTranscriptLine : identityNormalize;
    // Only the tail matters for a deliverable summary, and it bounds the model
    // input regardless of how huge the transcript grew.
    const lines = raw.split('\n').slice(-600);
    const turns: string[] = [];
    const artifacts = new Set<string>();
    let firstUser = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      for (const ev of normalize(obj) as ChatEvent[]) {
        if ((ev.kind !== 'user' && ev.kind !== 'assistant') || !ev.text) continue;
        if (ev.kind === 'user' && !firstUser) firstUser = ev.text;
        turns.push(`${ev.kind}: ${ev.text}`);
        for (const m of ev.text.matchAll(/\/attachments\/([\w.-]+\.[\w]+)/g)) {
          if (m[1]) artifacts.add(m[1]);
        }
      }
    }

    const title = firstUser.replace(/\s+/g, ' ').trim().slice(0, 80);
    const convo = turns.join('\n').slice(-6000);
    if (!convo) return c.json({ summary: '', title, artifacts: [...artifacts] });

    // Cheap one-shot completion — same bare-completion shape the runner uses for
    // self-titling (haiku, no tools, no settings). Dynamic-import so the SDK
    // isn't loaded at server boot for installs that never summarize.
    let summary = '';
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const prompt = `Below is a conversation between a user and an AI assistant. In 1–2 sentences, state the DELIVERABLE — what was answered or produced — not the process it took. Be terse and concrete. If files/artifacts were produced, mention them. Reply with ONLY the summary, no preamble.\n\n${convo}`;
      const one = query({
        prompt,
        options: {
          model: 'haiku',
          maxTurns: 1,
          settingSources: [],
          allowedTools: [],
          abortController: abort,
        },
      });
      for await (const m of one) {
        if (m.type === 'result' && m.subtype === 'success') summary = m.result;
      }
    } catch {
      // best-effort — empty summary, client falls back to a raw snippet
    } finally {
      clearTimeout(timeout);
    }

    return c.json({ summary: summary.trim(), title, artifacts: [...artifacts] });
  });

  return app;
}
