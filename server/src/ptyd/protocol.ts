import type { PaneRuntimeSpec } from '../runtime/PaneRuntime.js';
import type { AppUrlMarker } from '../runtime/pty-scanner.js';

/**
 * Bump when wire shape changes incompatibly. Both ends should refuse to
 * start on mismatch — not implemented yet, but the constant gives future
 * divergence a stable anchor.
 *
 * v2: replaced the computed `paneAppUrls` push with raw `paneUrlsSeen`
 * (app-url detection moved from ptyd to the main server). An old ptyd against
 * a new server would silently surface zero app-urls; a `restart --all`
 * (which relaunches both from the same tree) sidesteps the mismatch.
 */
export const PTYD_PROTOCOL_VERSION = 2;

export type CtrlRequest = {
  kind: 'request';
  id: number;
  method: string;
  params: unknown;
};
export type CtrlResponse =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string };
export type CtrlEvent = { kind: 'event'; event: string } & Record<string, unknown>;
export type CtrlMessage = CtrlRequest | CtrlResponse | CtrlEvent;

export function encodeRequest(r: Omit<CtrlRequest, 'kind'>): string {
  return JSON.stringify({ t: 'req', ...r });
}
export function encodeResponse(id: number, result: unknown): string {
  return JSON.stringify({ t: 'res', id, ok: true, result });
}
export function encodeErrorResponse(id: number, error: string): string {
  return JSON.stringify({ t: 'res', id, ok: false, error });
}
export function encodeEvent(e: Omit<CtrlEvent, 'kind'>): string {
  return JSON.stringify({ t: 'evt', ...e });
}
export function decodeMessage(s: string): CtrlMessage {
  const v = JSON.parse(s);
  if (v?.t === 'req' && typeof v.id === 'number' && typeof v.method === 'string')
    return { kind: 'request', id: v.id, method: v.method, params: v.params };
  if (v?.t === 'res' && typeof v.id === 'number') {
    if (v.ok === true) return { kind: 'response', id: v.id, ok: true, result: v.result };
    if (v.ok === false) return { kind: 'response', id: v.id, ok: false, error: String(v.error) };
  }
  if (v?.t === 'evt' && typeof v.event === 'string') {
    const { t: _t, ...rest } = v;
    return { kind: 'event', ...rest } as CtrlEvent;
  }
  throw new Error('malformed control message');
}

export type CreatePaneParams = { spec: PaneRuntimeSpec };
export type IdParams = { id: string };

export interface CtrlMethods {
  ensurePane: { params: CreatePaneParams; result: { ok: true } };
  killPane: { params: IdParams; result: { ok: true } };
  hasPane: { params: IdParams; result: { has: boolean } };
  getCurrentCwd: { params: IdParams; result: { cwd: string | null } };
  getForegroundCommand: { params: IdParams; result: { cmd: string | null } };
  markSeen: { params: IdParams; result: { ok: true } };
  flushCwds: {
    params: Record<string, never>;
    result: { entries: Array<{ id: string; cwd: string }> };
  };
  closePtyClients: { params: IdParams; result: { ok: true } };
}

export type CtrlPushEvent =
  | { event: 'paneExit'; id: string; code: number; cause: 'natural' | 'killed' }
  | { event: 'paneCwd'; id: string; cwd: string }
  | { event: 'paneTitle'; id: string; title: string | null }
  | { event: 'paneFg'; id: string; cmd: string | null }
  | { event: 'paneAttention'; id: string; attention: boolean }
  // Raw URL/marker sightings the scanner extracted from this pane's output.
  // ptyd does NOT validate or probe these — the main server runs the
  // AppUrlTracker (host classification + listening probe) so detection logic
  // can change with a server-only restart, never a ptyd bounce.
  | { event: 'paneUrlsSeen'; id: string; urls: string[]; markers: AppUrlMarker[] };
