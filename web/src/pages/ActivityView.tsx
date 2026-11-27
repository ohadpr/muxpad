import { PreviewList } from '../components/ChatPreviewList';
import { activityChats } from '../lib/chat-sections';
import { useChatCorpus } from '../lib/use-all-chats';
import { useDocumentTitle } from '../use-document-title';
import './HostedView.css';
import './ActivityView.css';

/**
 * ACTIVITY — the chats you were in lately, each with the last message it had.
 *
 * A DESTINATION, beside Artifacts and Apps, not a mode of the rail. Unread is
 * a filter on the rail because it is the same rows, fewer of them; this is a
 * different row (name, workspace, time, last message) in a different order
 * (when you last touched it), and a list that reorders itself has no business
 * in the rail, which holds still on purpose (shared/tab-order). So it is a
 * page, rendered beside the kept-alive workspace hosts exactly as Artifacts and
 * Apps are (lib/shell-routes), and leaving it unmounts nothing.
 *
 * Nothing here is new: membership and order are `activityChats` — the ⌘K
 * recents ranking, the phone's Activity tab — and the rows are the phone's
 * (components/ChatPreviewList), previews from the same request. Sub-chats are
 * out, as there: a worker is its parent's business and the parent's drawer
 * lists them. A chat on another machine says so where its preview would be.
 */
export function ActivityView() {
  useDocumentTitle('Activity · muxpad');
  const rows = activityChats(useChatCorpus());
  return (
    <div className="hosted activity-view">
      <div className="hosted-inner">
        <header className="hosted-head">
          <div>
            <h1 className="hosted-title">Activity</h1>
            <p className="hosted-sub">
              The chats you were in lately, newest first, with the last thing said in each.
            </p>
          </div>
        </header>
        <PreviewList
          rows={rows}
          active={true}
          explainAbsent={true}
          empty={
            <div className="mcl-empty">
              <p className="mcl-empty-title">Nothing recent</p>
              <p className="mcl-empty-sub">Chats you open show up here.</p>
            </div>
          }
        />
      </div>
    </div>
  );
}
