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
  #bar{flex:none;display:flex;gap:7px;align-items:center;padding:7px 10px;background:#15151c;border-bottom:1px solid #26262f}
  #bar b{color:#6ea8ff;font-variant-numeric:tabular-nums}
  /* Opened in a TAB on a phone there is no chrome around this page and no
     modal to dismiss — without this you are simply stranded. */
  #home{color:#d8d8e2;text-decoration:none;font-size:15px;line-height:1;padding:4px 8px;border-radius:6px;border:1px solid #33333f;flex:none}
  #home:hover{background:#23232e}
  #bar button{flex:none;background:transparent;border:1px solid #33333f;color:#d8d8e2;border-radius:6px;font:inherit;font-size:15px;line-height:1;padding:4px 7px;cursor:pointer}
  #bar button:hover{background:#23232e}
  #bar button[aria-pressed="true"]{background:#2b3a55;border-color:#4a6ea8;color:#cfe2ff}
  #takeover{background:#c98a2e;border-color:#c98a2e;color:#fff;font-size:11px;white-space:nowrap}
  /* Watching: the stream is a picture. Say so rather than letting somebody
     press things that quietly go nowhere. */
  body.watching #screen{cursor:default}
  /* The address, truncated from the LEFT: the end of a url is the part that
     says which page you are on. */
  /* The address is the one thing here that is information rather than a control,
     so it gets a floor: buttons give up their slack first, and it never shrinks
     to the two characters it was showing. */
  #url{flex:1 1 92px;min-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;color:#9a9aab;font-size:11px}
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
  #sink{position:absolute;left:-9999px;top:0;width:1px;height:1px;opacity:0;border:0;padding:0}
  #drop{position:fixed;inset:0;background:#000c;display:none;place-items:center;padding:20px;text-align:center}
  #drop.on{display:grid}
</style>
<div id="bar">
  <a id="home" href="/" title="back to muxpad">&#9776;</a>
  <button id="navBack" title="back">&#8249;</button>
  <button id="navFwd" title="forward">&#8250;</button>
  <button id="navReload" title="reload">&#8635;</button>
  <button id="mobile" title="mobile site" aria-pressed="false">&#128241;</button>
  <button id="kb" title="keyboard" aria-pressed="false">&#9000;</button>
  <button id="paste" title="paste" aria-label="paste">&#128203;</button>
  <button id="takeover" title="take the wheel" hidden>take the wheel</button>
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
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + 'ws')
ws.binaryType = 'arraybuffer'

let meta = null, url = null, nw = 0, nh = 0
const times = []

ws.onclose = () => { msg.textContent = 'disconnected — the browser may have restarted' }
ws.onerror = () => { msg.textContent = 'cannot reach the browser' }
const urlEl = document.getElementById('url')
const showUrl = (u) => {
  urlEl.textContent = u || '–'
  urlEl.title = u || ''
}
ws.onmessage = (e) => {
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
const pt = (e) => {
  const r = img.getBoundingClientRect()
  if (!nw || !r.width || !meta) return null
  const scale = meta.deviceWidth / nw
  return { x: (e.clientX - r.left) * (nw / r.width) * scale, y: (e.clientY - r.top) * (nh / r.height) * scale }
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
  if (ws.readyState === 1) ws.send(JSON.stringify(o))
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
ws.addEventListener('open', () => setTimeout(revealFromSummons, 900), { once: true })

// ── the keyboard ────────────────────────────────────────────────────────────
// Where the page's text fields are, in viewport coordinates, as last reported.
// Null until the host says — see the pointerdown handler for why that is not the
// same as "none".
let fields = null
const hitsField = (p) => fields === null
  ? null
  : fields.some(([x, y, w, h]) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h)
const kbBtn = document.getElementById('kb')
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
const profileFromPath = () => location.pathname.split('/').filter(Boolean)[1]
const applyWatching = () => {
  document.body.classList.toggle('watching', watching)
  takeover.hidden = !watching
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
applyWatching()

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

for (const [id, action] of [['navBack','back'],['navFwd','forward'],['navReload','reload']]) {
  document.getElementById(id).addEventListener('click', () => send({ t:'nav', action }))
}

// Mobile layout. Defaults ON when the viewer itself is phone-sized, because
// that is the case it exists for and asking somebody to find a toggle first is
// asking them to read a desktop page on a phone once.
const mobileBtn = document.getElementById('mobile')
let mobileOn = false
const setMobile = (on) => {
  mobileOn = on
  mobileBtn.setAttribute('aria-pressed', String(on))
  send({ t:'emulate', mobile: on })
}
mobileBtn.addEventListener('click', () => setMobile(!mobileOn))
if (window.innerWidth < 700 && !watching) {
  // After the socket is up, not before — the message would be dropped.
  const arm = () => setMobile(true)
  if (ws.readyState === 1) arm(); else ws.addEventListener('open', arm, { once: true })
}

document.getElementById('fpick').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return
  const r = await fetch(base + 'upload', { method:'POST', headers:{ 'x-filename': f.name }, body: await f.arrayBuffer() })
  const j = await r.json().catch(() => ({ ok:false, error:'upload failed' }))
  msg.textContent = j.ok ? '' : j.error
  document.getElementById('drop').classList.remove('on')
})
</script>
`;
