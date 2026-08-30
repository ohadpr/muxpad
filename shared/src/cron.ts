// muxpad crons — the shared vocabulary for the server-owned scheduler
// (docs/plans/2026-08-14-muxpad-cron.md). Two things live here:
//
//   1. The wire shapes (`Cron`, `CronRun`) the API returns and the CLI/web
//      render, so the server and every client agree on one definition.
//   2. The in-transcript FIRE MARKER — the delimited block prepended to a
//      cron's injected prompt. The SERVER writes it and the CHAT CLIENT
//      renders it, so the two must agree byte-for-byte; a hand-kept second
//      copy of this grammar is exactly how a marker starts leaking into the
//      conversation as raw XML.
import { z } from 'zod';

/** Where a fire lands. `pane` = the warm session; `new-tab` = a clean room. */
export const CronTargetKindSchema = z.enum(['pane', 'new-tab']);
export type CronTargetKind = z.infer<typeof CronTargetKindSchema>;

/** What to do about fires that came due while the server was down. */
export const CronCatchupSchema = z.enum(['once', 'skip', 'all']);
export type CronCatchup = z.infer<typeof CronCatchupSchema>;

/** What to do when this cron's PREVIOUS fire is still outstanding. */
export const CronOverlapSchema = z.enum(['skip', 'queue']);
export type CronOverlap = z.infer<typeof CronOverlapSchema>;

/** Pane mode only: what to do when the pane's context window is nearly full. */
export const CronOnContextSchema = z.enum(['fire', 'compact-first', 'rotate', 'skip']);
export type CronOnContext = z.infer<typeof CronOnContextSchema>;

export const CronSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Five-field cron expression (a friendly grammar compiles down to this). */
  schedule: z.string(),
  /** IANA zone, e.g. 'America/Los_Angeles'. Never a UTC offset. */
  tz: z.string(),
  prompt: z.string(),
  target_kind: CronTargetKindSchema,
  target_pane: z.string().nullable(),
  workspace_id: z.string().nullable(),
  cwd: z.string().nullable(),
  model: z.string().nullable(),
  backend: z.string().nullable(),
  /** Agent behavior overlay for a new-tab fire ('do' by default — a scheduled
   *  job's report wants terse and result-first). Ignored in pane mode, where
   *  the fire inherits the pane's live session and its existing mode. */
  mode: z.string().nullable(),
  enabled: z.boolean(),
  catchup: CronCatchupSchema,
  overlap: CronOverlapSchema,
  on_context: CronOnContextSchema,
  quiet_mins: z.number().int().nonnegative(),
  /** new-tab only: how many of this cron's tabs may be open at once. */
  max_open: z.number().int().positive(),
  /** new-tab only: close the spawned tab when its turn finishes cleanly. */
  close_when_done: z.boolean(),
  next_due_at: z.number(),
  last_fire_at: z.number().nullable(),
  last_status: z.string().nullable(),
  fail_streak: z.number().int().nonnegative(),
  created_at: z.number(),
});
export type Cron = z.infer<typeof CronSchema>;

export const CronRunSchema = z.object({
  id: z.string(),
  cron_id: z.string(),
  due_at: z.number(),
  fired_at: z.number(),
  target_pane: z.string().nullable(),
  target_tab: z.string().nullable(),
  /** VERBATIM from submitSend where one happened (`sent` | `queued` |
   *  `rejected`), else our own verdict (`skipped` | `missed` | `error`). */
  outcome: z.string(),
  detail: z.string().nullable(),
});
export type CronRun = z.infer<typeof CronRunSchema>;

// ── The in-transcript fire marker ───────────────────────────────────────────

export interface CronMarker {
  /** Cron id — the durable handle the overlap check matches on. */
  id: string;
  name: string;
  /** Epoch ms of the slot this fire is FOR (not when it was delivered). */
  at: number | null;
  /** Fires collapsed into this one by `catchup=once`. 0 for a normal fire. */
  missed: number;
}

const CRON_OPEN = /^\s*<muxpad-cron\b([^>]*)>([\s\S]*?)<\/muxpad-cron>\s*/;

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? (m[1] as string) : null;
}

/**
 * Wrap a cron's prompt with its fire marker. The block is a real instruction
 * to the agent (it says where the message came from) AND the render hook the
 * chat client keys on — one string, so the two can't drift.
 */
export function renderCronMarker(marker: CronMarker, prompt: string): string {
  const missed = marker.missed > 0 ? ` missed="${marker.missed}"` : '';
  const at = marker.at !== null ? ` at="${marker.at}"` : '';
  const note =
    marker.missed > 0
      ? `Delivered by the muxpad cron "${marker.name}" — a scheduled job, not a human. ${marker.missed} earlier fire(s) were missed while muxpad was offline and are collapsed into this one.`
      : `Delivered by the muxpad cron "${marker.name}" — a scheduled job, not a human.`;
  return `<muxpad-cron id="${marker.id}" name="${marker.name}"${at}${missed}>\n${note}\n</muxpad-cron>\n\n${prompt}`;
}

/**
 * Split a delivered cron message back into its marker and the prompt the user
 * actually wrote. Returns null for ordinary text — including text that merely
 * MENTIONS the tag somewhere in the middle, since only a leading block is a
 * marker we produced.
 */
export function parseCronMarker(text: string): { marker: CronMarker; body: string } | null {
  const m = text.match(CRON_OPEN);
  if (!m) return null;
  const attrs = m[1] ?? '';
  const id = attr(attrs, 'id');
  const name = attr(attrs, 'name');
  if (!id || !name) return null;
  const atRaw = attr(attrs, 'at');
  const missedRaw = attr(attrs, 'missed');
  const at = atRaw !== null && /^\d+$/.test(atRaw) ? Number(atRaw) : null;
  const missed = missedRaw !== null && /^\d+$/.test(missedRaw) ? Number(missedRaw) : 0;
  return { marker: { id, name, at, missed }, body: text.slice(m[0].length) };
}

/** Does this queued/injected message belong to `cronId`? The overlap check's
 *  predicate — matched on the DURABLE id, never the (renameable) name. */
export function messageIsFromCron(text: string, cronId: string): boolean {
  return parseCronMarker(text)?.marker.id === cronId;
}
