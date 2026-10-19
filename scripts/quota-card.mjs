#!/usr/bin/env node
/**
 * THE QUOTA CARD — one line per subscription, pinned above the chat.
 *
 * CLAUDE comes from `AccountPool.record`, which keeps the `utilization` the
 * SDK reports on every turn. Nothing kept it before: the failover path read
 * the same event and threw everything but the yes/no away.
 *
 * CODEX reports its own, and already did — `rate_limits.primary.used_percent`
 * in the rollout file of every session under ~/.codex/sessions. No plumbing
 * was needed, only somebody reading it.
 *
 * THE NUMBER IS A PERCENTAGE, 0–100. Codex says so in the field name
 * (`used_percent: 37.0`); Anthropic's `utilization` does not, and it matters —
 * 0.41 is either "nearly half gone" or "basically untouched". Two probes three
 * seconds apart moved five_hour from 0.40 to 0.41, a hundredth of a point for
 * one haiku turn, which is the grain of a percentage and far too small to be a
 * hundredth of a whole allowance. The raw value is in the hover title so the
 * reading stays checkable.
 *
 * Pure formatting, no model: a card that costs a completion to redraw is a
 * card nobody can afford to refresh often.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const status = JSON.parse(
  execFileSync('muxpad', ['claude-account', 'status', '--json'], { encoding: 'utf8' }),
);
const cooled = new Set(status.cooldowns.map((c) => `${c.account}:${c.scope}`));
/** A COOLDOWN IS A FULL WINDOW. The pool writes one the moment an account is
 *  refused — `{account:'primary', scope:'all', until_ms, reason:"Observed
 *  Claude weekly limit: resets Oct 21 at 1pm"}` — and that is a complete
 *  answer to "how much is left": none, until then. Reading it here means the
 *  card is right the moment the refusal happens, instead of waiting for a
 *  probe to re-derive what the pool already recorded. */
const blocked = new Map(
  status.cooldowns
    .filter((c) => c.until_ms > Date.now())
    .map((c) => [c.account, { scope: c.scope, until: c.until_ms, reason: c.reason }]),
);

/** THE NEWEST CODEX ROLLOUT THAT CARRIES A READING. Sessions are written under
 *  ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl and the last `rate_limits` in
 *  the newest one is the current answer. Bounded to the newest few days so a
 *  long history is never walked. */
function codex() {
  const root = join(homedir(), '.codex', 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root, 0);
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files.slice(0, 8)) {
    let last = null;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.includes('"rate_limits"')) last = line;
    }
    if (!last) continue;
    const m = /"rate_limits":\s*(\{.*?\})\s*\}\s*\}\s*$/.exec(last) ?? null;
    let rl = null;
    try {
      rl = m ? JSON.parse(m[1]) : (JSON.parse(last).payload?.info?.rate_limits ?? null);
    } catch {
      rl = null;
    }
    const w = rl?.primary;
    if (!w || typeof w.used_percent !== 'number') continue;
    return {
      pct: w.used_percent,
      scope: w.window_minutes ? mins(w.window_minutes) : 'window',
      resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null,
      at: statSync(f).mtimeMs,
    };
  }
  return null;
}
const mins = (n) => (n >= 1440 ? `${Math.round(n / 1440)}d` : `${Math.round(n / 60)}h`);

/** `seven_day_opus` → `7d opus`. The window is the subject; the underscores are not. */
const window = (s) =>
  s
    .replace(/^five_hour$/, '5h')
    .replace(/^seven_day$/, '7d')
    .replace(/^seven_day_(\w+)$/, '7d $1')
    .replace(/_/g, ' ');

const when = (ms) => {
  if (!ms) return '';
  const mins = Math.round((ms - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/**
 * THE BAR GOES RED BEFORE IT IS TOO LATE TO MATTER. 90% is where a long job is
 * likely to hit the wall mid-run; amber at 75 is the warning that still lets
 * you pick the other subscription for free. Below that it stays quiet — a bar
 * coloured all the time is one nobody notices changing.
 *
 * Literal hues, not the app's status tokens: this renders in a sandboxed frame
 * handed --fg/--bg-hover and not the status channel. These three hold on a
 * light and a dark surface alike.
 */
const hue = (pct) => (pct >= 90 ? '#e0574f' : pct >= 75 ? '#c8891f' : '#3aa06a');

/**
 * THE SAME HUE, PULLED TOWARD THE THEME'S OWN INK.
 *
 * A fixed mid-tone cannot clear AA on a light surface AND a dark one: measured
 * on the card as it was, the percentage ran 2.88–3.28:1 on light — the number
 * you are meant to read, failing AA outright — and 4.18 on dark. Mixing toward
 * `--fg` fixes both at once without knowing which theme is in the frame: on a
 * light theme --fg is near-black so the hue darkens, on a dark one it is
 * near-white so it lightens. The hue survives; only its lightness moves.
 *
 * 60% for text and 75% for the fill came out of a search over both themes and
 * all three hues: it is the strongest pair where the worst case still clears
 * 4.5:1 for text. Nothing in the space cleared 3:1 for fill-against-track as
 * well; 2.96 is the ceiling and this sits on it.
 */
const ink = (h) => `color-mix(in srgb, ${h} 60%, var(--fg,#222))`;
const bar = (h) => `color-mix(in srgb, ${h} 75%, var(--fg,#222))`;

/** THE FULLEST WINDOW IS THE ONE THAT STOPS YOU. An account reports several
 *  (5h, 7d, 7d opus); the binding one is whichever is nearest its limit. */
const rows = [];
const NAMES = { primary: 'claude 1', backup: 'claude 2' };
for (const { account, windows } of status.utilization) {
  const cd = blocked.get(account);
  // The cooldown wins when it exists: an account that is being refused right
  // now is full whatever an older reading says.
  const top = cd
    ? { utilization: 100, scope: cd.scope === 'all' ? '7d' : cd.scope, resetsAt: cd.until }
    : (windows[0] ?? null);
  rows.push({
    name: NAMES[account] ?? account,
    cur: status.preferred === account,
    top,
    blocked:
      Boolean(cd) ||
      windows.some((w) => cooled.has(`${account}:${w.scope}`) || w.status === 'rejected'),
  });
}
const cx = codex();
rows.push({
  name: 'codex',
  cur: false,
  top: cx ? { utilization: cx.pct, scope: cx.scope, resetsAt: cx.resetsAt } : null,
  blocked: false,
});

const esc = (t) =>
  String(t).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );

/**
 * ONE LINE, THREE SUBSCRIPTIONS, DOWN TO A PHONE.
 *
 * A row each was already one line apiece, which is not the same thing: three
 * of them is three lines of a card that sits above every message. The whole
 * answer is three numbers, so it gets one line.
 *
 * WHAT GOES WHEN THE WIDTH DOES. The window and its reset (`5h 4h`) are the
 * first to leave — they are detail, and they are on the hover title either
 * way. The bar is next, shrinking to a minimum rather than disappearing,
 * because a bar is the only part of this that can be read without reading.
 * The label and the percentage never shrink: a segment that cannot say WHICH
 * subscription it is about is worse than no segment.
 */
const seg = (r) => {
  const cur = r.cur ? ' class=c' : '';
  if (!r.top)
    return `<span class="s n" title="no reading — the account may not be logged in"><b${cur}>${esc(r.name)}</b><em>—</em></span>`;
  const pct = r.top.utilization;
  // WHOLE NUMBERS, AND ROUNDED UP. A decimal is noise at a glance — the card
  // is a gauge, not a meter — but plain rounding would print 0.68% as "0%",
  // and an empty-looking number is the one wrong answer that gets believed.
  // Ceiling keeps "barely touched" distinct from "untouched", and errs toward
  // the side that makes you check. The exact value stays in the hover title.
  const shown = Math.ceil(pct);
  const reset = when(r.top.resetsAt);
  return `<span class=s title="${esc(r.name)} · ${esc(window(r.top.scope))} ${esc(pct)}%${reset ? ` · resets ${esc(reset)}` : ''}${r.blocked ? ' · blocked' : ''}">
  <b${cur}>${esc(r.name)}</b>
  <i class=t><i style="width:${Math.max(4, Math.min(100, pct))}%;background:${bar(hue(pct))}"></i></i>
  <u style="color:${ink(hue(pct))}">${shown}%</u>
</span>`;
};

const html = `<style>
 .q{display:flex;align-items:center;gap:6px;font:13px/1.25 ui-sans-serif,system-ui;color:var(--fg,#222);overflow:hidden}
 /* CLIPPED AT ITS OWN EDGE, never bleeding into the next — otherwise the
    overflow ran under the neighbouring segment, with the divider hidden
    behind it. WHAT gets clipped is decided below, and it is never a number. */
 /* SIZED BY ITS CONTENT, THEN GIVEN AN EQUAL SHARE OF WHAT IS LEFT OVER.
    A basis of zero was literal equal thirds, and equal thirds is the wrong
    equality: the three segments do not hold the same amount of text, so a
    third was too little for "claude 1 100%" and too much for "codex 61%" —
    the long name ellipsized to "clau…" while the short one sat next to spare
    room. Reported exactly that way: "available space on the right and the
    name of the first Claude subscription is clipped."
    An auto basis asks for the content first and splits only the SLACK three
    ways, so every name is whole for as long as the card can afford it and the
    leftover goes into the bars, which are the part that can use it. */
 .q .s{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 auto;overflow:hidden}
 /* A SEGMENT WITH NOTHING TO SHOW TAKES NOTHING — no bar to spend a share on,
    so it does not get one: a dash and its name, and the width goes to the two
    segments that have a reading. */
 .q .s.n{flex:0 1 auto}
 /* The divider measured 1.44:1 against the card — a line you had to know was
    there. Keyed to --fg so it holds on both themes. */
 .q .s+.s{border-left:1px solid color-mix(in srgb,var(--fg,#222) 22%,transparent);padding-left:6px}
 /* THE LABEL IS THE ONLY TEXT ALLOWED TO LOSE CHARACTERS, and it loses them
    to an ellipsis rather than to a hard edge. Seen on a real phone: the row
    read "claude 1 ● 10" — the 0 and the per-cent sign of 100% cut off by the
    segment's edge, which does not read as truncation, it reads as ten per
    cent. A clipped NUMBER is a wrong number; a clipped name is still a name. */
 .q b{font-weight:650;font-size:12px;opacity:.9;white-space:nowrap;
   min-width:0;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
 .q b.c{opacity:1}
 /* THE BAR YIELDS FIRST, AND ALL THE WAY. It used to stop at a 10px floor,
    which sounds harmless and is not: the floor has to come from somewhere, and
    on a narrow card it came out of the percentage, which then clipped. A bar
    that has shrunk to nothing has lost a picture of a number that is still
    printed beside it; a number that has lost a digit has lost the number.
    A shrink factor of 999 makes it give up its width before anything else is
    asked to. */
 .q .t{display:block;flex:1 999 auto;min-width:0;height:6px;border-radius:99px;
   background:color-mix(in srgb,var(--fg,#222) 14%,transparent);overflow:hidden}
 .q .t i{display:block;height:100%;border-radius:99px}
 /* NEVER SHRINKS, NEVER CLIPS. It is the thing the card exists to show. */
 .q u{text-decoration:none;font-weight:700;font-size:12px;white-space:nowrap;flex:0 0 auto;
   font-variant-numeric:tabular-nums}
 .q em{font-style:normal;opacity:.4;font-size:12px}
</style><div class=q>${rows.map(seg).join('')}</div>`;

// `--print` dumps the markup instead of setting the card, so the layout can be
// measured at phone widths without writing to the live chat.
if (process.argv.includes('--print')) {
  process.stdout.write(html);
} else {
  execFileSync('muxpad', ['card', 'set', 'quota', '--format=html', '--every=1h', html], {
    stdio: 'inherit',
  });
}
