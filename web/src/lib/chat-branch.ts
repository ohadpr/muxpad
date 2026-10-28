/**
 * BRANCH A CHAT — a new conversation that knows where it came from.
 *
 * The case, in the user's words: "when you have a long running, big context
 * task doing something, but it contains context that you want to consult with
 * or do something parallel with — a button that opens a new chat and pre-fills
 * it with 'review the chat, original chat, blah blah' and then the user can
 * fill in whatever it is they want."
 *
 * ─── What a branch is NOT ──────────────────────────────────────────────────
 *
 * It is not a SUB-CHAT. A sub-chat is work this chat delegated: it reports
 * back into the parent's log, it is held open while it runs and retired when
 * it is done, and its whole lifecycle assumes nobody is sitting in it. A
 * branch is the opposite — a chat YOU are going to work in, as a peer, for as
 * long as you want. Making it a child would have it announce its findings into
 * a conversation you walked away from, and then retire itself underneath you.
 *
 * It is not a FORK of the context either, and the prompt says so plainly
 * rather than implying it. Nothing is copied: the new session starts empty in
 * the same folder, and the reference is an instruction to go and READ the
 * other chat. That is the honest version — the transcript is on disk and
 * readable on demand, where a copied context would be a snapshot that starts
 * drifting from the live chat the moment it is taken.
 */

/**
 * The draft the new chat opens with.
 *
 * ENDS MID-SENTENCE, ON PURPOSE. The branch exists because you have something
 * specific to do with that history, and the one thing this helper cannot know
 * is what. A complete prompt would be a prompt somebody has to delete first;
 * this one leaves the caret where the actual request goes.
 *
 * The reference is the PANE id and the CLI command that reads it, not a tab
 * name: the chat the agent is told to read has to be findable by the agent,
 * and `muxpad agent transcript <paneId>` is the one address that works from
 * inside a new session with no state.
 */
export function branchPrefill(opts: { name: string; paneId: string }): string {
  return [
    `Read the chat "${opts.name}" first — \`muxpad agent transcript ${opts.paneId} --tail=200\`,`,
    `or \`muxpad pane summarize ${opts.paneId}\` for the gist. It is still running; do not`,
    'message it. Then: ',
  ].join(' ');
}

/** Where a branch's draft is stashed for the pane that is about to mount it.
 *  Same key ChatPane restores from, so a branch is indistinguishable from a
 *  draft you typed yourself — including being editable before you send it. */
export function draftKeyFor(paneId: string): string {
  return `muxpad.chatDraft.${paneId}`;
}
