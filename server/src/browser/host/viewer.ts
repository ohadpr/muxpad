/**
 * The page a human sees when they take the wheel.
 *
 * Inlined as a string rather than shipped as an asset because `tsc` does not
 * copy `.html`, and a viewer that 404s after a build is a handoff that fails at
 * exactly the moment somebody is waiting on it.
 *
 * Deliberately plain: an <img> and some listeners. Every hard case in the spike
 * — a drag widget, a cross-origin payment iframe, a file picker — worked
 * through this shape, so there is nothing here to make cleverer.
 */
export const VIEWER_HTML = String.raw`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>browser · handoff</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0b0f;color:#d8d8e2;font:13px system-ui;display:flex;flex-direction:column;height:100dvh}
  /* gap was 14px, which on a 390px phone spent 100px of a 390px bar on nothing
     and squeezed the address to "..b". */
  /* IT WRAPS. Words on the buttons cost width — measured at 336px of buttons
     plus gaps and padding against a 390px phone, so the row ran off the side of
     the screen and the last control was unreachable. Wrapping is the only
     arrangement that cannot overflow at any width, and the address gets a line
     of its own rather than competing for the same one. */
  /* ABOVE THE SINK. The sink is touchable now and starts parked at the top-left,
     which is exactly where the way out lives — so a tap on "muxpad" landed on a
     transparent input and was forwarded into the page instead. The toolbar gets
     its own layer: over the stream the sink is harmless, because a tap there is
     forwarded to the page anyway, but it must never cover a control. */
  #bar{flex:none;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;background:#15151c;border-bottom:1px solid #26262f;position:relative;z-index:10}
  #bar b{color:#6ea8ff;font-variant-numeric:tabular-nums}
  /* Opened in a TAB on a phone there is no chrome around this page and no
     modal to dismiss — without this you are simply stranded. */
  #home{color:#d8d8e2;text-decoration:none;font-size:12px;line-height:1;padding:5px 8px;border-radius:6px;border:1px solid #33333f;flex:none;white-space:nowrap}
  #home:hover{background:#23232e}
  /* Words, not glyphs alone. A row of symbols is a guessing game, and this is a
     surface people reach in the middle of a login they did not plan for. */
  #bar button{flex:none;background:transparent;border:1px solid #33333f;color:#d8d8e2;border-radius:6px;font:inherit;font-size:12px;line-height:1;padding:5px 8px;cursor:pointer;white-space:nowrap}
  #signin{border-color:#3f5d8f;color:#b8cdf0}
  #bar button:hover{background:#23232e}
  #bar button[aria-pressed="true"]{background:#2b3a55;border-color:#4a6ea8;color:#cfe2ff}
  #takeover{background:#c98a2e;border-color:#c98a2e;color:#fff;font-size:11px;white-space:nowrap}
  /* Once somebody has tried to type into a stream they cannot type into, this is
     the only thing on the page that helps. */
  #takeover.ready{box-shadow:0 0 0 3px rgba(201,138,46,.45)}
  /* Quieter than "take the wheel": that one is an offer, this is a finish. */
  #handback{border-color:#3d6b4a;color:#9fdcb0;font-size:11px;white-space:nowrap}
  /* Once the password field has gone the errand is probably over, and this is
     the only thing left to press. Loud enough to be found without reading. */
  #handback.ready{background:#2f7d4a;border-color:#2f7d4a;color:#fff}
  /* An out-of-date page is worth interrupting for: everything measured on one is
     measured on code that is no longer there. */
  #reloadPage{background:#8f3f3f;border-color:#8f3f3f;color:#fff;font-size:11px;white-space:nowrap}
  /* Watching: the stream is a picture. Say so rather than letting somebody
     press things that quietly go nowhere. */
  body.watching #screen{cursor:default}
  /* The address, truncated from the LEFT: the end of a url is the part that
     says which page you are on. */
  /* The address is the one thing here that is information rather than a control,
     so it gets a floor: buttons give up their slack first, and it never shrinks
     to the two characters it was showing. */
  /* Its own row: an address competing with seven buttons for one line is how a
     toolbar ends up wider than the screen. */
  #url{flex:1 0 100%;order:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;color:#9a9aab;font-size:11px}
  #msg{order:3;flex:1 0 100%;font-size:11px}
  #msg{color:#e9a}
  /* PINCH AND PAN. The stream is a 1280px page; on a phone, fitted to the
     viewport it is unreadable, and touch-action: none made it unzoomable
     besides. pinch-zoom keeps two-finger gestures for the browser — zoom and
     scroll the FRAME — while one finger still reaches the listeners below and
     becomes a tap or a drag inside the page. */
  #wrap{flex:1;overflow:auto;background:#000;touch-action:pinch-zoom;-webkit-overflow-scrolling:touch}
  #stage{position:relative;display:inline-block;line-height:0}
  #screen{display:block;background:#000;outline:none;transform-origin:0 0}
  /* A ring around the thing that needs you — see the host's reveal handler for
     why this is a highlight and not a crop. Fades out; a pointer, not a mode. */
  #ring{position:absolute;border:2px solid #f0943f;border-radius:6px;pointer-events:none;
        box-shadow:0 0 0 3px rgba(240,148,63,.25);opacity:0;transition:opacity .5s ease}
  #ring.on{opacity:1}
  /* Desktop has room to fit the whole page; a phone does not, and shrinking it
     to fit is the thing that made it useless. */
  @media (min-width: 700px) { #screen{max-width:100%} }
  /* THE TEXT SINK: A REAL INPUT, PUT WHERE THE FINGER WENT.
     Four attempts lived here, each hiding this input a different way and each
     killing the keyboard, so the log that finally settled it is worth keeping:

       50207  sink focus          <- our focus, inside the tap
       50208  tap  onAField:true
       50321  viewport 793 -> 417 <- the keyboard opens
       50335  sink blur           <- 14ms later, iOS blurs it
       50363  viewport 417 -> 793 <- and the keyboard goes

     So it was never WebKit refusing a keyboard to an invisible field. iOS raised
     one and then BLURRED the input, immediately after the keyboard changed the
     visual viewport. That is what a fixed-position element parked at the top of
     the layout viewport gets: the keyboard opens, iOS reflows fixed elements and
     scrolls to reveal what has focus, the sink is no longer where it was, and an
     input iOS cannot settle on is an input it drops.

     The fix is to stop fighting the scroll-into-view and give it nothing to do:
     the sink is MOVED TO THE TAP on every tap, so it is already exactly where
     iOS wants to put it — under the finger, inside the visual viewport, next to
     the field the person is looking at.

     Everything else is unchanged and still load-bearing: full opacity and a real
     40x40 box (opacity:0, 1x1 and z-index:-1 each read as invisible and got the
     keyboard refused outright), and hidden by having no ink rather than no
     substance. */
  /* AND IT CAN BE TOUCHED. pointer-events:none was the last property of this
     input never to have been questioned, and it is a plain statement that the
     element is not interactive — which is a strange thing to say about the one
     element the keyboard is for. Everything else had been eliminated by then: the
     log showed the sink focused, inside the visual viewport with the keyboard
     open (at y=342 of 417), and then blurred 32ms later with focus falling to the
     body.
     Being touchable means it can now intercept a tap meant for the page, so it
     carries the same pointer handlers as the stream and a tap landing on it is
     treated as a tap on the page underneath — see the handlers below. */
  #sink{position:fixed;left:0;top:0;width:40px;height:40px;opacity:1;border:0;padding:0;
        margin:0;font-size:16px;resize:none;overflow:hidden;background:transparent;
        color:transparent;caret-color:transparent}
  #login{position:fixed;inset:0;background:#000d;display:grid;place-items:center;padding:20px;z-index:20}
  #login[hidden]{display:none}
  #loginForm{width:min(420px,100%);background:#17171f;border:1px solid #33333f;border-radius:12px;padding:16px;display:grid;gap:10px}
  #loginWho{font-size:15px;color:#d8d8e2}
  /* 16px or iOS zooms the whole viewer the moment you focus one. */
  #login input{font-size:16px;padding:12px;border-radius:8px;border:1px solid #33333f;background:#0f0f16;color:#eee}
  .loginRow{display:flex;gap:8px}
  #loginGo{flex:1;background:#3f5d8f;border:0;color:#fff;font-size:15px;padding:12px;border-radius:8px}
  #loginCancel{background:transparent;border:1px solid #33333f;color:#9a9aab;font-size:14px;padding:12px;border-radius:8px}
  #loginNote{font-size:11.5px;color:#7c7c8c;line-height:1.4}
  #drop{position:fixed;inset:0;background:#000c;display:none;place-items:center;padding:20px;text-align:center}
  #drop.on{display:grid}
</style>
<div id="bar">
  <!-- WORDS, AND THE WAY OUT FIRST.
       This was a bare hamburger glyph, which is the one control on here people
       actually need to find — opened from a card in a tab there is no browser
       chrome around this page and no modal to dismiss, so without it you are
       stranded. A glyph that means "menu" everywhere else is a poor label for
       "leave". It says where it goes.
       The rest are grouped rather than listed: get around, then sign in, then
       finish. Two reload arrows side by side (Reload the page, Update muxpad)
       were the same symbol for unrelated things, so the second one is an arrow
       that points somewhere else and names what it updates. -->
  <a id="home" href="/" title="back to your conversation">&#8249; muxpad</a>
  <button id="navBack" title="the page before this one">&#8249; Back</button>
  <button id="navReload" title="reload the page">&#8635; Reload</button>
  <button id="mobile" title="show the phone version of the site" aria-pressed="false">&#128241; Phone</button>
  <button id="signin" title="fill a sign-in form from your password manager" hidden>&#128273; Sign in</button>
  <button id="paste" title="paste from your clipboard into the page">&#128203; Paste</button>
  <button id="takeover" title="take the wheel so you can type" hidden>Take over</button>
  <button id="handback" title="give the browser back to the agent" hidden>Done</button>
  <button id="reloadPage" title="this page is running an older version of muxpad" hidden>&#8679; Update muxpad</button>
  <span id="url" title="">–</span>
  <span id="msg"></span>
</div>
<div id="wrap"><div id="stage"><img id="screen" tabindex="0" alt="the agent's browser"><div id="ring"></div></div></div>
<!-- THE KEYBOARD. A phone shows one only when something in THIS page is
     focused, so tapping a text box in a video stream summons nothing. This
     input is the thing that gets focused; what you type into it is forwarded and
     it is emptied again, so it never holds anything and never shows what you
     typed twice. Off-screen rather than hidden: display:none and
     visibility:hidden cannot take focus, and a phone will not open a keyboard
     for an element it considers invisible. -->
<textarea id="sink" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
<!--
  THE SIGN-IN PANEL, and why it is a real form.

  A password manager fills the page it is LOOKING at. That page is muxpad — some
  tailnet hostname it has never heard of — and the site's own form is a JPEG in a
  canvas, invisible to it. So there is nothing for 1Password to offer, on the one
  surface where you most want it.

  This is a real <form> with real inputs and the autocomplete attributes managers
  read, so 1Password will open on it. It will not know WHICH entry — the origin
  is wrong and always will be — so you pick the site by hand, once. What it fills
  here is then typed into the page over CDP.

  It is also why the keyboard works at all now: a real, on-screen input is
  something iOS will hold a keyboard for.
-->
<div id="login" hidden>
  <form id="loginForm" autocomplete="on">
    <div id="loginWho">Sign in</div>
    <input id="loginUser" type="text" name="username" autocomplete="username"
           placeholder="username or email" autocapitalize="off" autocorrect="off" spellcheck="false">
    <input id="loginPass" type="password" name="password" autocomplete="current-password"
           placeholder="password">
    <div class="loginRow">
      <button type="submit" id="loginGo">Fill the page</button>
      <button type="button" id="loginCancel">Cancel</button>
    </div>
    <div id="loginNote">Pick the site in your password manager — this form stands in for it.</div>
  </form>
</div>
<div id="drop"><div>The page is asking for a file.<br><br><input type="file" id="fpick"></div></div>
<script>
const img = document.getElementById('screen')
const msg = document.getElementById('msg')
const sink = document.getElementById('sink')
// Everything is relative to WHERE THIS PAGE IS SERVED FROM, not to the origin
// root: muxpad proxies this viewer at /browser/<profile>/ so the link can be a
// tailnet one, and an absolute '/ws' would dial the cockpit's socket instead.
// Served directly on the host's own port, base is '/' and this is unchanged.
const base = location.pathname.replace(/[^/]*$/, '')
/**
 * The socket, RECONNECTING.
 *
 * It used to be opened once and, on close, replaced by the words "disconnected
 * — the browser may have restarted". That is true and useless: the page then sat
 * on a frozen image with an error across it until somebody thought to reload,
 * and everything closes this socket sooner or later — a phone locking, wifi
 * changing hands, the tailnet reconnecting, the cockpit restarting, the host
 * being bounced. A viewer you have to reload is a viewer that is broken every
 * few minutes.
 *
 * So it dials again, backing off to a few seconds, forever. The message says
 * which it is: gone, or coming back.
 */
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + 'ws'
let ws = null
let retryIn = 400
let retryTimer = null
// Work that must happen on EVERY fresh connection, not once per page load: the
// host is a new process as far as this socket is concerned and remembers none
// of what the last one was told.
const onEachOpen = []
const whenOpen = (fn) => {
  onEachOpen.push(fn)
  if (ws && ws.readyState === 1) fn()
}

let meta = null, url = null, nw = 0, nh = 0
const times = []

const connect = () => {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  const sock = new WebSocket(WS_URL)
  sock.binaryType = 'arraybuffer'
  ws = sock
  sock.onopen = () => {
    retryIn = 400
    announceMode(sock)
    // Clears the DISCONNECTION notice, and puts back whatever the page's own
    // state has to say. A bare clear wiped the one line explaining that this
    // viewer is read-only — so on a watch-mode tab the explanation was removed
    // the moment the connection succeeded, and a person tapping fields that did
    // nothing had nothing on screen to tell them why.
    msg.textContent = ''
    if (watching) msg.textContent = 'watching — press Take over to type'
    for (const fn of onEachOpen) { try { fn() } catch { /* one hook must not stop the rest */ } }
  }
  sock.onclose = () => {
    // Only the CURRENT socket may schedule a retry. A late close from a socket
    // we already replaced would otherwise queue a second dial, and the two would
    // race and multiply.
    if (ws !== sock) return
    msg.textContent = 'reconnecting…'
    retryTimer = setTimeout(connect, retryIn)
    retryIn = Math.min(retryIn * 2, 5000)
  }
  sock.onerror = () => { /* close follows, and that is where the retry lives */ }
  sock.onmessage = onSocketMessage
}
const urlEl = document.getElementById('url')
const showUrl = (u) => {
  urlEl.textContent = u || '–'
  urlEl.title = u || ''
}
function onSocketMessage(e) {
  if (typeof e.data === 'string') {
    const m = JSON.parse(e.data)
    if (m.t === 'url') { showUrl(m.url); return }
    // THE HOST HAS BEEN REPLACED UNDER THIS PAGE. Its socket reconnects, frames
    // resume and nothing looks wrong, but the script running here is the one that
    // was served before the restart. A whole evening of testing went into fixes
    // that had already shipped, against a tab still running the version from
    // before them — so the page finds out, and says so, instead of being tested
    // in that state.
    if (m.t === 'build') { noticeBuild(m.id); return }
    // The page says a text field is focused, so put a keyboard on the phone.
    // This is what makes tapping a login box behave like tapping a login box.
    if (m.t === 'focus') {
      // The tap already focused the sink; this is the page telling us whether
      // that was right. Keeping it is what makes the keyboard STAY up.
      if (m.editable) setKb(true)
      else if (!kbFromTap) setKb(false)
      return
    }
    if (m.t === 'fields') { if (Array.isArray(m.rects)) fields = m.rects; return }
    if (m.t === 'login') {
      // Looked up here rather than closed over: this handler is hoisted above
      // the panel's own declarations, so a login report arriving during setup
      // would reach a const that does not exist yet.
      const btn = document.getElementById('signin')
      const present = Boolean(m.present)
      if (btn) btn.hidden = !(present && !watching)
      noticeSignIn(present)
      return
    }
    if (m.t === 'filled') { if (!m.ok) msg.textContent = 'could not find the form to fill'; return }
    if (m.t === 'revealed') { ringAt(m.rect); return }
    if (m.t === 'frame') { meta = m.meta }
    else if (m.t === 'fileChooser') { document.getElementById('drop').classList.add('on') }
    else if (m.t === 'error') { msg.textContent = m.error }
    return
  }
  const next = URL.createObjectURL(new Blob([e.data], { type: 'image/jpeg' }))
  const old = url
  img.src = next; url = next
  if (old) setTimeout(() => URL.revokeObjectURL(old), 50)
  times.push(performance.now())
  if (times.length > 120) times.shift()
}

img.addEventListener('load', () => { if (img.naturalWidth) { nw = img.naturalWidth; nh = img.naturalHeight } })

// image pixel -> page CSS pixel. nw is CACHED: naturalWidth is 0 for the
// instant between assigning src and decoding, and a NaN coordinate reaches CDP
// as a protocol error, so the tap is simply lost.
/**
 * A point on the picture → the same point on the page.
 *
 * EACH AXIS BY ITS OWN SCALE. This multiplied the vertical by the HORIZONTAL
 * ratio, which is correct only while the frame's aspect matches the viewport's
 * exactly — true most of the time, and silently wrong the moment it is not.
 * Chrome caps screencast frames, and a capped or unusually tall page then put
 * every tap above or below what was aimed at: measured, a tap meant for y=800
 * landing at y=200.
 *
 * Falls back to the width ratio when the frame carries no height, because a tap
 * mapped by the wrong axis is still closer than no tap at all.
 */
const pt = (e) => {
  const r = img.getBoundingClientRect()
  if (!nw || !r.width || !meta) return null
  const across = (e.clientX - r.left) / r.width
  const down = (e.clientY - r.top) / r.height
  const deviceHeight = meta.deviceHeight || (meta.deviceWidth * nh) / nw
  return { x: across * meta.deviceWidth, y: down * deviceHeight }
}
const mods = (e) => (e.altKey?1:0) | (e.ctrlKey?2:0) | (e.metaKey?4:0) | (e.shiftKey?8:0)

// WATCH MODE. Opening the session card is looking over the agent's shoulder,
// and a look must not stop it working — so nothing that would change the page
// leaves this tab. The wheel is not held and not requested; the stream is a
// picture until somebody says otherwise.
let watching = new URLSearchParams(location.search).get('mode') === 'watch'
const INPUT = new Set(['mouse', 'key', 'text', 'nav', 'emulate'])
const send = (o) => {
  if (watching && INPUT.has(o.t)) return
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o))
}

let buttons = 0
const onPointerDown = (e) => {
  e.preventDefault()
  // FOCUS INSIDE THE GESTURE. iOS raises a keyboard only for a focus() that
  // happens during a real user event — one issued later, when the page tells us
  // a text field is focused, is silently ignored and no keyboard appears.
  //
  // Which is why the host ships the boxes of the page's text fields: without
  // them the only option is to focus on EVERY tap and let the page's answer take
  // it back, so tapping a link slides a keyboard up and then down again. With
  // them the answer is known here, on the tap, with no round trip.
  //
  // No boxes yet means UNKNOWN, not "no fields" — then guess, because a keyboard
  // that flashes is a blemish and a keyboard that never comes is the bug.
  if (watching) {
    // TAPPING A TEXT FIELD IS NOT AMBIGUOUS. It is somebody trying to type, and
    // making them find a button first produced the most repeated complaint of
    // the whole feature: "tapping either field does nothing". Watch mode exists
    // so that LOOKING does not stall the agent — not so that deciding to help
    // costs an extra step and a hunt for the control that allows it.
    //
    // A human outranks an agent at the wheel by design (see the routes: /take is
    // the human door and it never refuses), so this is not stealing anything it
    // would not have been given for the asking.
    //
    // THE FOCUS HAPPENS NOW, inside the gesture, before the request is even sent.
    // iOS raises a keyboard only for a focus that happens during a real user
    // event, so waiting for the server's answer would cost the keyboard this tap
    // was for. The tap itself is replayed once the wheel is actually ours.
    const p0 = pt(e)
    if (p0 && hitsField(p0) === true) {
      kbFromTap = true
      placeSink(e)
      sink.focus({ preventScroll: true })
      reportKeyboard(true)
      takeTheWheel(p0)
    } else {
      msg.textContent = 'watching only — press Take over to type'
      takeover.classList.add('ready')
    }
  } else {
    const p0 = pt(e)
    const hit = p0 ? hitsField(p0) : null
    kbFromTap = hit === true
    if (hit !== false) {
      placeSink(e)
      sink.focus({ preventScroll: true })
      reportKeyboard(hit)
    }
  }
  buttons = 1
  img.setPointerCapture?.(e.pointerId)
  const p = pt(e); if (p) send({ t:'mouse', type:'mousePressed', ...p, buttons:1, clickCount:e.detail||1, modifiers:mods(e) })
}

/**
 * THE SAME HANDLERS ON THE SINK.
 *
 * The sink is touchable now, so it can land under a finger aimed at the page —
 * a 40x40 patch sitting wherever the last tap was. Rather than trying to keep it
 * out of the way, it behaves exactly like the stream: the coordinates come from
 * the pointer event and the stream's own rectangle, so which element received the
 * event makes no difference to where the tap is sent.
 */
for (const el of [img, sink]) {
  el.addEventListener('pointerdown', onPointerDown)
}

const onPointerMove = (e) => {
  const p = pt(e); if (p) send({ t:'mouse', type:'mouseMoved', ...p, buttons, modifiers:mods(e) })
}
for (const el of [img, sink]) {
  el.addEventListener('pointermove', onPointerMove)
}
const release = (e) => {
  if (!buttons) return
  buttons = 0
  const p = pt(e); if (p) send({ t:'mouse', type:'mouseReleased', ...p, buttons:0, clickCount:1, modifiers:mods(e) })
}
for (const el of [img, sink]) {
  el.addEventListener('pointerup', release)
  el.addEventListener('pointercancel', release)
}
img.addEventListener('wheel', (e) => {
  e.preventDefault()
  const p = pt(e); if (p) send({ t:'mouse', type:'mouseWheel', ...p, deltaX:e.deltaX, deltaY:e.deltaY, modifiers:mods(e) })
}, { passive:false })
const isPasteChord = (e) => (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'v' || e.key === 'V')
img.addEventListener('keydown', (e) => {
  e.preventDefault()
  if (isPasteChord(e)) { pasteFromClipboard(); return }
  send({ t:'key', key:e.key, modifiers:mods(e) })
})

// ── pointing at the thing that needs you ────────────────────────────────────
const ring = document.getElementById('ring')
let ringTimer = null
const ringAt = (rect) => {
  if (!rect || !nw || !meta) return
  // Page CSS px -> image px -> rendered px, so the ring lands on the field
  // wherever the stream happens to be scaled to.
  const r = img.getBoundingClientRect()
  const toImg = nw / meta.deviceWidth
  const shown = r.width / nw
  const k = toImg * shown
  ring.style.left = (rect.x * k) + 'px'
  ring.style.top = (rect.y * k) + 'px'
  ring.style.width = (rect.w * k) + 'px'
  ring.style.height = (rect.h * k) + 'px'
  ring.classList.add('on')
  ring.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
  clearTimeout(ringTimer)
  // It fades rather than persisting: forms move as you type, and a ring that
  // stays put starts pointing at the wrong place the moment you begin.
  ringTimer = setTimeout(() => ring.classList.remove('on'), 4000)
}

// The summons says what needs a person. Ask muxpad, because this page is served
// from its origin — then tell the host to scroll there.
const revealFromSummons = async () => {
  const profile = location.pathname.split('/').filter(Boolean)[1]
  if (!profile) return
  try {
    const r = await fetch('/api/browsers/' + profile)
    if (!r.ok) return
    const sel = (await r.json())?.needsYou?.selector
    if (sel) send({ t: 'reveal', selector: sel })
  } catch { /* nothing to point at is fine */ }
}
whenOpen(() => setTimeout(revealFromSummons, 900))

// ── the keyboard ────────────────────────────────────────────────────────────
// Where the page's text fields are, in viewport coordinates, as last reported.
// Null until the host says — see the pointerdown handler for why that is not the
// same as "none".
let fields = null
const hitsField = (p) => fields === null
  ? null
  : fields.some(([x, y, w, h]) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h)
const reloadBtn = document.getElementById('reloadPage')
reloadBtn.addEventListener('click', () => location.reload())
// Set when the tap landed inside a box the host told us is a text field.
//
// THE LOCAL EVIDENCE WINS. The page's own answer cannot see into a cross-origin
// frame — nothing can — so a "not editable" from it is sometimes just ignorance,
// and acting on it takes the keyboard away from somebody who has just tapped a
// login box. The hit-test knows where the field IS; that beats a no from a
// document that cannot look where the field lives.
let kbFromTap = false
const setKb = (on) => {
  // LOGGED, because "who blurred it" has been the open question for five rounds.
  // Every blur so far has shown focus falling to the body, which looks identical
  // whether this line did it or iOS did. Now the log says which.
  note('setKb', { on })
  if (on) sink.focus({ preventScroll: true }); else sink.blur()
}

/**
 * THE KEYBOARD LOG.
 *
 * Three fixes for the vanishing keyboard have now missed, because the thing
 * that has to be explained cannot be seen from here: the keyboard is a piece of
 * the operating system, and no page is told when it opens or closes. Every fix
 * was therefore a guess about which invisible rule WebKit was applying.
 *
 * visualViewport.height is the one honest witness. It shrinks by the height of
 * the keyboard when the keyboard is up and springs back when it goes, so a
 * shrink followed by a growth IS the keyboard appearing and being taken away —
 * observed rather than inferred. Recorded beside the focus and blur events, it
 * separates the two explanations that look identical from the outside: the field
 * lost focus, or the field kept focus and the keyboard was withdrawn anyway.
 *
 * Bounded and silent: a handful of entries, sent once a couple of seconds after
 * a tap that asked for a keyboard, and never on a tap that did not.
 */
const vv = window.visualViewport
/**
 * Moves the sink to the tap, so iOS has nothing to scroll.
 *
 * Clamped inside the VISUAL viewport rather than the layout one: with a keyboard
 * open those are different rectangles, and the difference is the keyboard — put
 * the input in it and iOS is being asked to reveal something underneath the
 * keyboard, which is the situation this whole comment exists because of.
 */
const placeSink = (e) => {
  const h = vv ? vv.height : window.innerHeight
  const w = vv ? vv.width : window.innerWidth
  sink.style.left = Math.max(0, Math.min(e.clientX - 20, w - 40)) + 'px'
  sink.style.top = Math.max(0, Math.min(e.clientY - 20, h - 40)) + 'px'
}
// A FOCUSABLE STREAM IS A SECOND FOCUS TARGET. The image carries tabindex so a
// desktop user can click it and type; on a phone nobody tabs anywhere, and all
// it can do there is win a tap and take the keyboard with it. Removed where
// there is a finger rather than a pointer.
if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
  img.removeAttribute('tabindex')
}
const kbLog = []
const T0 = Date.now()
// WHO HAS FOCUS AND WHERE THE SINK IS, on every entry. The first version of this
// log proved the field is BLURRED rather than the keyboard withdrawn — which was
// worth knowing and not enough, because it does not say who took the focus or
// where the input had got to by then. Both are one line to record.
const who = () => {
  const a = document.activeElement
  return a ? (a.id || a.tagName.toLowerCase()) : 'none'
}
const place = () => {
  const r = sink.getBoundingClientRect()
  return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',')
}
const note = (what, extra) => {
  if (kbLog.length < 40) {
    kbLog.push({
      at: Date.now() - T0,
      what,
      who: who(),
      sinkAt: place(),
      ...(vv ? { vvTop: Math.round(vv.offsetTop), vvH: Math.round(vv.height) } : {}),
      ...(extra || {}),
    })
  }
}
if (vv) {
  vv.addEventListener('resize', () => note('viewport', { h: Math.round(vv.height) }))
  vv.addEventListener('scroll', () => note('viewportScroll', { top: Math.round(vv.offsetTop) }))
}
sink.addEventListener('focus', () => note('sink focus'))
sink.addEventListener('blur', () => note('sink blur'))
let kbReportAt = 0
function reportKeyboard(hit) {
  note('tap', { onAField: hit, viewport: vv ? Math.round(vv.height) : null })
  clearTimeout(kbReportAt)
  kbReportAt = setTimeout(() => {
    note('settled', {
      stillFocused: document.activeElement === sink,
      viewport: vv ? Math.round(vv.height) : null,
    })
    send({ t: 'diag', what: 'keyboard', events: kbLog.slice() })
    kbLog.length = 0
  }, 2500)
}

// Typed text goes as TEXT, so autocorrect, dictation and emoji survive. The box
// is emptied immediately, so it never accumulates and never double-types.
sink.addEventListener('input', () => {
  const text = sink.value
  sink.value = ''
  if (text) send({ t:'text', text })
})
// Keys that produce no text still have to travel.
sink.addEventListener('keydown', (e) => {
  if (['Backspace','Enter','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape'].includes(e.key)) {
    e.preventDefault()
    send({ t:'key', key:e.key, modifiers:mods(e) })
  }
})

// The way in, for when looking turns into doing. It asks muxpad for the wheel —
// this page is served from muxpad's origin, so it can — and only then starts
// forwarding input.
const takeover = document.getElementById('takeover')
const handback = document.getElementById('handback')
const profileFromPath = () => location.pathname.split('/').filter(Boolean)[1]
const applyWatching = () => {
  document.body.classList.toggle('watching', watching)
  takeover.hidden = !watching
  // The way OUT. Closing the desktop modal hands the browser back; closing a tab
  // on a phone does nothing, so without this there was no gesture for "I have
  // finished" at all and the agent waited out the whole lease — up to ten
  // minutes of nothing, at the end of every handoff, on the surface the handoff
  // was built for.
  handback.hidden = watching
  msg.textContent = watching ? 'watching — press Take over to type' : ''
}
takeover.addEventListener('click', async () => {
  const profile = profileFromPath()
  if (!profile) return
  try {
    const r = await fetch('/api/browsers/' + profile + '/wheel/take', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'viewer-' + profile }),
    })
    if (!r.ok) { msg.textContent = 'could not take the wheel'; return }
    watching = false
    applyWatching()
    announceMode()
  } catch { msg.textContent = 'could not reach muxpad' }
})

// The page opens in whatever mode the link asked for, before anyone clicks.
applyWatching()

/**
 * HANDS IT BACK, deliberately.
 *
 * Not on pagehide, which is the tempting automatic version and is wrong here:
 * iOS fires it when you switch apps, and switching apps is exactly what a login
 * IS — going to get the code out of your email. Releasing there would hand the
 * browser back mid-two-factor. So it is a button, and an abandoned lease is
 * left to lapse on its own.
 */
handback.addEventListener('click', async () => {
  const profile = profileFromPath()
  if (!profile) return
  try {
    const r = await fetch('/api/browsers/' + profile)
    const lease = r.ok ? (await r.json())?.wheel : null
    await fetch('/api/browsers/' + profile + '/wheel', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: lease?.by ?? ('viewer-' + profile) }),
    })
    // Still looking, no longer driving — the agent can get on with it.
    watching = true
    applyWatching()
    // AND IT LEAVES. Done used to hand the wheel back and then sit there: the
    // button removed itself, the stream carried on, and the only way out was the
    // menu button in the corner. Pressing "Done" on a page means you are
    // finished with the page — so it goes back to muxpad, which is where the
    // conversation you came from is.
    // Only when this IS the page. In the desktop modal the viewer is framed, and
    // navigating in there would load muxpad inside its own dialog; the modal
    // already has a way to close.
    if (window.top === window) location.href = '/'
  } catch { msg.textContent = 'could not reach muxpad' }
})

/**
 * TAKES THE WHEEL BECAUSE SOMEBODY TAPPED A TEXT FIELD.
 *
 * And then REPLAYS THE TAP. Input is dropped while watching, so the press that
 * triggered this was thrown away on its way out — and without replaying it the
 * page itself never learns which field was tapped, so the keyboard would be up
 * on this side with nothing focused on the other.
 *
 * A refusal leaves the keyboard where it is rather than yanking it away: being
 * told why, with the keyboard up, beats a keyboard that appears and vanishes,
 * which is the exact failure this whole area has been fighting.
 */
async function takeTheWheel(at) {
  const profile = profileFromPath()
  if (!profile) return
  try {
    const r = await fetch('/api/browsers/' + profile + '/wheel/take', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: 'viewer-' + profile }),
    })
    if (!r.ok) { msg.textContent = 'could not take the wheel — press Take over'; return }
    watching = false
    applyWatching()
    announceMode()
    msg.textContent = 'you are driving now'
    send({ t: 'mouse', type: 'mousePressed', ...at, buttons: 1, clickCount: 1, modifiers: 0 })
    send({ t: 'mouse', type: 'mouseReleased', ...at, buttons: 0, clickCount: 1, modifiers: 0 })
  } catch { msg.textContent = 'could not reach muxpad' }
}

/**
 * NOTICES THAT IT IS OUT OF DATE.
 *
 * Stamped into the page when it was served; compared against whatever the host
 * is serving now, on every connection. Offers a reload rather than performing
 * one: a forced refresh in the middle of a login would throw away a half-typed
 * password, which is worse than running an old script for another minute.
 */
/**
 * SAYS WHAT THIS PAGE IS, to whoever is listening.
 *
 * Every question about this page tonight — is it running the current script, can
 * it type, is it even attached — was answered by guessing from the outside, and
 * several of the guesses were wrong. All three facts are known HERE and were
 * visible nowhere else, so each one cost a round trip to somebody holding a
 * phone. Now it is one line in the host's log.
 *
 * Sent on every connection and again whenever the mode changes, because "it is
 * watching" stops being true the moment somebody takes the wheel, and a log that
 * only records the opening state would be quietly wrong from then on.
 */
function announceMode(sock) {
  const target = sock || ws
  if (!target || target.readyState !== 1) return
  try {
    target.send(JSON.stringify({
      t: 'hello',
      build: MY_BUILD,
      mode: watching ? 'watch' : 'drive',
      w: window.innerWidth,
      h: window.innerHeight,
    }))
  } catch { /* never worth failing a connection over */ }
}

const MY_BUILD = '__MUXPAD_VIEWER_BUILD__'
function noticeBuild(id) {
  if (!id || id === MY_BUILD) return
  msg.textContent = 'muxpad updated — reload this page'
  reloadBtn.hidden = false
}

/**
 * NOTICES THAT THE SIGN-IN WENT THROUGH.
 *
 * Reported from a real login: the page changed to the signed-in page and nothing
 * remarked on it. Everything muxpad knew at that moment said the errand was
 * over, and the person was left to work out for themselves that they were done.
 *
 * The host already measures whether the page has a password field, every two
 * seconds, through frames and shadow roots — that is what offers the Sign in
 * button. A field that was there and is now GONE is the best available evidence
 * that a sign-in succeeded, and it costs nothing extra to watch for.
 *
 * IT DOES NOT HAND THE BROWSER BACK BY ITSELF, deliberately. A two-factor step
 * has no password field either, so "the password field went away" is also what
 * the middle of a login looks like — and releasing the wheel there would let an
 * agent navigate the page while somebody is waiting for a code. So it makes Done
 * unmissable and says why, and the decision stays with the person who can see
 * the screen.
 */
let sawLoginForm = false
function noticeSignIn(present) {
  if (present) { sawLoginForm = true; return }
  if (!sawLoginForm || watching) return
  sawLoginForm = false
  msg.textContent = 'looks like you are signed in — press Done when you have finished'
  handback.classList.add('ready')
}

/**
 * KEEPS THE WHEEL WHILE SOMEBODY IS HOLDING IT.
 *
 * The lease expires after ten minutes so a person who takes the browser, puts
 * the phone down and falls asleep does not own it forever. Renewal lived only
 * in the DESKTOP modal — and on a phone the card opens this page in a tab
 * instead, so nothing renewed at all. Ten minutes is nothing for a real login:
 * a password manager, a code from an email, two-factor on another device. Past
 * that the lease lapsed and an agent could claim the browser and navigate the
 * page out from under somebody who was still typing into it — the exact failure
 * the wheel exists to prevent.
 *
 * Renews at the HALFWAY point, not near the end: a renewal that fires at 90% of
 * the lease is one dropped request away from losing it mid-sentence, and the
 * request costs nothing.
 *
 * Renewed on behalf of whoever holds it, because this page did not necessarily
 * take it — the card usually did. A viewer that is open and driving IS the
 * evidence that a person is still there, which is the whole thing a lease is
 * trying to measure.
 */
const keepTheWheel = async () => {
  if (watching) return
  const profile = profileFromPath()
  if (!profile) return
  try {
    const r = await fetch('/api/browsers/' + profile)
    if (!r.ok) return
    const lease = (await r.json())?.wheel
    if (!lease || lease.holder !== 'human') return
    const total = lease.expiresAt - lease.takenAt
    if (total <= 0) return
    if (Date.now() - lease.takenAt < total / 2) return
    await fetch('/api/browsers/' + profile + '/wheel/renew', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ by: lease.by }),
    })
  } catch { /* the next tick tries again */ }
}
setInterval(keepTheWheel, 30000)

// PASTE, which cannot be left to the page.
//
// On a phone the sink is off-screen, so the system paste menu has nothing to
// appear over. On a desktop it is worse than missing: Cmd+V forwarded as a
// keystroke reaches the REMOTE Chrome and pastes from ITS clipboard, which is
// empty — a gesture that silently does nothing is the most confusing outcome
// available. So both routes read the clipboard HERE and send the text.
//
// The read has to happen inside the gesture; a browser refuses it otherwise.
const pasteFromClipboard = async () => {
  if (watching) return
  try {
    const text = await navigator.clipboard.readText()
    if (text) { send({ t: 'text', text }); msg.textContent = '' }
    else msg.textContent = 'nothing to paste'
  } catch {
    msg.textContent = 'your browser would not share the clipboard'
  }
}
document.getElementById('paste').addEventListener('click', pasteFromClipboard)

// FORWARD IS GONE. Nobody arrives here having gone back — you arrive because an
// agent left you somewhere and you want out of it, which is Back, or the page is
// stale, which is Reload. A third button earning nothing costs width on the one
// screen where width is scarce.
for (const [id, action] of [['navBack','back'],['navReload','reload']]) {
  document.getElementById(id).addEventListener('click', () => send({ t:'nav', action }))
}

// Mobile layout. Defaults ON when the viewer itself is phone-sized, because
// that is the case it exists for and asking somebody to find a toggle first is
// asking them to read a desktop page on a phone once.
const mobileBtn = document.getElementById('mobile')
let mobileOn = false
// The area the page actually has to live in — the frame, not the window, so the
// toolbar is not counted as somewhere a website can paint.
const stageSize = () => {
  const r = document.getElementById('wrap').getBoundingClientRect()
  return { width: Math.round(r.width) || window.innerWidth, height: Math.round(r.height) || window.innerHeight }
}
const setMobile = (on) => {
  mobileOn = on
  mobileBtn.setAttribute('aria-pressed', String(on))
  send({ t:'emulate', mobile: on, ...stageSize() })
}
mobileBtn.addEventListener('click', () => setMobile(!mobileOn))

// TURNING THE PHONE IS A RESIZE, not a new page. Without this the page keeps
// its portrait shape in landscape and the difference is a black half-screen
// beside a column of website. Debounced, because a rotation fires a burst of
// these and each one is a viewport change in a real renderer.
let resizeTimer = null
const onViewportChange = () => {
  note('window resize')
  if (!mobileOn || watching) return
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { resizeTimer = null; note('re-emulating'); setMobile(true) }, 250)
}
window.addEventListener('resize', onViewportChange)
window.addEventListener('orientationchange', onViewportChange)
if (window.innerWidth < 700 && !watching) {
  // After the socket is up, not before — the message would be dropped.
  // On every connection: a restarted host has forgotten it was in phone mode,
  // and a viewer that reconnects into a 1280px page on a phone is the bug this
  // was added to fix, arriving later.
  whenOpen(() => setMobile(true))
}

// Everything is wired; dial. Last rather than first so no handler can fire
// against a half-built page.
/**
 * The sign-in panel.
 *
 * Offered only when the page actually has a password field on screen — the host
 * looks, through frames and shadow roots, and says so. Filling it types the
 * values into the page and closes; it never submits, because pressing the
 * button is the moment you notice it filled the wrong thing.
 */
const loginPanel = document.getElementById('login')
const loginBtn = document.getElementById('signin')
const showLogin = (on) => {
  loginPanel.hidden = !on
  if (on) setTimeout(() => document.getElementById('loginUser').focus(), 50)
}
loginBtn.addEventListener('click', () => showLogin(true))
document.getElementById('loginCancel').addEventListener('click', () => showLogin(false))
document.getElementById('loginForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const user = document.getElementById('loginUser')
  const pass = document.getElementById('loginPass')
  send({ t: 'fillLogin', username: user.value, password: pass.value })
  // Not kept a moment longer than it takes to send.
  user.value = ''
  pass.value = ''
  showLogin(false)
  msg.textContent = 'filled \u2014 check it, then press the page\u2019s own button'
})

connect()

document.getElementById('fpick').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return
  const r = await fetch(base + 'upload', { method:'POST', headers:{ 'x-filename': f.name }, body: await f.arrayBuffer() })
  const j = await r.json().catch(() => ({ ok:false, error:'upload failed' }))
  msg.textContent = j.ok ? '' : j.error
  document.getElementById('drop').classList.remove('on')
})
</script>
`;
