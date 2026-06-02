// Persistent "last visited" memory: per-workspace last tab and
// per-tab last pane. Used so workspace switches restore the user
// to where they were instead of always slamming them back to the
// first tab / first pane. Lives in localStorage — single-user,
// per-browser is exactly the scope we want.
const KEY = 'muxpad.lastVisited';

type State = {
  workspaceTab: Record<string, string>; // wsSlug -> tabSlug
  tabPane: Record<string, string>; // tabId -> paneId
};

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { workspaceTab: {}, tabPane: {} };
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      workspaceTab: parsed.workspaceTab ?? {},
      tabPane: parsed.tabPane ?? {},
    };
  } catch {
    return { workspaceTab: {}, tabPane: {} };
  }
}

function write(s: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // quota exceeded etc. — best-effort, drop silently
  }
}

export function getLastTabSlug(wsSlug: string): string | undefined {
  return read().workspaceTab[wsSlug];
}

export function setLastTabSlug(wsSlug: string, tabSlug: string): void {
  const s = read();
  if (s.workspaceTab[wsSlug] === tabSlug) return;
  s.workspaceTab[wsSlug] = tabSlug;
  write(s);
}

export function getLastPaneId(tabId: string): string | undefined {
  return read().tabPane[tabId];
}

export function setLastPaneId(tabId: string, paneId: string): void {
  const s = read();
  if (s.tabPane[tabId] === paneId) return;
  s.tabPane[tabId] = paneId;
  write(s);
}
