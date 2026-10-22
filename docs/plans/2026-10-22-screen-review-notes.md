# Screen review → addressed notes

**Status:** specified, not built. The spike is done and its findings are below.
**Spike:** `web/public/review-spike.html` (throwaway; delete when v1 lands).

---

## 1. The problem

Reviewing something you are building means going back and forth: look at the
app, switch to muxpad, describe in words what you just looked at, switch back.
The description is the expensive part, and it is expensive precisely because
the thing you want to say is *"this one, here"* — which prose cannot carry.

The ask, in the user's words:

> "i often review stuff on my computer and want to highlight things for an
> agent to do. i go back and forth between the say the web app being built and
> muxpad typing new messages… is there a model where I could literally
> screenshare, highlight things with the cursor while I talk over and a model
> muxpad runs would like understand and create messages and do things based on
> that?"

## 2. What it is

A **review session**: you press a button in the composer, pick a window or
screen in the browser's own picker, switch to that app, and talk while you
point. What comes back is **one message, in sections, each section carrying the
frame that was on screen when you said it.**

Not a recording. Not a meeting transcript. A queue of *addressed notes*, which
is the only shape an agent can act on.

```
① this video should be smaller
   [frame: cursor on the player]
② this button make it pink
   [frame: cursor on the purple button]
③ these two buttons, combine them with little icons
   [frame: cursor on the pair]
④ the diarized transcript should be full width
   [frame: transcript block, text selected]
```

## 3. What the spike proved

Run on 2026-10-22 against a real app, reviewed from another application.
Numbers are measured, not estimated.

| question | answer |
|---|---|
| Does capture survive switching apps? | **Yes.** Frames kept arriving with the tab unfocused the whole time. |
| Does the pointer end up in the frames? | **Yes** — with `cursor: 'always'`. Hover states and **text selection** are in the pixels too. |
| Does the anchor land on the right thing? | **Yes.** One 12s utterance containing four asks produced four frames, each with the cursor on the thing being discussed. |
| What does it cost? | 28 samples over 12s → **4 images kept**, ~300 KB of attachments. Sampling is nearly free; selection is what matters. |
| Is a video-capable model needed? | **No.** See §4. |

### 3.1 Four findings that change the design

1. **Never dedupe the anchor frame.** Between "make this green" and "put a
   monkey on this" the screen is byte-identical and only the *cursor* moved. A
   content hash cannot see a pointer, so dedupe collapsed them and both notes
   pointed at the first frame. Dedupe is for idle heartbeats only.
2. **Capture often, select late.** Sampling rate and attachment count are
   different numbers. Sample into a ring buffer several times a second; a note
   then takes the frames from *its own* span. One image for a remark, up to
   five for a sentence that wandered.
3. **Segmentation cannot come from the transcriber's "final" events.** Chrome's
   Web Speech handed back one 12-second paragraph containing four instructions.
   v1 does not have this problem (§5.2) — but the *splitting* step is required
   regardless, because people say three things in one breath.
4. **Transcription noise is repairable from the frame.** "thyroid script" for
   "diarized transcript" — the model doing the split can read the real label
   off the screenshot. Do not spend effort on transcription accuracy.

### 3.2 Two findings that are about the SPIKE, not the design

Both disappear in v1; do not carry them forward as constraints.

- **The focus dance.** Web Speech goes deaf when its tab is unfocused, which is
  why the spike needs you to click back before talking. muxpad's voice path is
  WebRTC and does not care about focus.
- **The device trap.** The built-in mic delivered a live-but-silent track. Not
  our bug, but v1 should show an input level so a dead mic is visible
  immediately rather than after a wasted review.

## 4. Why no video model is involved

Investigated 2026-10-22:

- **OpenAI Realtime has no video input.** `gpt-realtime` / `gpt-realtime-2`
  accept images mid-conversation; there is no stream input. GPT-Live does not
  do screenshare at launch either.
- **Gemini Live does accept video — and samples it at 1 fps**, with explicit
  guidance to send frames only when useful.

So the frontier implementation of "live screen share" is one-frame-per-utterance
with extra steps. Since the **output is a muxpad message**, the thing that
digests it is the agent already in that chat. No second vendor, no streaming
bill, no realtime video model.

## 5. Architecture

Three parties. The split is forced by one fact: `getDisplayMedia` hands the
stream to the **page**, and the page is also the part that dies (you switch
apps, the PWA suspends, a reload kills it). So the page does as little as
possible and nothing that may not be lost.

```
PAGE      capture + mic. Samples frames, uploads them and the utterances
          as they happen. Holds no state worth protecting.
SERVER    owns the session. Dedupe, pairing, splitting, compose, dispatch.
          Survives the page dying; a dropped tab truncates a review rather
          than losing it.
AGENT     reads the finished message. Not in the loop during capture.
```

### 5.1 Frame capture (page)

- `getDisplayMedia({ video: { cursor: 'always' } })`, with a fallback that
  LOGS when the constraint is rejected (the pointer is the point).
- Sample into a ring buffer at **~3/s while speech is active**, ~1/2s when
  silent. Downscale to 1280px wide, JPEG q≈0.7 (~70 KB/frame measured).
- Hash each sample (16×16 greyscale, ≥5 bits/cell). Drop consecutive identical
  hashes **only when not speaking**.
- Upload each *kept* frame immediately via the existing attachments route
  (`POST /api/panes/:paneId/attachments`), which already streams to disk, caps
  at 512 MB, and reports progress.

### 5.2 Audio and utterances (page → existing stack)

Reuse the voice stack wholesale. Do not write a second one.

- `POST /api/voice/session` (server/src/routes/voice.ts) — the existing
  SDP exchange; `web/src/lib/voice/transport.ts` has the hard-won ordering
  rules (data channel before offer, ICE complete before POST).
- **`TranscriptBuffer` (web/src/lib/voice/transcript.ts) already produces
  exactly what this feature needs**: `Utterance { text, startMs, endMs }`,
  segmented on a 1200 ms gap (`GAP_MS`). That is the segmentation the spike
  lacked — use it, and do not reimplement silence detection.
- Mic level should be displayed (see §3.2).

### 5.3 The note (server)

```ts
interface ReviewNote {
  id: string;
  text: string;          // one instruction, after splitting
  startMs: number;       // from the Utterance
  endMs: number;
  frames: string[];      // attachment paths, in time order
}
```

Pairing rule, in order:

1. The frame sampled nearest `startMs` — people point, then talk.
2. Up to four more spread across `[startMs, endMs]`, deduped by hash.
3. If a split produced several instructions from one utterance, each takes the
   frame nearest *its own* position in the utterance (word timings from the
   realtime transcript make this exact; proportional split is the fallback).

### 5.4 Splitting (server, one model pass)

Input: the utterance text + its frames. Output: 1..n instructions, each with a
frame index. This is the step that turns

> "this video should be smaller this button make it Pink and these two buttons
> combine them together with little icons and the thyroid script should be full
> with"

into four items — and it is also where transcription noise gets repaired from
the image. Use the pane's own account (AccountPool) and a cheap model.

### 5.5 The message (server)

muxpad already renders text and inline media interleaved
(`splitMessageAttachments`), so the composed message is literally:

```
① this video should be smaller
/Users/…/.muxpad/attachments/a1.jpg
② this button make it pink
/Users/…/.muxpad/attachments/b2.jpg
```

Submit it to the target pane the same way the composer does. **Never
auto-send**: the note list is reviewed first (§6).

### 5.6 Cursor marking (server, post-processing)

Diff consecutive samples; the small region that moved is the pointer. On the
exported frame, draw a ring at that point and attach a **zoom inset** of the
~300 px around it. This is the substitute for markup tools, which are
impossible from a web page once you have switched apps (§8).

## 6. UI

- **Composer button**, beside the mic. Same shape, same language.
- While recording: a compact panel listing notes **as they form**, each with
  its frame thumbnail, a scrap (×), and a mic level. This is the
  review-before-send affordance and the whole reason notes beat a transcript.
- On stop: "Send to this chat" / "Send to…". Editing note text is **out of
  scope for v1** — scrap or keep.

## 7. v1 scope

**In:** capture, ring buffer, upload, voice session reuse, utterance pairing,
split pass, cursor ring + inset, note panel, compose and dispatch, session
survives a page reload.

**Out:** editing note text, fan-out to several chats, OCR, drawing tools, a
native helper, non-browser capture sources, anything resembling a meeting
recorder.

## 8. Known limits — state them, do not design around them

- **No markup tools.** Once you switch apps the page cannot see clicks, read
  the cursor, or draw on your screen. The OS cursor, hover and text selection
  are the vocabulary; §5.6 is how we amplify it. Live drawing or a global
  hotkey needs a native helper — only if the rest earns it.
- **The picker is browser-enforced** and stays. It is also the consent moment.
- **Backgrounded capture is Chrome-grade.** Safari has a documented bug killing
  background-tab capture after ~60s. Do not promise Safari.
- **Screen Recording permission** is granted by the user to their browser, once,
  deliberately. muxpad must never trigger that dialog itself.

## 9. Test plan

- `upload-queue`-style unit tests for the ring buffer: dedupe only while
  silent, anchor frames never deduped, eviction by age.
- Pairing: an utterance spanning N samples takes ≤5 frames in time order; a
  split utterance maps each instruction to its own frame.
- Compose: text/media interleaving survives `splitMessageAttachments`
  round-trip — including the case where an instruction *contains* a path
  (see the code-fence bug, fixed 2026-10-22).
- A browser pass for the capture half; jsdom cannot see pixels.

## 10. Risks

1. **The split pass is the quality bottleneck.** If it mangles instructions the
   feature is worse than typing. Mitigation: the note panel shows the result
   before anything is sent.
2. **Frames leak context.** A screen capture may include anything else on that
   screen. The picker scoping a single window is the mitigation; the UI should
   prefer window over full screen.
3. **Attachment volume.** ~70 KB × 5 per note. A long review is a few MB. The
   existing 512 MB route handles it; the pane's attachment store grows.
