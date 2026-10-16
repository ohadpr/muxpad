/**
 * Which parents' sub-chats the reader had OPEN in the rail.
 *
 * ── WHY IT PERSISTS ─────────────────────────────────────────────────────────
 * Because collapsing by default is only tolerable if opening STICKS. A
 * coordinator chat that fans out six workers is a chat you sit with for an
 * hour, and plain component state loses the disclosure on every sidebar
 * remount — a tab switch, a workspace switch, a reload — so the reader would
 * re-open the same group all afternoon. Card-open state is remembered for the
 * same reason and on the same tier.
 *
 * ONE key for the whole rail, not one per workspace: the fact being stored is
 * "I am watching this chat's workers", and that is about the chat. A set of
 * tab ids answers it exactly, and a tab that no longer exists simply never
 * matches again — nothing has to clean up after a closed chat.
 *
 * localStorage, best-effort, and silent on failure (quota, private mode): a
 * disclosure that does not persist is a smaller problem than a rail that
 * throws while rendering.
 */
const KEY = 'muxpad:rail-open-subs:v1';

/** How many parents' open state is kept, oldest dropped first. Generous: the
 *  value is a list of ulids and a hundred of them is a few kilobytes. */
const MAX_REMEMBERED = 100;

export function recallOpenSubChats(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function rememberOpenSubChats(ids: Set<string>): void {
  try {
    if (ids.size === 0) {
      localStorage.removeItem(KEY);
      return;
    }
    const kept = [...ids].slice(-MAX_REMEMBERED);
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // quota / private mode — the disclosure just does not survive a remount.
  }
}
