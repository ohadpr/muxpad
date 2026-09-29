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
  #bar{flex:none;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;background:#15151c;border-bottom:1px solid #26262f}
  #bar b{color:#6ea8ff;font-variant-numeric:tabular-nums}
  /* Opened in a TAB on a phone there is no chrome around this page and no
     modal to dismiss — without this you are simply stranded. */
  #home{color:#d8d8e2;text-decoration:none;font-size:15px;line-height:1;padding:4px 8px;border-radius:6px;border:1px solid #33333f;flex:none}
  #home:hover{background:#23232e}
  /* Words, not glyphs alone. A row of symbols is a guessing game, and this is a
     surface people reach in the middle of a login they did not plan for. */
  #bar button{flex:none;background:transparent;border:1px solid #33333f;color:#d8d8e2;border-radius:6px;font:inherit;font-size:12px;line-height:1;padding:5px 8px;cursor:pointer;white-space:nowrap}
  #signin{border-color:#3f5d8f;color:#b8cdf0}
  #bar button:hover{background:#23232e}
  #bar button[aria-pressed="true"]{background:#2b3a55;border-color:#4a6ea8;color:#cfe2ff}
  #takeover{background:#c98a2e;border-color:#c98a2e;color:#fff;font-size:11px;white-space:nowrap}
  /* Quieter than "take the wheel": that one is an offer, this is a finish. */
  #handback{border-color:#3d6b4a;color:#9fdcb0;font-size:11px;white-space:nowrap}
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
  /* THE TEXT SINK, AND WHY IT IS ON SCREEN.
     It used to sit at left:-9999px, the classic hidden-input trick, and iOS will
     not hold a keyboard for an input that far outside the viewport: it raises
     one and takes it back within the second. Reported from a real login — "the
     keyboard comes up and immediately comes down", and after two or three tries
     it sticks, which is the page having scrolled the sink into range.
     So it is IN the viewport, one pixel, fully transparent, pinned so no scroll
     can carry it away. Invisible to a person, present to the browser. */
  /* NOT BEHIND ANYTHING. z-index:-1 put it under the page background, and a
     browser does not raise a keyboard for an input it considers invisible — the
     first version of this fix stopped the keyboard appearing at all. It sits in
     the normal stacking order, one transparent pixel, and takes no pointer
     events so it can never swallow a tap meant for the page. */
  #sink{position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;
        margin:0;font-size:16px;background:transparent;color:transparent;pointer-events:none}
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
  <a id="home" href="/" title="back to muxpad">&#9776;</a>
  <button id="navBack" title="back">&#8249; Back</button>
  <button id="navReload" title="reload">&#8635; Reload</button>
  <button id="mobile" title="show the phone version of the site" aria-pressed="false">&#128241; Phone</button>
  <button id="signin" title="sign in with a password manager" hidden>&#128273; Sign in</button>
  <button id="paste" title="paste from your clipboard">&#128203; Paste</button>
  <button id="takeover" title="take the wheel" hidden>Take over</button>
  <button id="handback" title="give the browser back to the agent" hidden>Done</button>
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
    msg.textContent = ''
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
    // The page says a text field is focused, so put a keyboard on the phone.
    // This is what makes tapping a login box behave like tapping a login box.
    if (m.t === 'focus') {
      // The tap already focused the sink; this is the page telling us whether
      // that was right. Keeping it is what makes the keyboard STAY up.
      if (m.editable) setKb(true)
      else if (!kbSticky && !kbFromTap) setKb(false)
      return
    }
    if (m.t === 'fields') { if (Array.isArray(m.rects)) fields = m.rects; return }
    if (m.t === 'login') {
      // Looked up here rather than closed over: this handler is hoisted above
      // the panel's own declarations, so a login report arriving during setup
      // would reach a const that does not exist yet.
      const btn = document.getElementById('signin')
      if (btn) btn.hidden = !(Boolean(m.present) && !watching)
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
img.addEventListener('pointerdown', (e) => {
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
  if (!watching) {
    const p0 = pt(e)
    const hit = p0 ? hitsField(p0) : null
    kbFromTap = hit === true
    if (hit !== false) sink.focus({ preventScroll: true })
  }
  buttons = 1
  img.setPointerCapture?.(e.pointerId)
  const p = pt(e); if (p) send({ t:'mouse', type:'mousePressed', ...p, buttons:1, clickCount:e.detail||1, modifiers:mods(e) })
})
img.addEventListener('pointermove', (e) => {
  const p = pt(e); if (p) send({ t:'mouse', type:'mouseMoved', ...p, buttons, modifiers:mods(e) })
})
const release = (e) => {
  if (!buttons) return
  buttons = 0
  const p = pt(e); if (p) send({ t:'mouse', type:'mouseReleased', ...p, buttons:0, clickCount:1, modifiers:mods(e) })
}
img.addEventListener('pointerup', release)
img.addEventListener('pointercancel', release)
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
const kbBtn = document.getElementById('kb') || { setAttribute() {}, getAttribute: () => null, addEventListener() {} }
// Pressed by hand, the keyboard stays up regardless of what the page says is
// focused — some pages take text without ever focusing an input.
let kbSticky = false
// Set when the tap landed inside a box the host told us is a text field.
//
// THE LOCAL EVIDENCE WINS. The page's own answer cannot see into a cross-origin
// frame — nothing can — so a "not editable" from it is sometimes just ignorance,
// and acting on it takes the keyboard away from somebody who has just tapped a
// login box. The hit-test knows where the field IS; that beats a no from a
// document that cannot look where the field lives.
let kbFromTap = false
const setKb = (on) => {
  kbBtn.setAttribute('aria-pressed', String(on))
  if (on) sink.focus({ preventScroll: true }); else sink.blur()
}
kbBtn.addEventListener('click', () => {
  kbSticky = kbBtn.getAttribute('aria-pressed') !== 'true'
  setKb(kbSticky)
})

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
sink.addEventListener('blur', () => kbBtn.setAttribute('aria-pressed','false'))

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
  msg.textContent = watching ? 'watching — the agent is still working' : ''
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
  } catch { msg.textContent = 'could not reach muxpad' }
})

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
  if (!mobileOn || watching) return
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { resizeTimer = null; setMobile(true) }, 250)
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
