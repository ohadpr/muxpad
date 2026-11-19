/**
 * HOW LONG AN UNANSWERED SUMMONS HOLDS ITS CHAT, ITS BROWSER AND ITS BUTTONS.
 *
 * A browser that hits a wall it cannot pass — a login, a captcha, a payment
 * form — asks for a person and the agent ends its turn parked on that ask.
 * This is how long the ask stays live.
 *
 * TWO HOURS, and the number is measured rather than chosen. The person came
 * back after 41 minutes on the evening this was built for, so the 30 minutes
 * another harness uses would have lost that page too. Past two hours a summons
 * nobody answered is abandoned, and a chat shouting "blocked" for a day with a
 * Chrome held open for it is a worse failure than an errand that has to be
 * redone.
 *
 * ── WHY IT LIVES IN shared ──────────────────────────────────────────────────
 * Because it was declared TWICE, with the same value and two docstrings that
 * each described half of it: the server's (browser/AwaitingPerson) decides
 * whether the chat is still parked and the browser still held, and the web's
 * (lib/browser-card) decides whether the card still offers Done and Skip.
 *
 * Those two must agree or the product contradicts itself in the worst
 * direction available: a card still offering Done past the server's hold wakes
 * an agent about an errand the server has already written off, and a card that
 * stops offering it early leaves a parked agent with no mechanical way back —
 * which is the evening this whole mechanism exists because of.
 *
 * Nothing had gone wrong yet. Both copies read `2 * 60 * 60 * 1000`. One file
 * is where it stops being possible.
 */
export const SUMMONS_HOLD_MS = 2 * 60 * 60 * 1000;
