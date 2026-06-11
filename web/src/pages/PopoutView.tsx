import { useParams } from '@tanstack/react-router';
import { XtermPane } from '../components/XtermPane';
import { useDocumentTitle } from '../use-document-title';

export function PopoutView() {
  const { paneId } = useParams({ from: '/p/$paneId' });
  const params =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const foregroundCmd = params?.get('cursor') === '1' ? 'cursor-agent' : null;
  useDocumentTitle(`muxpad — pane ${paneId.slice(-6)}`);
  return (
    <div style={{ height: '100vh', background: '#0b0e14' }}>
      <XtermPane paneId={paneId} foregroundCmd={foregroundCmd} />
    </div>
  );
}
