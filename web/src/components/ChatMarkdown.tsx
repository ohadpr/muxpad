/**
 * The markdown layer the transcript renders through — and the per-block base
 * direction that makes it read correctly in Hebrew and Arabic.
 *
 * Split out of ChatPane.tsx, which was 7,100 lines and the only file in the
 * repo over 3,000. Nothing here changed in the move. It earns its own module
 * for a structural reason rather than a tidiness one: the transcript ROWS also
 * render markdown, so leaving this at the top of ChatPane would have made the
 * rows import from the file that imports the rows. One shared leaf, no cycle.
 *
 * Pure and presentational — no state, no session, no sockets. The security
 * posture lives here too (no rehype-raw, so no user or model content can inject
 * markup), which is easier to audit in 160 lines than in 7,000.
 */
import { type ComponentProps, Fragment, type ReactNode, isValidElement, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type HighlightRun, highlightRuns, rehypeSearchHighlight } from '../lib/search-highlight';
import { CopyablePre } from './CopyablePre';

// Assistant + streaming text is rendered as GitHub-flavored markdown. No raw
// HTML is allowed through (no rehype-raw) so user/model content can't inject
// markup — react-markdown escapes everything by default. Links open safely in
// a new tab; everything else is styled from the .chat-md-* rules in the CSS.
// Per-block base direction, computed in JS from the block's first strong
// character over its (possibly nested) children. This is dir="auto" done
// right: native dir="auto" on a <li> fails because react-markdown wraps
// loose-list text in a <p> — the <li> then has no DIRECT text and defaults
// LTR, flipping the bullet to the wrong side; and dir="auto" on the whole
// message mis-directs a Hebrew body under an English intro line. Computing
// from the real text sidesteps both — each paragraph/list-item/quote gets its
// own correct direction. Code stays LTR.
const RTL_CHAR =
  /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/; // Hebrew, Arabic (+ presentation forms)
const LTR_CHAR = /[a-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/i; // Latin, Greek, Cyrillic
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}
function baseDir(children: ReactNode): 'rtl' | 'ltr' | undefined {
  for (const ch of textOf(children)) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LTR_CHAR.test(ch)) return 'ltr';
  }
  return undefined;
}
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  p: ({ node: _node, children, ...props }) => (
    <p dir={baseDir(children)} {...props}>
      {children}
    </p>
  ),
  ul: ({ node: _node, children, ...props }) => (
    <ul dir={baseDir(children)} {...props}>
      {children}
    </ul>
  ),
  ol: ({ node: _node, children, ...props }) => (
    <ol dir={baseDir(children)} {...props}>
      {children}
    </ol>
  ),
  li: ({ node: _node, children, ...props }) => (
    <li dir={baseDir(children)} {...props}>
      {children}
    </li>
  ),
  h1: ({ node: _node, children, ...props }) => (
    <h1 dir={baseDir(children)} {...props}>
      {children}
    </h1>
  ),
  h2: ({ node: _node, children, ...props }) => (
    <h2 dir={baseDir(children)} {...props}>
      {children}
    </h2>
  ),
  h3: ({ node: _node, children, ...props }) => (
    <h3 dir={baseDir(children)} {...props}>
      {children}
    </h3>
  ),
  h4: ({ node: _node, children, ...props }) => (
    <h4 dir={baseDir(children)} {...props}>
      {children}
    </h4>
  ),
  h5: ({ node: _node, children, ...props }) => (
    <h5 dir={baseDir(children)} {...props}>
      {children}
    </h5>
  ),
  h6: ({ node: _node, children, ...props }) => (
    <h6 dir={baseDir(children)} {...props}>
      {children}
    </h6>
  ),
  blockquote: ({ node: _node, children, ...props }) => (
    <blockquote dir={baseDir(children)} {...props}>
      {children}
    </blockquote>
  ),
  pre: ({ node: _node, ...props }) => <CopyablePre {...props} />,
};

/**
 * Renders (possibly partial/streaming) markdown for assistant messages.
 *
 * `hl`, when present, is the search terms this message was landed on for. It
 * becomes a rehype pass rather than anything done to `text`: see
 * lib/search-highlight for why the highlight has to happen after parsing.
 * Absent (the overwhelmingly common case) the plugin list is `undefined` and
 * the pipeline is byte-for-byte what it was.
 */
export function Markdown({ text, hl }: { text: string; hl?: readonly string[] | undefined }) {
  // Rebuilt only when the TERMS change, not per render: handing react-markdown
  // a fresh plugin array each time re-runs the whole pipeline, and this
  // component renders on every streaming frame.
  const rehypePlugins = useMemo(
    () =>
      hl && hl.length > 0
        ? // The plugin walks a structurally-typed subset of hast (it only needs
          //  `children` and `value`); unified's own `Pluggable` is generic over
          //  the full node types, and the web package deliberately doesn't take
          //  a dependency on them to describe two fields. Cast at this one
          //  boundary rather than pulling in the type packages.
          ([rehypeSearchHighlight(hl)] as ComponentProps<typeof ReactMarkdown>['rehypePlugins'])
        : undefined,
    [hl],
  );
  return (
    <div className="chat-md" dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Plain (non-markdown) message text with the search terms marked.
 *
 * The `<mark>` is the same `.chat-hit` the markdown path emits, so a hit reads
 * identically whether it landed in a user bubble, a thinking block or an
 * assistant answer. No `dangerouslySetInnerHTML` anywhere on either route: the
 * runs are strings and React escapes them.
 */
export function HighlightedText({
  text,
  hl,
}: { text: string; hl?: readonly string[] | undefined }) {
  const runs = useMemo<HighlightRun[] | null>(
    () => (hl && hl.length > 0 ? highlightRuns(text, hl) : null),
    [text, hl],
  );
  if (!runs || !runs.some((r) => r.hit)) return <>{text}</>;
  return (
    <>
      {runs.map((run, i) =>
        run.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the runs have no identity of their own and the whole message is re-split whenever text or terms change.
          <mark className="chat-hit" key={i}>
            {run.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <Fragment key={i}>{run.text}</Fragment>
        ),
      )}
    </>
  );
}
