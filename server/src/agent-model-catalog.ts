import type Database from 'better-sqlite3';
import { GlobalsStore } from './store/GlobalsStore.js';

/**
 * The last model list each backend reported, remembered across restarts.
 *
 * WHY THIS EXISTS. A model list is produced by a LIVE session — Claude's comes
 * from `session.supportedModels()`, Codex's from its own on-disk cache, Cursor's
 * from `cursor-agent --list-models`. That is fine for the model chip of a chat
 * that is already running, and useless for the one moment the user most wants
 * to choose: BEFORE the session exists, while they are picking a harness for an
 * empty chat. Asking each backend at pick time would mean spawning a process
 * (or an SDK session) just to draw a menu.
 *
 * So we keep what we were already told. Every `status` frame that carries a
 * model list is written here under its runner's backend; the launch picker
 * reads it back. The cost is one small `globals` row and no new machinery.
 *
 * Consequences, deliberately accepted:
 *  - A backend that has never run on this machine offers no list, and the
 *    picker shows only "Default" — which is the correct answer for a harness
 *    we know nothing about. It is never a guess.
 *  - The list can be stale by one session. Harmless: the value is passed to the
 *    harness as `--model <id>`, and a retired id fails loudly in that session
 *    rather than silently mis-running.
 */
export interface CatalogModel {
  value: string;
  displayName: string;
  resolvedModel?: string;
}

export type ModelCatalog = Record<string, CatalogModel[]>;

const KEY = 'agent_model_catalog';
/** Cap per backend — a runaway/hostile list must not grow the globals row without bound. */
const MAX_MODELS = 32;

/** Coerce one wire entry into a catalog entry, or null if it isn't one. */
function cleanModel(v: unknown): CatalogModel | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.value !== 'string' || !o.value) return null;
  const displayName = typeof o.displayName === 'string' && o.displayName ? o.displayName : o.value;
  return {
    value: o.value,
    displayName,
    ...(typeof o.resolvedModel === 'string' && o.resolvedModel
      ? { resolvedModel: o.resolvedModel }
      : {}),
  };
}

/**
 * Read the catalog. Always returns an object — a missing, truncated or
 * hand-edited row degrades to "we know nothing", never to a throw at the
 * route that reads it.
 */
export function readModelCatalog(db: Database.Database): ModelCatalog {
  const raw = new GlobalsStore(db).get(KEY);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const out: ModelCatalog = {};
  for (const [backend, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const models = list
      .map(cleanModel)
      .filter((m): m is CatalogModel => m !== null)
      .slice(0, MAX_MODELS);
    if (models.length > 0) out[backend] = models;
  }
  return out;
}

/**
 * Remember `backend`'s model list. No-ops on an empty list (a failed
 * `supportedModels()` reports `[]`, and forgetting what we knew because one
 * fetch failed would empty the picker for no reason) and on an unchanged list
 * (the status refresh re-sends after every turn).
 */
export function recordModelCatalog(
  db: Database.Database,
  backend: string,
  models: readonly unknown[] | undefined,
): void {
  if (!backend || !models || models.length === 0) return;
  const clean = models
    .map(cleanModel)
    .filter((m): m is CatalogModel => m !== null)
    .slice(0, MAX_MODELS);
  if (clean.length === 0) return;
  const current = readModelCatalog(db);
  if (JSON.stringify(current[backend]) === JSON.stringify(clean)) return;
  new GlobalsStore(db).set(KEY, JSON.stringify({ ...current, [backend]: clean }));
}
