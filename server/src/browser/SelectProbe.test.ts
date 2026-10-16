/** @vitest-environment jsdom */
/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SELECT_MARK,
  applySelectChoice,
  clearSelectMark,
  clearSelectMarkExpression,
  describeSelectAt,
  selectAtExpression,
  selectChoiceExpression,
} from './SelectProbe.js';

/**
 * A native `<select>` popup is drawn by the BROWSER, not by the page, so the
 * screencast never captures it: tapping a dropdown in the viewer sends a good
 * click to a good element and nothing appears at all. The list is therefore
 * read out of the page, drawn by the viewer, and the answer applied back here.
 */

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * jsdom has no layout and therefore no `elementFromPoint` at all, so the hit
 * test is posed rather than measured. What is under test is what the probe does
 * with the answer, not the browser's hit testing.
 */
function hits(el: Element | null) {
  (
    document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
  ).elementFromPoint = () => el;
}

const parse = (raw: string) => (raw ? (JSON.parse(raw) as ReturnType<typeof JSON.parse>) : null);

describe('describing the drop-down under a tap', () => {
  it('reads the options, and which one is on', () => {
    document.body.innerHTML = `
      <select id="s">
        <option value="eu">Europe</option>
        <option value="us" selected>United States</option>
      </select>`;
    hits(document.getElementById('s'));
    const d = parse(describeSelectAt(10, 10, SELECT_MARK));
    expect(d.options).toEqual([
      { v: 'eu', l: 'Europe', selected: false, disabled: false },
      { v: 'us', l: 'United States', selected: true, disabled: false },
    ]);
    expect(d.multiple).toBe(false);
  });

  it('finds the select when the tap landed on the text INSIDE it', () => {
    document.body.innerHTML = '<select id="s"><option value="a">A</option></select>';
    const option = document.querySelector('option');
    hits(option);
    expect(parse(describeSelectAt(10, 10, SELECT_MARK)).options).toHaveLength(1);
  });

  it('descends into a shadow root, where half the design systems keep theirs', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<select><option value="x">Ex</option></select>';
    const inner = root.querySelector('select') as HTMLSelectElement;
    hits(host);
    // elementFromPoint on the document returns the HOST; the shadow root's own
    // hit test is what finds the control.
    (root as unknown as { elementFromPoint: unknown }).elementFromPoint = () => inner;
    const d = parse(describeSelectAt(10, 10, SELECT_MARK));
    expect(d.options[0]).toMatchObject({ v: 'x', l: 'Ex' });
  });

  it('says NOTHING for a tap that is not on a select at all', () => {
    document.body.innerHTML = '<button id="b">go</button>';
    hits(document.getElementById('b'));
    expect(describeSelectAt(10, 10, SELECT_MARK)).toBe('');
  });

  it('keeps a blank placeholder option, drawn as something you can aim at', () => {
    // A placeholder row is a real choice — going BACK to "none" is a thing
    // people do — and an empty line is a target nobody can hit.
    document.body.innerHTML =
      '<select id="s"><option value=""></option><option value="a">A</option></select>';
    hits(document.getElementById('s'));
    const d = parse(describeSelectAt(10, 10, SELECT_MARK));
    expect(d.options[0]).toMatchObject({ v: '', l: '—' });
  });

  it('carries the disabled flag, so the sheet does not offer a dead row', () => {
    document.body.innerHTML = '<select id="s"><option value="a" disabled>A</option></select>';
    hits(document.getElementById('s'));
    expect(parse(describeSelectAt(10, 10, SELECT_MARK)).options[0].disabled).toBe(true);
  });

  it('names the field from its LABEL, falling back to the name attribute', () => {
    document.body.innerHTML =
      '<label for="s">Billing country</label><select id="s" name="country"><option>A</option></select>';
    hits(document.getElementById('s'));
    expect(parse(describeSelectAt(10, 10, SELECT_MARK)).label).toBe('Billing country');

    document.body.innerHTML = '<select id="s2" name="region"><option>A</option></select>';
    hits(document.getElementById('s2'));
    expect(parse(describeSelectAt(10, 10, SELECT_MARK)).label).toBe('region');
  });

  it('says when it is a MULTI-select or a list box, which already work', () => {
    // Neither is a popup: both render INSIDE the page, so the screencast shows
    // them and a sheet drawn over the top would be the only thing in the way.
    document.body.innerHTML = '<select id="s" multiple><option>A</option></select>';
    hits(document.getElementById('s'));
    expect(parse(describeSelectAt(10, 10, SELECT_MARK)).multiple).toBe(true);

    document.body.innerHTML = '<select id="s2" size="4"><option>A</option></select>';
    hits(document.getElementById('s2'));
    expect(parse(describeSelectAt(10, 10, SELECT_MARK)).size).toBe(4);
  });

  it('STAMPS the element, because the page may re-render before the answer comes', () => {
    // The tap and the choice are separated by however long somebody takes to
    // read a list. Any selector built from position is invalid by then on a
    // page that re-renders; a stamp survives the surrounding tree changing.
    document.body.innerHTML = '<select id="s"><option value="a">A</option></select>';
    hits(document.getElementById('s'));
    describeSelectAt(10, 10, SELECT_MARK);
    expect(document.getElementById('s')?.hasAttribute(SELECT_MARK)).toBe(true);
  });
});

describe('applying the choice', () => {
  function posed() {
    document.body.innerHTML = `
      <select id="s" ${SELECT_MARK}="1">
        <option value="eu">Europe</option>
        <option value="us" selected>United States</option>
      </select>`;
    return document.getElementById('s') as HTMLSelectElement;
  }

  it('sets the value on the stamped select', () => {
    const el = posed();
    expect(applySelectChoice('eu', SELECT_MARK)).toBe(true);
    expect(el.value).toBe('eu');
  });

  it('fires input AND change — a value with no events is one the site ignores', () => {
    // On a controlled React select, a bare assignment is re-rendered straight
    // back over the top. Measured: the first version did exactly that and the
    // page snapped to its old value.
    const el = posed();
    const seen: string[] = [];
    for (const type of ['input', 'change']) {
      el.addEventListener(type, (e) => seen.push(`${e.type}:${e.bubbles}`));
    }
    applySelectChoice('eu', SELECT_MARK);
    expect(seen).toEqual(['input:true', 'change:true']);
  });

  it('REMOVES the stamp, so the page is not left wearing it', () => {
    const el = posed();
    applySelectChoice('eu', SELECT_MARK);
    expect(el.hasAttribute(SELECT_MARK)).toBe(false);
  });

  it('removes the stamp even when the page throws on the way', () => {
    // A stamp left behind outlives the sheet that put it there, and the next
    // choice would then be applied to the wrong element.
    const el = posed();
    el.focus = () => {
      throw new Error('page said no');
    };
    expect(() => applySelectChoice('eu', SELECT_MARK)).toThrow();
    expect(el.hasAttribute(SELECT_MARK)).toBe(false);
  });

  it('finds a stamped select inside a shadow root', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<select ${SELECT_MARK}="1"><option value="x">Ex</option><option value="y">Why</option></select>`;
    expect(applySelectChoice('y', SELECT_MARK)).toBe(true);
    expect((root.querySelector('select') as HTMLSelectElement).value).toBe('y');
  });

  it('says so when the select has gone — the page navigated under the sheet', () => {
    document.body.innerHTML = '<p>a different page</p>';
    expect(applySelectChoice('eu', SELECT_MARK)).toBe(false);
  });
});

describe('a sheet nobody chose from', () => {
  it('leaves no stamp behind', () => {
    document.body.innerHTML = `<select id="s" ${SELECT_MARK}="1"><option>A</option></select>`;
    clearSelectMark(SELECT_MARK);
    expect(document.getElementById('s')?.hasAttribute(SELECT_MARK)).toBe(false);
  });
});

describe('the expressions the host actually evaluates', () => {
  it('ship the same text as the tested functions', () => {
    expect(selectAtExpression(3, 4)).toContain(describeSelectAt.toString());
    expect(selectChoiceExpression('x')).toContain(applySelectChoice.toString());
    expect(clearSelectMarkExpression()).toContain(clearSelectMark.toString());
  });

  it('bake their arguments in as JSON, not as string concatenation', () => {
    // A value is page content — an option labelled `') || alert('` is a bug
    // report waiting to happen, in an expression evaluated with Runtime.evaluate.
    const expr = selectChoiceExpression("it's \" '); drop");
    expect(expr).toContain(JSON.stringify("it's \" '); drop"));
    expect(selectAtExpression(Number.NaN, 4)).toContain('(NaN, 4,');
  });
});
