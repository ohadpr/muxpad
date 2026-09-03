import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RecentFolder } from '../api';
import { ChatReadyGreeting, FolderChoice, HarnessLaunchCard } from './ChatPane';

/**
 * The two halves of "converting an empty chat gives no feedback and no
 * choices":
 *
 *  1. A converted pane must LOOK different. Conversion is in place — same pane,
 *     same position, same size — so the greeting is the only surface where the
 *     change can show, and it used to be identical before and after.
 *  2. Folder and model must be offered AT the moment of choosing, pre-answered
 *     so the common case stays one tap.
 *
 * Rendered to static markup (no DOM library): the assertions are about what the
 * browser is actually handed.
 */
const html = renderToStaticMarkup;

const FOLDERS: RecentFolder[] = [
  { path: '/Users/me/dev/muxpad', name: 'muxpad', short: '~/dev/muxpad', hasProject: true },
  { path: '/Users/me/scratch', name: 'scratch', short: '~/scratch', hasProject: false },
];

describe('the empty chat names what is running in it', () => {
  const greet = (assistant: string, cwd: string | null = '/Users/me/dev/muxpad') =>
    html(
      <ChatReadyGreeting assistant={assistant} cwd={cwd} converted={null} refusal={null} />,
    );

  it('a Codex pane and a Claude pane do not render the same thing', () => {
    // This is the whole defect: conversion left the screen byte-identical.
    expect(greet('codex')).not.toBe(greet('claude'));
    expect(greet('codex')).toContain('Codex');
    expect(greet('claude')).toContain('Claude');
    expect(greet('cursor')).toContain('Cursor');
  });

  it('shows the working folder, so a folder choice is visible too', () => {
    expect(greet('claude')).toContain('/Users/me/dev/muxpad');
    // …and degrades quietly when the server hasn’t told us one.
    expect(greet('claude', null)).not.toContain('chat-empty-ident-cwd');
  });

  it('confirms a conversion, naming the harness, model and folder chosen', () => {
    const out = html(
      <ChatReadyGreeting
        assistant="codex"
        cwd="/Users/me/dev/muxpad"
        converted={{ backend: 'codex', cwd: '/Users/me/dev/muxpad', model: 'gpt-5-codex' }}
        refusal={null}
      />,
    );
    expect(out).toContain('Now running Codex');
    expect(out).toContain('gpt-5-codex');
    // <output> is the live region — announced without stealing the composer's
    // focus.
    expect(out).toMatch(/<output class="chat-convert-confirm"/);
  });

  it('omits the model from the receipt when none was pinned', () => {
    const out = html(
      <ChatReadyGreeting
        assistant="claude"
        cwd="/Users/me/dev/muxpad"
        converted={{ backend: 'claude', cwd: '/Users/me/dev/muxpad', model: null }}
        refusal={null}
      />,
    );
    expect(out).toContain('Now running Claude');
    expect(out).toContain('/Users/me/dev/muxpad');
  });

  it('surfaces the server’s refusal verbatim', () => {
    const out = html(
      <ChatReadyGreeting
        assistant="claude"
        cwd={null}
        converted={null}
        refusal="this chat already has messages — open a new tab instead"
      />,
    );
    expect(out).toContain('this chat already has messages — open a new tab instead');
    expect(out).toContain('chat-convert-refusal');
  });
});

describe('the launch card', () => {
  const card = (over: Partial<Parameters<typeof HarnessLaunchCard>[0]> = {}) =>
    html(
      <HarnessLaunchCard
        backend="claude"
        folders={FOLDERS}
        models={[
          { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-4-8' },
          { value: 'sonnet', displayName: 'Sonnet' },
        ]}
        paneCwd="/Users/me/dev/muxpad"
        cwd="/Users/me/dev/muxpad"
        setCwd={() => {}}
        model={null}
        setModel={() => {}}
        busy={false}
        error={null}
        onCancel={() => {}}
        onStart={() => {}}
        {...over}
      />,
    );

  it('arrives pre-answered — one tap is a complete choice', () => {
    const out = card();
    // The pane's own folder is the selected chip…
    expect(out).toMatch(/aria-pressed="true"[^>]*title="\/Users\/me\/dev\/muxpad"/);
    // …and "Default" is the selected model, so nothing is pinned unless asked.
    expect(out).toMatch(/aria-pressed="true"[^>]*>Default</);
    expect(out).toContain('Start Claude');
  });

  it('offers the pane’s OWN folder even when it is not in the recent list', () => {
    // "Leave it where it is" is the most likely answer and must never be the
    // one option you cannot tap.
    const out = card({ paneCwd: '/Users/me/somewhere-else', cwd: '/Users/me/somewhere-else' });
    expect(out).toContain('somewhere-else');
    expect(out).toMatch(/aria-pressed="true"[^>]*title="\/Users\/me\/somewhere-else"/);
  });

  it('offers recent folders as one-tap options, with the path that disambiguates', () => {
    const out = card();
    expect(out).toContain('muxpad');
    expect(out).toContain('~/dev/muxpad');
    expect(out).toContain('scratch');
    expect(out).toContain('~/scratch');
  });

  it('offers the models we know about, and marks the chosen one', () => {
    const out = card({ model: 'opus' });
    expect(out).toContain('Opus');
    expect(out).toContain('Sonnet');
    expect(out).toMatch(/aria-pressed="true"[^>]*>Opus</);
    // The concrete id an alias resolves to is available on hover.
    expect(out).toContain('claude-opus-4-8');
  });

  it('never draws Default twice', () => {
    // Claude's own list contains a literal `default` entry; the card already
    // has a Default pill meaning "pass no --model". Two identical buttons, one
    // of which would pin the string 'default' as a model id.
    const out = card({
      models: [
        { value: 'default', displayName: 'Default' },
        { value: 'opus', displayName: 'Opus' },
      ],
    });
    expect(out.match(/>Default</g)).toHaveLength(1);
  });

  it('with no known models it still offers Default — never a guessed list', () => {
    const out = card({ models: [] });
    expect(out).toContain('Default');
    expect(out).not.toContain('Opus');
  });

  it('warns only about a folder it actually knows lacks project context', () => {
    expect(card({ cwd: '/Users/me/scratch' })).toContain('No project context here');
    expect(card({ cwd: '/Users/me/dev/muxpad' })).not.toContain('No project context here');
    // A path we were never told about gets no warning rather than a guess.
    expect(card({ cwd: '/somewhere/unknown' })).not.toContain('No project context here');
  });

  it('says what it is doing while it does it, and locks the controls', () => {
    const out = card({ busy: true });
    expect(out).toContain('Starting Claude…');
    expect(out.match(/disabled=""/g)?.length).toBeGreaterThan(3);
  });

  it('shows a failure without losing the choices', () => {
    const out = card({ error: 'ptyd is unreachable; cannot start the agent' });
    expect(out).toContain('ptyd is unreachable');
    expect(out).toContain('Start Claude');
  });

  it('names the harness it will start', () => {
    expect(card({ backend: 'cursor' })).toContain('Start Cursor');
    expect(card({ backend: 'codex' })).toContain('Start Codex');
  });
});

describe('the folder chooser (shared with the session menu)', () => {
  it('always offers the CURRENT folder, even when it is not in the recent list', () => {
    const out = html(
      <FolderChoice
        inputId="f"
        value="/Users/me/elsewhere"
        onChange={() => {}}
        folders={FOLDERS}
        current="/Users/me/elsewhere"
      />,
    );
    expect(out).toContain('elsewhere');
    expect(out).toMatch(/aria-pressed="true"[^>]*title="\/Users\/me\/elsewhere"/);
  });

  it('does not list the current folder twice when it IS recent', () => {
    const out = html(
      <FolderChoice
        inputId="f"
        value="/Users/me/dev/muxpad"
        onChange={() => {}}
        folders={FOLDERS}
        current="/Users/me/dev/muxpad"
      />,
    );
    expect(out.match(/~\/dev\/muxpad/g)).toHaveLength(1);
  });

  it('treats a trailing slash as the same folder', () => {
    const out = html(
      <FolderChoice
        inputId="f"
        value="/Users/me/dev/muxpad/"
        onChange={() => {}}
        folders={FOLDERS}
        current={null}
      />,
    );
    expect(out).toMatch(/aria-pressed="true"[^>]*title="\/Users\/me\/dev\/muxpad"/);
  });
});

/**
 * Two properties that live in the SHAPE of ChatPane rather than in any
 * component's props, and whose regressions are silent. Asserted against the
 * source because there is no other honest way to reach them without booting a
 * WebSocket.
 */
describe('the empty state’s wiring', () => {
  const src = readFileSync(join(import.meta.dirname, 'ChatPane.tsx'), 'utf8');

  it('renders the refusal in BOTH empty-state branches', () => {
    // A 409 flips hasMessages, which instantly re-routes to the "Loading
    // conversation…" branch — so a refusal rendered in only one of them is a
    // refusal the user never sees. That was the bug.
    const at = src.indexOf('if (hasMessages)');
    expect(at).toBeGreaterThan(0);
    const loading = src.slice(at, at + 600);
    expect(loading).toContain('Loading conversation…');
    expect(loading).toContain('convertRefusal');
    expect(src).toContain('refusal={convertRefusal}');
  });

  it('says a refusal ONCE — the banner owns it, the strip does not repeat it', () => {
    const at = src.indexOf('if (refused) {');
    expect(at).toBeGreaterThan(0);
    const branch = src.slice(at, at + 500);
    expect(branch).toContain('setConvertRefusal(message)');
    // setPickError lives in the `else`, so a refused conversion cannot print
    // the same sentence in two places.
    expect(branch.indexOf('} else {')).toBeLessThan(branch.indexOf('setPickError(message)'));
  });

  it('never offers conversion on a chat with QUEUED messages', () => {
    // The server refuses on a TRANSCRIPT; a parked send is not one, so nothing
    // downstream would stop a tap from respawning the runner under it.
    expect(src).toContain('queue.length === 0 ? (');
  });
});
