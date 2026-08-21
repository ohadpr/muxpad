import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AgentBlock } from '../components/AgentBlock';
import {
  type AgentBlock as AgentBlockModel,
  type Block,
  type DocState,
  type TextBlock as TextBlockModel,
  blockId,
  createAgentPane,
  ensureBackingTab,
  loadDoc,
  saveDoc,
} from '../lib/doc-store';
import { getSettings } from '../settings';
import './DocView.css';

/**
 * The document surface: an endless note where an AI conversation is a
 * first-class, collapsible block. Type prose; drop an "Ask AI" block; converse;
 * collapse it to a one-line deliverable + artifact chips; keep writing. The
 * document is the context and the artifacts live here — no tabs, no session to
 * resume, no wall of chat to re-read.
 */
export function DocView() {
  const [doc, setDoc] = useState<DocState>(() => loadDoc());
  const [tabId, setTabId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  // Ensure a backing tab exists for agent panes (see doc-store). Runs once.
  useEffect(() => {
    let alive = true;
    ensureBackingTab()
      .then((id) => alive && setTabId(id))
      .catch((e) => alive && setBootError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // /doc renders outside AppLayout, which is what normally applies the theme —
  // make sure the current theme lands on <html> so our vars resolve.
  useEffect(() => {
    if (!document.documentElement.dataset.theme) {
      document.documentElement.dataset.theme = getSettings().theme;
    }
  }, []);

  // Persist on every change — the document survives a reload on this device.
  useEffect(() => {
    saveDoc(doc);
  }, [doc]);

  // ── Cross-block keyboard navigation ──────────────────────────────────────
  // Each block registers a focuser; arrowing past a block's edge moves the caret
  // into the adjacent block, so the document reads as one continuous surface
  // (not a stack of trapped widgets). blocksRef keeps the latest order without
  // rebinding the stable callbacks below on every edit.
  const focusers = useRef<Map<string, (edge: 'start' | 'end') => void>>(new Map());
  const blocksRef = useRef(doc.blocks);
  blocksRef.current = doc.blocks;

  const registerFocuser = useCallback(
    (id: string, fn: ((edge: 'start' | 'end') => void) | null) => {
      if (fn) focusers.current.set(id, fn);
      else focusers.current.delete(id);
    },
    [],
  );

  const exitBlock = useCallback((fromId: string, dir: 'up' | 'down') => {
    const blocks = blocksRef.current;
    const idx = blocks.findIndex((b) => b.id === fromId);
    const target = blocks[dir === 'up' ? idx - 1 : idx + 1];
    if (target) focusers.current.get(target.id)?.(dir === 'up' ? 'end' : 'start');
  }, []);

  // Backspace at the very start of an empty text block deletes it and drops the
  // caret at the end of the previous block — so the empty text blocks that agent
  // insertion sows don't pile up. Never removes the first block.
  const removeEmptyText = useCallback((id: string) => {
    const blocks = blocksRef.current;
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx <= 0) return;
    const prevId = blocks[idx - 1]?.id;
    setDoc((d) => {
      const next = d.blocks.filter((b) => b.id !== id);
      if (!next.some((b) => b.kind === 'text'))
        next.push({ id: blockId(), kind: 'text', content: '' });
      return { blocks: next };
    });
    if (prevId) requestAnimationFrame(() => focusers.current.get(prevId)?.('end'));
  }, []);

  const patchBlock = useCallback((id: string, patch: Partial<Block>) => {
    setDoc((d) => ({
      blocks: d.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)),
    }));
  }, []);

  const removeBlock = useCallback((id: string) => {
    setDoc((d) => {
      const blocks = d.blocks.filter((b) => b.id !== id);
      // Never leave the document empty — keep a trailing text block to type in.
      if (!blocks.some((b) => b.kind === 'text')) {
        blocks.push({ id: blockId(), kind: 'text', content: '' });
      }
      return { blocks };
    });
  }, []);

  // Insert a fresh agent block after `afterId` (or at the end when null). Creates
  // the backing pane first so the block always references a live session.
  const addAgentBlock = useCallback(
    async (afterId: string | null) => {
      if (!tabId) return;
      let paneId: string;
      try {
        paneId = await createAgentPane(tabId);
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
        return;
      }
      const agent: AgentBlockModel = {
        id: blockId(),
        kind: 'agent',
        paneId,
        collapsed: false,
        title: '',
        summary: '',
        artifacts: [],
      };
      setDoc((d) => {
        const idx = afterId ? d.blocks.findIndex((b) => b.id === afterId) : -1;
        const blocks = [...d.blocks];
        const at = idx >= 0 ? idx + 1 : blocks.length;
        blocks.splice(at, 0, agent);
        // Guarantee a text block after the agent block so the cursor has
        // somewhere to land when you collapse and keep writing.
        if (at + 1 >= blocks.length || blocks[at + 1]?.kind !== 'text') {
          blocks.splice(at + 1, 0, { id: blockId(), kind: 'text', content: '' });
        }
        return { blocks };
      });
    },
    [tabId],
  );

  return (
    <div className="doc-view">
      <header className="doc-topbar">
        <span className="doc-brand">muxpad · document</span>
        <span className="doc-topbar-status">
          {bootError ? (
            <span className="doc-error">⚠ {bootError}</span>
          ) : tabId ? null : (
            <span className="doc-booting">connecting…</span>
          )}
        </span>
      </header>

      <main className="doc-scroll">
        <div className="doc-page">
          {doc.blocks.map((b) =>
            b.kind === 'text' ? (
              <TextBlock
                key={b.id}
                block={b}
                onChange={(content) => patchBlock(b.id, { content })}
                onSlashAi={() => void addAgentBlock(b.id)}
                canAddAi={!!tabId}
                onExit={(dir) => exitBlock(b.id, dir)}
                registerFocuser={(fn) => registerFocuser(b.id, fn)}
                onBackspaceEmpty={() => removeEmptyText(b.id)}
              />
            ) : (
              <AgentBlock
                key={b.id}
                block={b}
                docActive
                onChange={(patch) => patchBlock(b.id, patch)}
                onRemove={() => removeBlock(b.id)}
                onExit={(dir) => exitBlock(b.id, dir)}
                registerFocuser={(fn) => registerFocuser(b.id, fn)}
              />
            ),
          )}

          <div className="doc-add-bar">
            <button
              type="button"
              className="doc-add-ai"
              disabled={!tabId}
              onClick={() => void addAgentBlock(null)}
              title={tabId ? 'Add an AI block' : 'connecting…'}
            >
              ✦ Ask AI
            </button>
            <span className="doc-add-hint">or type “/ai” on an empty line</span>
          </div>
        </div>
      </main>
    </div>
  );
}

/** An auto-growing prose block. Typing "/ai" on its own line + Enter summons an
 *  agent block; arrowing past the top/bottom edge moves to the adjacent block. */
function TextBlock({
  block,
  onChange,
  onSlashAi,
  canAddAi,
  onExit,
  registerFocuser,
  onBackspaceEmpty,
}: {
  block: TextBlockModel;
  onChange: (content: string) => void;
  onSlashAi: () => void;
  canAddAi: boolean;
  onExit: (dir: 'up' | 'down') => void;
  registerFocuser: (fn: ((edge: 'start' | 'end') => void) | null) => void;
  onBackspaceEmpty: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to fit content — a note, not a fixed box. block.content is an
  // intentional re-run trigger (re-measure on every edit), not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize-on-content-change
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [block.content]);

  // Let the document key INTO this block, caret at the requested edge.
  useEffect(() => {
    registerFocuser((edge) => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const pos = edge === 'start' ? 0 : el.value.length;
      el.setSelectionRange(pos, pos);
    });
    return () => registerFocuser(null);
  }, [registerFocuser]);

  return (
    <textarea
      ref={ref}
      className="doc-text-block"
      value={block.content}
      placeholder="Write…"
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        const el = e.currentTarget;
        const caret = el.selectionStart ?? 0;
        const collapsed = caret === (el.selectionEnd ?? caret);
        // Boundary arrows spill into the adjacent block (position 0 / very end).
        if (e.key === 'ArrowUp' && collapsed && caret === 0) {
          e.preventDefault();
          onExit('up');
          return;
        }
        if (e.key === 'ArrowDown' && collapsed && caret === el.value.length) {
          e.preventDefault();
          onExit('down');
          return;
        }
        if (e.key === 'Backspace' && el.value === '') {
          e.preventDefault();
          onBackspaceEmpty();
          return;
        }
        if (e.key !== 'Enter' || e.shiftKey || !canAddAi) return;
        // "/ai" (or "/ask") alone on the current line → summon an agent block.
        const upto = el.value.slice(0, caret);
        const line = upto.slice(upto.lastIndexOf('\n') + 1).trim();
        if (line === '/ai' || line === '/ask') {
          e.preventDefault();
          const start = upto.lastIndexOf('\n') + 1;
          onChange(el.value.slice(0, start) + el.value.slice(caret));
          onSlashAi();
        }
      }}
    />
  );
}
