// Invented data only. Every company, person, channel, url and number is made up.
const DOCS = 'https://docs.trellis.localhost:17880';

const TABLE = `Here's what the five cost once seat minimums and API add-ons are counted in.

| Vendor | List/Seat | Seat Min | API Tier | Real Entry |
|---|---|---|---|---|
| Brightbill | $49/mo | 1 | Add-on ($200/mo) | $249/mo |
| Ottoline | $79/mo | None | Included | $79/mo |
| Ferro | $99/mo | 20 | Enterprise only | $1,990/mo |
| Casewell | $65/mo | 5 | Pro tier ($150/mo) | $475/mo |
| Trellis | $55/mo | None | Included | $55/mo |

**The sticker price misleads:** with minimums and paid API tiers, real entry runs from 1x to 20x the per-seat number.`;

const spawn = (name, brief) => ({
  bash: `muxpad agent new --deliver=batch --name="${name}" "${brief}"`,
  run: true,
  dur: 500,
});

export const scenarios = [
  {
    key: 'pricing',
    match: /^Here's the vendor list/,
    turns: [
      {
        match: /^Here's the vendor list/,
        steps: [
          { wait: 400 },
          {
            say: 'Got all five. Say when you want them priced — I will split the deep dives out to sub-chats.',
            stream: false,
          },
        ],
      },
      {
        match: /^Price them/,
        steps: [
          { wait: 500 },
          {
            think:
              'Pull list prices, minimums and API tier. The two with no minimum get a deep dive each, in parallel.',
          },
          {
            bash: 'curl -s https://brightbill.example/pricing.json | jq ".plans[0]"',
            out: '{ "name": "Team", "seat": 49, "min_seats": 1, "api": "addon:200" }',
            dur: 500,
          },
          spawn(
            'ottoline deep dive',
            'Ottoline: contract terms, overage pricing, churn risk. Report in 3 lines.',
          ),
          spawn(
            'trellis deep dive',
            'Trellis: contract terms, overage pricing, churn risk. Report in 3 lines.',
          ),
          { say: TABLE, pace: 45 },
          {
            bash: `muxpad card set market --format=md '🟢 5 vendors priced · 2 have no seat minimum · entry $55–$1,990/mo'`,
            run: true,
            dur: 200,
          },
          {
            bash: `muxpad card set shortlist --format=md '📌 Shortlist: Ottoline, Trellis — no minimum, API included'`,
            run: true,
            dur: 200,
          },
          {
            bash: 'muxpad publish ./entry-cost.html --name=entry-cost-chart --days=1',
            publish: {
              path: '/private/tmp/mxd/home/work/market-scan/entry-cost.html',
              name: 'entry-cost-chart',
              days: 1,
              public_base_url: 'https://share.example.net',
            },
            dur: 300,
          },
          {
            say: 'Two sub-chats are on Ottoline and Trellis. I will fold their contract risk in when they land.',
          },
        ],
      },
      {
        match: /deep dive/,
        steps: [
          { wait: 500 },
          {
            say: `Both are back. **Trellis is the pick:** month-to-month on every plan, and its [billing docs](${DOCS}/billing) cap overage at 20%. Ottoline wants an annual contract above 10 seats.`,
          },
          {
            bash: 'muxpad publish ./teardown --name=vendor-teardown',
            publish: {
              path: '/private/tmp/mxd/home/work/market-scan/teardown',
              name: 'vendor-teardown',
              days: 7,
              public_base_url: 'https://share.example.net',
            },
            dur: 500,
          },
          {
            bash: 'muxpad slack post "#pricing-council" "Vendor teardown is up — Trellis wins on real entry cost."',
            out: '✓ posted to #pricing-council',
            act: {
              kind: 'slack.post',
              title: 'Posted to #pricing-council',
              body: 'Vendor teardown is up — Trellis wins on real entry cost. Full table in the link.',
              url: 'https://northwind-labs.slack.com/archives/C07PRICE/p1763164800',
              state: 'sent',
            },
            dur: 600,
          },
          {
            bash: 'muxpad slack post "#finance-approvals" "Requesting sign-off: Trellis, 12 seats, $660/mo."',
            out: 'slack: channel_not_found',
            error: true,
            act: {
              kind: 'slack.post',
              title: 'Posted to #finance-approvals',
              body: 'Requesting sign-off: Trellis, 12 seats, $660/mo.',
              state: 'failed',
              detail: 'channel_not_found — the channel was renamed',
            },
            dur: 600,
          },
          {
            say: 'Teardown published and posted to #pricing-council. The #finance-approvals post failed — that channel was renamed. Want me to find the new one?',
          },
        ],
      },
    ],
  },
  {
    key: 'ottoline',
    match: /^Ottoline:/,
    turns: [
      {
        steps: [
          { wait: 700 },
          { think: 'Terms page, then the overage table.' },
          {
            bash: 'curl -s https://ottoline.example/legal/terms | grep -i -A1 "term\\|renew"',
            out: 'Initial Term: 12 months for plans above 10 seats.\nRenewal: automatic, 60 days notice.',
            dur: 1500,
          },
          {
            bash: 'curl -s https://ottoline.example/pricing/overage',
            out: 'Overage: $0.012 per event above plan, billed monthly, uncapped.',
            dur: 1500,
          },
          { wait: 1200 },
          {
            say: 'Ottoline: annual contract above 10 seats, auto-renews on 60 days notice, overage uncapped at $0.012/event. Risk: **medium**.',
          },
          {
            report:
              'Ottoline: annual above 10 seats, auto-renews (60 days notice), uncapped overage. Risk: medium.',
          },
        ],
      },
    ],
  },
  {
    key: 'trellis',
    match: /^Trellis:/,
    turns: [
      {
        steps: [
          { wait: 1200 },
          { think: 'Trellis publishes its terms in the docs. Check the overage cap first.' },
          {
            bash: `curl -s ${DOCS}/billing | grep -i cap`,
            out: 'Overage is capped at 20% of your plan price per month.',
            dur: 1700,
          },
          {
            bash: `curl -s ${DOCS}/contracts | head -3`,
            out: 'All plans are month-to-month.\nCancel any time from Settings → Billing.\nAnnual prepay: 2 months free.',
            dur: 1700,
          },
          {
            say: 'Trellis: month-to-month on every plan, cancel any time, overage capped at 20% of plan price. Annual prepay gets 2 months free. Risk: **low**.',
            pace: 90,
          },
          { report: 'Trellis: month-to-month, overage capped at 20%. Risk: low.' },
        ],
      },
    ],
  },
  {
    key: 'ciflakes',
    match: /^Find the flaky tests/,
    turns: [
      {
        match: /^Find the flaky/,
        steps: [
          { wait: 400 },
          { think: 'Rerun the suite and diff the failures.' },
          {
            say: 'Two flakes, both timing: `ledger-sync` races its own debounce, and `export-csv` assumes it is not midnight. Want me to rerun 20x to confirm?',
            stream: false,
          },
        ],
      },
      {
        match: /rerun/i,
        steps: [
          { wait: 400 },
          { say: 'Rerunning the ledger suite 20 times to catch both in the act.', stream: false },
          {
            tool: 'Bash',
            input: { command: 'for i in $(seq 20); do pnpm test ledger --reporter=dot; done' },
            dur: 3600000,
          },
        ],
      },
    ],
  },
];

// Quiet background chats: one short exchange each, so the rail has history.
const quick = (key, match, think, say, extra = []) => ({
  key,
  match,
  turns: [{ steps: [{ wait: 400 }, { think }, ...extra, { say, stream: false }] }],
});
scenarios.push(
  quick(
    'shortlist',
    /^Keep a running shortlist/,
    'Start from the five in the teardown.',
    'Shortlist started: Ottoline and Trellis in, Ferro out on its 20-seat minimum.',
  ),
  quick(
    'switching',
    /^What does it cost to leave/,
    'Export formats and notice periods.',
    'Leaving Brightbill takes a CSV export and 30 days notice; Casewell charges $500 for a full data export.',
  ),
  quick(
    'report',
    /^Draft the competitor report/,
    'Outline first.',
    'Outline is in report.md — five sections, one per vendor, pricing table up top.',
    [{ bash: 'wc -l report.md', out: '84 report.md' }],
  ),
  quick(
    'oauth',
    /^Implement the OAuth device flow/,
    'Poll endpoint plus a user-code screen.',
    'Device flow works end to end against the mock identity provider; 14 tests green.',
    [
      {
        bash: 'pnpm test device-flow',
        out: ' ✓ src/auth/device-flow.test.ts (14 tests) 212ms\n Test Files  1 passed (1)',
      },
    ],
  ),
  {
    key: 'invoice',
    match: /^Invoice PDFs render/,
    turns: [
      {
        match: /^Invoice PDFs/,
        steps: [
          { wait: 400 },
          { think: 'Probably the font subset.' },
          { bash: 'pnpm test invoice-pdf', out: ' ✓ src/invoice/pdf.test.ts (9 tests) 480ms' },
          {
            say: 'Fixed — the PDF font subset dropped the € glyph. Invoices render in all four currencies now; shipped as 1.8.2.',
            stream: false,
          },
        ],
      },
      {
        match: /INV-20415/,
        steps: [
          { wait: 400 },
          {
            bash: 'ledgerkit invoice render INV-20415 --out /tmp/INV-20415.pdf',
            out: 'rendered INV-20415.pdf · 2 pages · €12,950.00',
          },
          {
            bash: 'pdftotext /tmp/INV-20415.pdf - | grep -m2 €',
            out: 'Total due  €12,950.00\nVAT (19%)  €2,067.65',
          },
          {
            say: 'Re-rendered on 1.8.2 and it is right now: **€12,950.00**, VAT line intact, two pages. I marked it *Sent* and queued the email to Brasswork Labs for 9:00 tomorrow.',
            stream: false,
          },
        ],
      },
    ],
  },
);
