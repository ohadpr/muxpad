import { beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_CHAT_ATTR,
  DRAFT_TOKEN_ATTR,
  caretRange,
  draftChipSignature,
  draftNodes,
  offsetOf,
  readDraft,
  readDraftText,
  renderedChipSignature,
} from './chat-draft';
import type { MentionChat } from './chat-mention';

/**
 * THE ARITHMETIC BETWEEN A STRING AND AN EDITABLE.
 *
 * The composer's draft is a string; the thing the user's caret is actually in is
 * a DOM child list where one mention is ONE node standing for ten characters.
 * Everything that feature depends on — which `@…` run the picker is showing,
 * where a picked mention's caret lands, whether the send button is enabled —
 * counts characters, so every one of them is downstream of the two functions
 * here. They are pure and they are the whole risk, which is why they are tested
 * without mounting a composer.
 */

const chat = (tabId: string, tabName: string): MentionChat => ({
  tabId,
  tabSlug: tabId,
  tabName,
  workspaceId: 'w',
  workspaceSlug: 'w',
  workspaceName: 'W',
  paneIds: [`${tabId}-pane`],
  chip: { name: tabName, icon: '📈' },
});

const CORPUS = [chat('t1', 'Investing'), chat('t2', 'Main repo'), chat('t3', 'Main')];

/** An editable holding `text`, laid out the way ChatDraft lays one out. */
function editable(text: string, corpus: readonly MentionChat[] = CORPUS): HTMLDivElement {
  const el = document.createElement('div');
  for (const node of draftNodes(text, corpus)) {
    if (node.kind === 'text') {
      if (node.text) el.append(document.createTextNode(node.text));
      continue;
    }
    const host = document.createElement('span');
    host.contentEditable = 'false';
    host.setAttribute(DRAFT_TOKEN_ATTR, node.token);
    host.setAttribute(DRAFT_CHAT_ATTR, node.chat.tabId);
    // The rendered pill, whose text is emphatically NOT the token — that is the
    // trap every function here has to not fall into.
    host.append(document.createTextNode(`📈 ${node.chat.tabName}`));
    el.append(host);
  }
  document.body.append(el);
  return el;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('the draft is laid out by the same rule the log renders by', () => {
  it('splits prose from the mentions in it', () => {
    expect(draftNodes('Ask @Investing about cash', CORPUS)).toEqual([
      { kind: 'text', text: 'Ask ' },
      { kind: 'mention', token: '@Investing', chat: CORPUS[0] },
      { kind: 'text', text: ' about cash' },
    ]);
  });

  it('leaves an `@word` that resolves to nothing as text', () => {
    // The correct degradation, and the same one parseMentions ships: a chip is
    // for a chat that exists, and a draft may contain any `@` the user likes.
    expect(draftNodes('email me @sam later', CORPUS)).toEqual([
      { kind: 'text', text: 'email me @sam later' },
    ]);
  });

  it('prefers the LONGEST name, so `@Main repo` is never the chat called Main', () => {
    const nodes = draftNodes('@Main repo status', CORPUS);
    expect(nodes[0]).toEqual({ kind: 'mention', token: '@Main repo', chat: CORPUS[1] });
  });
});

describe('a rebuild is decided by the chips, not by the prose', () => {
  it('is unchanged by typing around a mention — the caret-preserving case', () => {
    const a = draftChipSignature(draftNodes('@Investing cash', CORPUS));
    const b = draftChipSignature(draftNodes('@Investing cash position today', CORPUS));
    expect(a).toBe(b);
  });

  it('changes when a mention appears', () => {
    expect(draftChipSignature(draftNodes('@Investin', CORPUS))).not.toBe(
      draftChipSignature(draftNodes('@Investing', CORPUS)),
    );
  });

  it('changes when the same TOKEN resolves to a different chat', () => {
    // Two chats can share a name; the token alone cannot tell the rebuild that
    // the chip now points somewhere else.
    const twins = [chat('a', 'Work review'), chat('b', 'Work review')];
    expect(draftChipSignature(draftNodes('@Work review', [twins[0] as MentionChat]))).not.toBe(
      draftChipSignature(draftNodes('@Work review', [twins[1] as MentionChat])),
    );
  });

  it('agrees with what is actually rendered', () => {
    const text = 'Ask @Investing and @Main repo';
    const el = editable(text);
    expect(renderedChipSignature(el)).toBe(draftChipSignature(draftNodes(text, CORPUS)));
  });
});

describe('reading the string back out of the editable', () => {
  it('counts a chip as its TOKEN, not as the pill drawn inside it', () => {
    // The pill reads "📈 Investing"; the string says "@Investing". Getting this
    // wrong would silently rewrite the user's message on every render.
    expect(readDraftText(editable('Ask @Investing about cash'))).toBe('Ask @Investing about cash');
  });

  it('ignores the bogus trailing <br> browsers leave behind', () => {
    // Without this an "empty" composer reads as "\n", which is not empty, which
    // re-enables the send button on a blank message.
    const el = editable('');
    el.append(document.createElement('br'));
    expect(readDraftText(el)).toBe('');
  });

  it('keeps a <br> that is not the last thing in the box', () => {
    const el = editable('a');
    el.append(document.createElement('br'));
    el.append(document.createTextNode('b'));
    expect(readDraftText(el)).toBe('a\nb');
  });
});

describe('a DOM position, as an offset into the string', () => {
  it('inside a text node', () => {
    const el = editable('Ask @Investing now');
    expect(offsetOf(el, el.childNodes[0] as Node, 2)).toBe(2);
  });

  it('inside the text AFTER a chip — the offset the chip stands for is counted', () => {
    const el = editable('Ask @Investing now');
    // 'Ask ' (4) + '@Investing' (10) = 14, then 3 characters of ' now'.
    expect(offsetOf(el, el.childNodes[2] as Node, 3)).toBe(17);
  });

  it('as a child index of the editable — what the browser reports beside a chip', () => {
    const el = editable('Ask @Investing now');
    expect(offsetOf(el, el, 2)).toBe(14);
  });

  it('inside the chip resolves to its FAR edge, never to a position within it', () => {
    // Clicking the emoji must put the caret beside the chip. A chip is atomic:
    // there is no such thing as "three characters into @Investing".
    const el = editable('Ask @Investing now');
    const pill = (el.childNodes[1] as HTMLElement).firstChild as Node;
    expect(offsetOf(el, pill, 1)).toBe(14);
  });

  it('a node from somewhere else reports the END, not 0', () => {
    // "I do not know where the caret is" must not read as "at the start", which
    // would open the picker over a mention at the head of an unfocused draft.
    const el = editable('Ask @Investing now');
    expect(offsetOf(el, document.createElement('div'), 0)).toBe(18);
  });
});

describe('an offset, as a DOM position', () => {
  it('lands in a text node so the next character has somewhere to go', () => {
    const el = editable('Ask @Investing now');
    const at = caretRange(el, 2);
    expect(at.node.nodeType).toBe(Node.TEXT_NODE);
    expect(at.offset).toBe(2);
  });

  it('at a chip’s trailing edge, prefers the text that follows it', () => {
    // Expressible as "after child 1" too, and that form gives the browser no
    // text node to put the caret in — so the next typed character lands nowhere.
    const el = editable('Ask @Investing now');
    const at = caretRange(el, 14);
    expect(at.node).toBe(el.childNodes[2]);
    expect(at.offset).toBe(0);
  });

  it('at a chip’s trailing edge with nothing after it, lands past the chip', () => {
    const el = editable('Ask @Investing');
    const at = caretRange(el, 14);
    expect(at.node).toBe(el);
    expect(at.offset).toBe(2);
  });

  it('inside a chip snaps to the nearer edge', () => {
    const el = editable('Ask @Investing now');
    expect(caretRange(el, 5)).toEqual({ node: el, offset: 1 }); // 1 char in → before
    expect(caretRange(el, 13)).toEqual({ node: el, offset: 2 }); // 9 in → after
  });

  it('past the end lands at the end', () => {
    const el = editable('Ask @Investing');
    expect(caretRange(el, 999)).toEqual({ node: el, offset: el.childNodes.length });
  });

  it('round-trips every offset in a draft that has a chip in the middle', () => {
    // The property the whole feature rests on. If any offset maps to a position
    // that maps back to a different offset, the `@` picker opens over the wrong
    // run and a picked mention puts the caret in the wrong place.
    const text = 'Ask @Investing about cash';
    const el = editable(text);
    for (let i = 0; i <= text.length; i++) {
      const at = caretRange(el, i);
      const back = offsetOf(el, at.node, at.offset);
      // Inside the chip's token there is no faithful position, and the contract
      // is the nearer edge — everywhere else it is exact.
      const insideChip = i > 4 && i < 14;
      if (!insideChip) expect(back).toBe(i);
      else expect([4, 14]).toContain(back);
    }
  });
});

describe('readDraft', () => {
  it('reports the caret when the selection is inside the field', () => {
    const el = editable('Ask @Investing now');
    const range = document.createRange();
    range.setStart(el.childNodes[2] as Node, 2);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    expect(readDraft(el, sel)).toEqual({ text: 'Ask @Investing now', caret: 16 });
  });

  it('reports the END when the selection is somewhere else entirely', () => {
    const el = editable('Ask @Investing now');
    expect(readDraft(el, null)).toEqual({ text: 'Ask @Investing now', caret: 18 });
  });
});
