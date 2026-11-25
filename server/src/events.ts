import type { MuxpadEvent } from '@muxpad/shared';

type Listener = (event: MuxpadEvent) => void;

/**
 * In-process pub/sub for structural state-change events
 * (panes/tabs/workspaces add/remove/update). The /ws/events upgrade
 * handler subscribes one listener per connected browser; mutation routes
 * call emit() after a successful write. Decoration changes (a pane's
 * title / foreground_cmd / attention flag) flow in from ptyd's control
 * channel: `PtydCache` consumes the push events and emits its own
 * `paneChange`, which the main entry forwards onto this bus as a
 * `pane.updated` event.
 *
 * Synchronous broadcast — there's no event queue. Listeners that throw are
 * logged and swallowed so one bad subscriber can't poison the others.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  private tabWorkspace: ((tabId: string) => string | undefined) | undefined;

  /** Resolve placement at emission time, including tabs absent from a client's corpus. */
  setTabWorkspaceResolver(resolve: (tabId: string) => string | undefined): void {
    this.tabWorkspace = resolve;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: MuxpadEvent): void {
    let outgoing = event;
    if (event.type === 'tab.updated' && this.tabWorkspace) {
      const workspace_id = this.tabWorkspace(event.tab.id);
      // A stale update after removal cannot be placed into any workspace.
      if (workspace_id === undefined) return;
      outgoing = { ...event, workspace_id };
    }
    for (const l of this.listeners) {
      try {
        l(outgoing);
      } catch (err) {
        console.error('EventBus listener threw', err);
      }
    }
  }
}
