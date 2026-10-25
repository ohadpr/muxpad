import { useParams } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
/** Lazily, for the reason in ShellPaneBody: the terminal emulator is ~300 KB
 *  and must not sit on the critical path of a view that may never show one. */
const XtermPane = lazy(() =>
  import('../components/XtermPane').then((m) => ({ default: m.XtermPane })),
);
import { useDocumentTitle } from '../use-document-title';

export function PopoutView() {
  const { paneId } = useParams({ from: '/p/$paneId' });
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const foregroundCmd = params?.get('cursor') === '1' ? 'cursor-agent' : null;
  useDocumentTitle(`muxpad — pane ${paneId.slice(-6)}`);
  return (
    <div style={{ height: '100vh', background: '#0b0e14' }}>
      <Suspense fallback={null}>
        <XtermPane paneId={paneId} foregroundCmd={foregroundCmd} />
      </Suspense>
    </div>
  );
}
