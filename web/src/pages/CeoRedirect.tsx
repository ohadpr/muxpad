import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { resolveCeoIds } from '../lib/ceo';

/**
 * Legacy /ceo entry point. The CEO renders through the standard workspace-tab
 * chrome now (it's a real tab in the hidden system workspace); this route
 * just resolves GET /api/ceo and lands there, keeping old links and
 * bookmarks working.
 */
export function CeoRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    let alive = true;
    resolveCeoIds()
      .then((ids) => {
        if (!alive) return;
        void navigate({
          to: '/w/$wsSlug/t/$tabSlug',
          params: { wsSlug: ids.workspace_slug, tabSlug: ids.tab_slug },
          replace: true,
        });
      })
      .catch((err) => console.error('CEO resolve failed', err));
    return () => {
      alive = false;
    };
  }, [navigate]);
  return <div className="workspace-loading">loading…</div>;
}
