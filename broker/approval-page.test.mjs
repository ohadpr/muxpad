import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * WHAT THE APPROVAL PAGE PROMISES, pinned.
 *
 * The page is the only thing a human reads before granting access, and it is
 * served from the broker's own origin precisely so that an agent cannot write
 * it. That makes its TEXT part of the security boundary: a prompt that
 * describes a wider grant than it makes trains somebody to skim, and one that
 * describes a narrower grant than it makes is a lie.
 *
 * Asserted on the source rather than through a browser, because what is being
 * checked is the claim, not the rendering.
 */
const HTML = readFileSync(new URL('./shell.html', import.meta.url), 'utf8');
const JS = readFileSync(new URL('./shell.js', import.meta.url), 'utf8');

test('the dialog shows which machine asked', () => {
  // A timed grant is bound to the origin, so it belongs in front of the human
  // making that grant.
  assert.match(HTML, /id="origin"/);
  assert.match(JS, /\$\('origin'\)\.textContent = request\.origin/);
});

test('the promise it prints names the origin it is actually scoped to', () => {
  // "Full Slack access for 1 day" was true of every agent everywhere. It is
  // now scoped, and the sentence has to say so or it is describing the old
  // grant.
  const describe = JS.slice(JS.indexOf('function describeDuration'), JS.indexOf("$('duration').onchange"));
  assert.match(describe, /for chats on \$\{current\.origin/);
});

test('it describes a read-only grant as read-only, and says what is NOT covered', () => {
  const describe = JS.slice(JS.indexOf('function describeDuration'), JS.indexOf("$('duration').onchange"));
  assert.match(describe, /Reading only/);
  // The half that matters: naming the verbs the grant does not include.
  assert.match(describe, /Sending, editing, deleting, reacting and uploading are NOT covered/);
});

test('it offers no duration for a request the broker would refuse to time', () => {
  // Offering a choice the broker rejects is how a prompt teaches somebody that
  // its own words are approximate.
  assert.match(JS, /option\.hidden = option\.value !== 'once' && request\.timedAllowed === false/);
});

test('it sends the scope it displayed, not a hardcoded one', () => {
  // The broker refuses a mismatch rather than substituting, so these two
  // cannot drift into approving something other than what was read.
  assert.match(JS, /scope: current\?\.timedScope \?\? 'slack-team-all-v2'/);
  assert.doesNotMatch(
    JS.slice(JS.indexOf('const duration = decision ===')),
    /scope: 'slack-team-all-v2'/,
  );
});

test('the review page stands alone — it does not wrap muxpad', () => {
  // The owner's objection to the shell was it serving the whole app. /review
  // hides the iframe and shows approvals only, which is the version they
  // agreed to: muxpad rings the bell, the broker draws the dialog.
  assert.match(JS, /\$\('muxpad'\)\.hidden = reviewOnly/);
});

/**
 * …AND IT NAMES THE RIGHT SYSTEM.
 *
 * Everything above was written when Slack was the only thing behind this
 * page. A dialog that says "Slack" above a request to read somebody's mail
 * archive is not merely vague — it is a confident claim about what is being
 * approved, which is the one thing an approval prompt must never get wrong.
 */
const CSS = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');

test('the brand pair follows the request, not a default', () => {
  assert.match(JS, /document\.body\.dataset\.capability = capability/);
  // The capability comes from the ACTION, so it cannot disagree with what is
  // about to run.
  assert.match(JS, /String\(request\.action \|\| ''\)\.split\('\.'\)\[0\]/);
  assert.match(HTML, /class="brand-pair brand-archive"/);
  assert.match(CSS, /body\[data-capability="msgvault"\] \.brand-pair:not\(\.brand-archive\)/);
});

test('every msgvault verb has a title that names what is read', () => {
  // "Search" is a verb with no object, and approving a verb with no object is
  // approving nothing. Each title says what is being reached for.
  const titles = JS.slice(JS.indexOf('const titles = {'));
  const body = titles.slice(0, titles.indexOf('};'));
  for (const action of [
    'msgvault.search',
    'msgvault.show-message',
    'msgvault.show-thread',
    'msgvault.list-senders',
    'msgvault.stats',
    'msgvault.meetings',
    'msgvault.person',
  ]) {
    const line = new RegExp(`'${action}':\\s*'([^']+)'`).exec(body);
    assert.ok(line, `${action} has no title`);
    assert.ok(line[1].length > 8, `${action} title is too thin: ${line[1]}`);
  }
  // …and the fallback is not Slack's when the request is not Slack's.
  assert.match(JS, /isSlack \? 'Approve Slack action' : 'Approve archive access'/);
});

test('the context line does not call the archive a Slack team', () => {
  assert.match(JS, /isSlack \? 'Slack team ' : 'msgvault — '/);
});
