import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpUrl, parseArgs } from './browser-probe.mjs';

test('several --eval flags are kept in order, and an expression may contain = and newlines', () => {
  const o = parseArgs([
    'http://x/',
    '--eval=a = 1',
    '--eval=document.title\n.length',
    '--until=window.ready',
  ]);
  assert.deepEqual(o.evals, ['a = 1', 'document.title\n.length']);
  assert.equal(o.until, 'window.ready');
  assert.equal(o.url, 'http://x/');
});

test('size and timeout are parsed; bad values are refused, not guessed', () => {
  const o = parseArgs(['http://x/', '--size=390x844', '--timeout=5']);
  assert.deepEqual(o.size, { width: 390, height: 844 });
  assert.equal(o.timeoutMs, 5000);
  assert.match(parseArgs(['http://x/', '--size=wide']).error, /WxH/);
  assert.match(parseArgs(['http://x/', '--timeout=0']).error, /seconds/);
});

test('one url per probe, and an unknown flag is an error', () => {
  assert.match(parseArgs([]).error, /url is required/);
  assert.match(parseArgs(['http://a/', 'http://b/']).error, /one url/);
  assert.match(parseArgs(['http://a/', '--wait=3']).error, /unknown flag --wait/);
  assert.match(parseArgs(['http://a/', '--verbose']).error, /unknown flag/);
});

test('the endpoint is THIS pane browser, and there is none outside a pane', () => {
  assert.equal(
    cdpUrl({ MUXPAD_TAB_ID: '01ABC', MUXPAD_API_URL: 'http://127.0.0.1:7777/' }),
    'http://127.0.0.1:7777/api/browsers/s-01ABC/cdp',
  );
  assert.equal(cdpUrl({}), null);
});
