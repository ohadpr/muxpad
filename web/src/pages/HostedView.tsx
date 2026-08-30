import {
  APP_STATE_LABEL,
  APP_STATE_STATUS,
  type AppWithStatus,
  type Artifact,
} from '@muxpad/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { StatusMark } from '../components/StatusMark';
import { XtermPane } from '../components/XtermPane';
import { appDetail, formatBytes, formatDate, hostedApi, useHosted } from '../lib/hosted';
import { useDocumentTitle } from '../use-document-title';
import './HostedView.css';

/**
 * HOSTED — one view, two kinds.
 *
 *   APPS       running local web servers muxpad supervises. Private (tailnet
 *              only), have logs, can be started and stopped.
 *   ARTIFACTS  static trees published to a public URL, with versions.
 *
 * They are listed together because the question a person arrives with — "what
 * am I hosting, and is it up?" — spans both. They are listed SEPARATELY, under
 * their own headers with their own action sets, because everything else about
 * them differs: an app can be stopped, an artifact cannot; an artifact has a
 * public link worth copying, an app deliberately does not.
 *
 * The status rail is the sidebar's StatusMark, unchanged, reading the shared
 * APP_STATE_STATUS mapping. There is no second status vocabulary in muxpad —
 * the mark answers "should I look?", the row's own line answers "what exactly?".
 *
 * Mobile-first: rows are a wrapping flex, every control is at least 44px tall
 * on touch, and nothing is revealed by hover — hover only ever *brightens*
 * something already visible.
 */
export function HostedView() {
  const { apps, artifacts, loading, error, refresh } = useHosted();
  useDocumentTitle('muxpad — hosted');

  return (
    <div className="hosted">
      <div className="hosted-inner">
        <header className="hosted-head">
          <div>
            <h1 className="hosted-title">Hosted</h1>
            <p className="hosted-sub">
              Apps run here and stay private. Artifacts are published to a public URL.
            </p>
          </div>
          <button
            type="button"
            className="hosted-btn hosted-btn-quiet"
            onClick={() => void refresh()}
            title="Check again now"
          >
            Refresh
          </button>
        </header>

        {error && (
          <p className="hosted-error" role="status">
            {error}
          </p>
        )}

        <section className="hosted-section" aria-labelledby="hosted-apps-h">
          <div className="hosted-section-head">
            <h2 className="hosted-section-label" id="hosted-apps-h">
              Apps
            </h2>
            <span className="hosted-section-note">tailnet only</span>
          </div>
          {loading && apps.length === 0 ? (
            <p className="hosted-empty">Loading…</p>
          ) : apps.length === 0 ? (
            <EmptyState
              line="No apps registered."
              hint="muxpad app add --name=Notes --url=https://host:4322 --cwd=~/notes -- ./start"
            />
          ) : (
            <ul className="hosted-list">
              {apps.map((app) => (
                <AppRow key={app.id} app={app} onChanged={refresh} />
              ))}
            </ul>
          )}
        </section>

        <section className="hosted-section" aria-labelledby="hosted-artifacts-h">
          <div className="hosted-section-head">
            <h2 className="hosted-section-label" id="hosted-artifacts-h">
              Artifacts
            </h2>
            <span className="hosted-section-note hosted-section-note-public">public</span>
          </div>
          {loading && artifacts.length === 0 ? (
            <p className="hosted-empty">Loading…</p>
          ) : artifacts.length === 0 ? (
            <EmptyState
              line="Nothing published."
              hint="muxpad publish ./report.html --name=report"
            />
          ) : (
            <ul className="hosted-list">
              {artifacts.map((a) => (
                <ArtifactRow key={a.slug} artifact={a} onChanged={refresh} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyState({ line, hint }: { line: string; hint: string }) {
  return (
    <div className="hosted-empty">
      <p className="hosted-empty-line">{line}</p>
      {/* The empty state teaches the verb rather than apologising. There is no
          "+ Add" button because registering an app needs a command and a
          directory — a form that would be worse than the one-liner. */}
      <code className="hosted-empty-hint">{hint}</code>
    </div>
  );
}

function AppRow({ app, onChanged }: { app: AppWithStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      console.error('hosted action failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="hosted-row" data-kind="app" data-state={app.state}>
      <div className="hosted-row-main">
        <StatusMark status={APP_STATE_STATUS[app.state]} className="hosted-row-mark" />
        <div className="hosted-row-text">
          <div className="hosted-row-title">
            <span className="hosted-row-name">{app.name}</span>
            <span className="hosted-chip" data-state={app.state}>
              {APP_STATE_LABEL[app.state]}
            </span>
          </div>
          <div className="hosted-row-meta">{appDetail(app)}</div>
          <div className="hosted-row-meta hosted-row-mono">{app.url}</div>
        </div>
      </div>
      <div className="hosted-actions">
        {/* Opening an app is a ROUTE, not a tab: the view is ephemeral and
            closing it does not touch the process. */}
        <Link
          className="hosted-btn hosted-btn-primary"
          to="/hosted/a/$slug"
          params={{ slug: app.slug }}
        >
          Open
        </Link>
        <Link
          className="hosted-btn"
          to="/hosted/a/$slug"
          params={{ slug: app.slug }}
          search={{ logs: true }}
        >
          Logs
        </Link>
        {app.enabled ? (
          <button
            type="button"
            className="hosted-btn"
            disabled={busy}
            onClick={() => void run(() => hostedApi.stopApp(app.slug))}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="hosted-btn"
            disabled={busy}
            onClick={() => void run(() => hostedApi.startApp(app.slug))}
          >
            Start
          </button>
        )}
        <button
          type="button"
          className="hosted-btn hosted-btn-danger"
          disabled={busy}
          onClick={() => {
            if (!confirm(`Unregister ${app.name}? Its files are untouched; the server stops.`))
              return;
            void run(() => hostedApi.removeApp(app.slug));
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function ArtifactRow({ artifact, onChanged }: { artifact: Artifact; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    if (!artifact.url) return;
    try {
      await navigator.clipboard.writeText(artifact.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard is permission-gated; failing silently beats an alert.
    }
  };

  return (
    <li className="hosted-row" data-kind="artifact">
      <div className="hosted-row-main">
        {/* An artifact has no process, so it has no status — the rail stays a
            reserved empty column rather than borrowing a mark that would mean
            something else. */}
        <StatusMark status="idle" className="hosted-row-mark" />
        <div className="hosted-row-text">
          <div className="hosted-row-title">
            <span className="hosted-row-name">{artifact.slug}</span>
            <span className="hosted-chip" data-state="public">
              public
            </span>
          </div>
          <div className="hosted-row-meta">
            {formatDate(artifact.created)} · {artifact.files} file
            {artifact.files === 1 ? '' : 's'} · {formatBytes(artifact.bytes)}
          </div>
          <div className="hosted-row-meta hosted-row-mono">
            {artifact.url ?? 'not public yet — publish once to establish the URL'}
          </div>
        </div>
      </div>
      <div className="hosted-actions">
        <a
          className="hosted-btn hosted-btn-primary"
          href={artifact.url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={artifact.url ? undefined : true}
        >
          Open
        </a>
        <button
          type="button"
          className="hosted-btn"
          disabled={!artifact.url}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        {artifact.versions.length > 0 && (
          <button
            type="button"
            className="hosted-btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            Versions ({artifact.versions.length})
          </button>
        )}
        <button
          type="button"
          className="hosted-btn hosted-btn-danger"
          disabled={busy}
          onClick={() => {
            if (!confirm(`Unpublish ${artifact.slug}? Its previous versions go too.`)) return;
            setBusy(true);
            void hostedApi
              .removeArtifact(artifact.slug)
              .then(onChanged)
              .catch((err) => console.error(err))
              .finally(() => setBusy(false));
          }}
        >
          Delete
        </button>
      </div>
      {open && (
        <ul className="hosted-versions">
          {artifact.versions.map((v) => (
            <li key={v.n} className="hosted-version">
              <span className="hosted-version-n">@{v.n}</span>
              <span className="hosted-row-meta">
                {formatDate(v.created)} · {formatBytes(v.bytes)}
              </span>
              <a
                className="hosted-btn hosted-btn-sm"
                href={v.url ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open
              </a>
            </li>
          ))}
          <li className="hosted-version-note">
            @2 is the previous publish, @3 the one before it. Republishing shifts them along.
          </li>
        </ul>
      )}
    </li>
  );
}

/**
 * The app viewer — a full-screen route, NOT a tab.
 *
 * This is the whole point of the feature: looking at an app costs a route you
 * can leave, not a permanent slot in the tab tree. Nothing here stops the app;
 * navigating away is just navigating away, and the process is owned by ptyd
 * either way.
 *
 * `?logs=true` swaps the iframe for the app's own pane terminal — which is
 * literally the app's log, because an app IS a pane underneath.
 */
export function HostedAppView() {
  const { slug } = useParams({ from: '/_app/hosted/a/$slug' });
  const { apps, refresh } = useHosted();
  const navigate = useNavigate();
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const [showLogs, setShowLogs] = useState(params?.get('logs') === 'true');
  const app = apps.find((a) => a.slug === slug);
  useDocumentTitle(app ? `muxpad — ${app.name}` : 'muxpad — hosted');

  return (
    <div className="hosted-app-view">
      <header className="hosted-app-bar">
        <button
          type="button"
          className="hosted-btn hosted-btn-quiet"
          onClick={() => void navigate({ to: '/hosted' })}
          aria-label="Back to Hosted"
        >
          ‹ Hosted
        </button>
        <StatusMark status={app ? APP_STATE_STATUS[app.state] : 'idle'} />
        <span className="hosted-app-name">{app?.name ?? slug}</span>
        {app && (
          <span className="hosted-chip" data-state={app.state}>
            {APP_STATE_LABEL[app.state]}
          </span>
        )}
        <span className="hosted-app-spacer" />
        <button
          type="button"
          className={`hosted-btn${showLogs ? ' hosted-btn-primary' : ''}`}
          aria-pressed={showLogs}
          onClick={() => setShowLogs((v) => !v)}
        >
          Logs
        </button>
        {app && app.state !== 'running' && (
          <button
            type="button"
            className="hosted-btn"
            onClick={() => void hostedApi.startApp(app.slug).then(refresh)}
          >
            Start
          </button>
        )}
      </header>
      <div className="hosted-app-body">
        {showLogs ? (
          app?.pane_id ? (
            <XtermPane paneId={app.pane_id} foregroundCmd={null} />
          ) : (
            <p className="hosted-empty">This app has no process running, so it has no logs yet.</p>
          )
        ) : app ? (
          app.state === 'running' || app.state === 'starting' ? (
            <iframe className="hosted-app-frame" src={app.url} title={app.name} />
          ) : (
            <div className="hosted-empty">
              <p className="hosted-empty-line">{appDetail(app)}</p>
              <code className="hosted-empty-hint">{app.url}</code>
            </div>
          )
        ) : (
          <p className="hosted-empty">No app called “{slug}”.</p>
        )}
      </div>
    </div>
  );
}
