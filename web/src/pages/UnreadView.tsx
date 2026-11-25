import { PreviewList } from '../components/ChatPreviewList';
import { railUnreadRows } from '../lib/chat-sections';
import { useUnreadCorpus } from '../lib/use-unread';
import { useDocumentTitle } from '../use-document-title';
import './HostedView.css';
import './ActivityView.css';

/**
 * UNREAD — every conversation with something in it you have not read, across
 * every workspace.
 *
 * ─── WHY A PAGE AT ALL, WHEN THE RAIL ALREADY HAS A VIEW ────────────────────
 * It is the same list. The rail's Unread entry switches the chat list beside
 * it and never changes the URL, which is right for the common case: you are
 * reading a chat, you glance at what is unread, you go back. Navigating away
 * from a conversation to answer that question would be worse.
 *
 * But a thing with no URL cannot be right-clicked, opened in a new tab,
 * bookmarked, or linked to — "icon rail still not using <a>" — and the honest
 * fix for that is not to fake an anchor, it is for the destination to EXIST.
 * So the rail's entry is now an anchor pointing here, with its left-click
 * intercepted to do the in-place view switch it always did (see
 * DestinationRail). Right-click, cmd-click and middle-click fall through to
 * the browser and land on this page.
 *
 * Which means this page is reached by the gestures that mean "somewhere else,
 * please", and never by the plain click that means "show me here". It is
 * deliberately the same rows in the same order as the rail's view, from the
 * same `railUnreadRows`, so the two cannot disagree about what unread means.
 *
 * `activeTabId` is null here, which is the one difference and a correct one:
 * the rail's view keeps the chat you are IN visible so the list does not
 * shift under you as you read it. On a page of its own there is no chat you
 * are in.
 */
export function UnreadView() {
  useDocumentTitle('Unread · muxpad');
  const rows = railUnreadRows(useUnreadCorpus(), null);
  return (
    <div className="hosted activity-view">
      <div className="hosted-inner">
        <header className="hosted-head">
          <div>
            <h1 className="hosted-title">Unread</h1>
            <p className="hosted-sub">
              Conversations with something you have not read, from every workspace.
            </p>
          </div>
        </header>
        <PreviewList
          rows={rows}
          active={true}
          explainAbsent={true}
          empty={
            <div className="mcl-empty">
              <p className="mcl-empty-title">You’re all caught up</p>
              <p className="mcl-empty-sub">Nothing unread in any workspace.</p>
            </div>
          }
        />
      </div>
    </div>
  );
}
