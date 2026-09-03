import { readFileSync } from 'node:fs';
import { type ChatEvent, normalizeTranscriptLine } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { findTranscript, identityNormalize, muxpadLocate } from './TranscriptReader.js';

export interface PaneSummary {
  /** 1–2 sentences on the DELIVERABLE, or '' when it couldn't be produced. */
  summary: string;
  /** The conversation's opening ask, trimmed — a cheap fallback label. */
  title: string;
  /** Artifact filenames spotted in the transcript. */
  artifacts: string[];
}

/**
 * Summarize an agent pane's conversation down to its DELIVERABLE.
 *
 * Two callers, deliberately: `POST /api/panes/:id/summarize` (the document
 * surface's collapse-to-summary) and the cron scheduler's `on_context=rotate`
 * handoff. The second is why this moved out of the route — a rotation that
 * spawned a clean-context agent knowing nothing about the 40-day conversation
 * it just left would produce confidently amnesiac output, which is worse than
 * no output at all.
 *
 * Best-effort by contract: EVERY failure path returns an empty summary rather
 * than throwing. Callers decide what an empty one means — the document falls
 * back to a raw snippet; the scheduler refuses to rotate.
 */
export async function summarizePane(db: Database.Database, paneId: string): Promise<PaneSummary> {
  const empty: PaneSummary = { summary: '', title: '', artifacts: [] };
  const sessions = new AgentSessionStore(db);
  const sess = sessions.getByPane(paneId);
  const sid = sess?.current_sid;
  if (!sid) return empty;

  // Claude writes ~/.claude/projects/**/<sid>.jsonl; codex/cursor write the
  // muxpad-normalized log. Try the backend's native locator, fall back to ours.
  const path = (sess.assistant === 'claude' ? findTranscript(sid) : null) ?? muxpadLocate(sid);
  if (!path) return empty;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return empty;
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
  if (!convo) return { summary: '', title, artifacts: [...artifacts] };

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
    // best-effort — empty summary; the caller decides what that means
  } finally {
    clearTimeout(timeout);
  }

  return { summary: summary.trim(), title, artifacts: [...artifacts] };
}

/**
 * A handoff briefing for a FRESH session taking over from a running one.
 *
 * The source is deliberately behind this one function: today it's an ad-hoc
 * summary of the pane's transcript; when muxpad grows a per-chat dossier, this
 * reads the dossier instead and every caller improves without moving. Returns
 * null when nothing usable could be produced — callers must treat that as
 * "don't proceed", never as "proceed with nothing".
 */
export async function paneCarryover(db: Database.Database, paneId: string): Promise<string | null> {
  const { summary, title, artifacts } = await summarizePane(db, paneId);
  if (!summary) return null;
  const lines = [summary];
  if (title) lines.unshift(`Ongoing thread: ${title}`);
  if (artifacts.length > 0) lines.push(`Artifacts so far: ${artifacts.join(', ')}`);
  return lines.join('\n');
}

/** Wrap a carryover briefing for injection ahead of a prompt. Delimited, like
 *  every other muxpad-authored block, so the model can tell "here is what the
 *  conversation you are continuing had established" from "here is your task". */
export function wrapCarryover(text: string): string {
  return `<muxpad-carryover>\nYou are continuing work from another muxpad chat whose context window filled up. That conversation is NOT in your history; this is the handoff briefing. Treat it as established background, and say so if you need detail it doesn't cover.\n\n${text.trim()}\n</muxpad-carryover>`;
}
