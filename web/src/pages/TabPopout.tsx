import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import {
  Mosaic,
  MosaicWindow,
  type MosaicNode,
} from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import { XtermPane } from '../components/XtermPane';
import type { LayoutNode } from '@muxpad/shared';
import { api, type TabWithPanes } from '../api';
import { useDocumentTitle } from '../use-document-title';

/**
 * Chromeless popout for a whole tab. Mounted at `/popout/t/$tabSlug` —
 * renders just the tab's pane mosaic with no workspace chrome and no
 * tab bar. Triggered from the tab bar's right-click context menu.
 */
export function TabPopout() {
  const { tabSlug } = useParams({ from: '/popout/t/$tabSlug' });
  const [tab, setTab] = useState<TabWithPanes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useDocumentTitle(tab ? `muxpad — ${tab.name}` : 'muxpad');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // No reverse-lookup API for slug → tab; iterate workspaces' tabs
        // until we find one. Cheap for any realistic install.
        const workspaces = await api.listWorkspaces();
        for (const w of workspaces) {
          const tabs = await api.listTabs(w.id);
          const found = tabs.find((t) => t.slug === tabSlug);
          if (found) {
            const detail = await api.getTab(found.id);
            if (!cancelled) setTab(detail);
            return;
          }
        }
        if (!cancelled) setError('tab not found');
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabSlug]);

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <p>{error}</p>
      </div>
    );
  }
  if (!tab) {
    return <div style={{ padding: 32 }}>loading…</div>;
  }

  const layout = toMosaic(tab.layout);
  if (layout == null) {
    return <div style={{ padding: 32 }}>This tab has no panes.</div>;
  }

  return (
    <div style={{ height: '100vh', background: 'var(--bg)' }}>
      <Mosaic<string>
        renderTile={(paneId, path) => (
          <MosaicWindow<string>
            path={path}
            title=""
            renderToolbar={() => <div className="pane-chrome" />}
          >
            <XtermPane paneId={paneId} />
          </MosaicWindow>
        )}
        value={layout}
        onChange={() => {
          // Popout is read-only for layout — changes would need to sync
          // back to the parent tab, which adds complexity for v1. The
          // user can re-arrange in the main tab view.
        }}
        blueprintNamespace="bp4"
      />
    </div>
  );
}

function toMosaic(layout: LayoutNode): MosaicNode<string> | null {
  if (typeof layout === 'string') return layout || null;
  const node: MosaicNode<string> = {
    direction: layout.direction === 'row' ? 'row' : 'column',
    first: toMosaic(layout.first) ?? '',
    second: toMosaic(layout.second) ?? '',
  };
  if (layout.splitPercentage !== undefined) {
    (node as { splitPercentage?: number }).splitPercentage = layout.splitPercentage;
  }
  return node;
}
