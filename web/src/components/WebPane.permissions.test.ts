import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WHAT A PAGE IN A WEB PANE IS ALLOWED TO ASK FOR.
 *
 * A cross-origin frame with no `allow` attribute cannot even ASK for the
 * camera, the microphone or the screen: the browser refuses before the user
 * sees anything. `getDisplayMedia` answers "Invalid security origin", which is
 * indistinguishable, from inside the page, from the page being broken — that
 * is how this was found, testing a screen-capture page in a muxpad web pane.
 *
 * DELEGATION IS NOT CONSENT, and that is the whole argument for the list
 * below: every entry still costs a prompt or a picker at the moment of use.
 * What the attribute decides is whether the question reaches the user at all.
 *
 * Asserted as source text because the alternative is a jsdom that does not
 * implement permissions policy at all — it would render the attribute and tell
 * us nothing. The real check ran in a browser: a frame WITHOUT the attribute
 * refuses getDisplayMedia, a frame WITH it reaches the picker.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PANES = ['UrlPane.tsx', 'ShellPaneBody.tsx'];
const src = (f: string) => readFileSync(join(HERE, f), 'utf8');
/** Prose about a declaration is not a declaration. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('a page in a web pane can ask for capture', () => {
  for (const file of PANES) {
    it(`${file} delegates the capture permissions`, () => {
      const body = code(src(file));
      const allow = /allow="([^"]+)"/.exec(body)?.[1] ?? '';
      expect(allow, `${file} has no allow attribute`).not.toBe('');
      for (const feature of ['display-capture', 'microphone', 'camera'])
        expect(allow).toContain(feature);
    });

    it(`${file} does not hand over the clipboard it was never offered`, () => {
      // clipboard-WRITE is a paste into the page the user asked for;
      // clipboard-READ hands over what they were doing elsewhere.
      const allow = /allow="([^"]+)"/.exec(code(src(file)))?.[1] ?? '';
      expect(allow).not.toContain('clipboard-read');
    });

    it(`${file} keeps its sandbox`, () => {
      // The permissions are a separate axis from the sandbox: granting the
      // first must never quietly relax the second.
      const body = code(src(file));
      expect(body).toContain('sandbox="allow-scripts allow-same-origin');
      expect(body).not.toContain('allow-top-navigation');
    });
  }
});
