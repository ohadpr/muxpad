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
  #bar{flex:none;display:flex;gap:14px;align-items:center;padding:7px 12px;background:#15151c;border-bottom:1px solid #26262f}
  #bar b{color:#6ea8ff;font-variant-numeric:tabular-nums}
  /* Opened in a TAB on a phone there is no chrome around this page and no
     modal to dismiss — without this you are simply stranded. */
  #home{color:#d8d8e2;text-decoration:none;font-size:15px;line-height:1;padding:4px 8px;border-radius:6px;border:1px solid #33333f;flex:none}
  #home:hover{background:#23232e}
  #bar button{flex:none;background:transparent;border:1px solid #33333f;color:#d8d8e2;border-radius:6px;font:inherit;font-size:15px;line-height:1;padding:4px 9px;cursor:pointer}
  #bar button:hover{background:#23232e}
  #bar button[aria-pressed="true"]{background:#2b3a55;border-color:#4a6ea8;color:#cfe2ff}
  /* The address, truncated from the LEFT: the end of a url is the part that
     says which page you are on. */
  #url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;color:#9a9aab;font-size:11px}
  #msg{color:#e9a}
  /* PINCH AND PAN. The stream is a 1280px page; on a phone, fitted to the
     viewport it is unreadable, and touch-action: none made it unzoomable
     besides. pinch-zoom keeps two-finger gestures for the browser — zoom and
     scroll the FRAME — while one finger still reaches the listeners below and
     becomes a tap or a drag inside the page. */
  #wrap{flex:1;overflow:auto;background:#000;touch-action:pinch-zoom;-webkit-overflow-scrolling:touch}
  #screen{display:block;background:#000;outline:none;transform-origin:0 0}
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
  <span id="url" title="">–</span>
  <span id="msg"></span>
</div>
<div id="wrap"><img id="screen" tabindex="0" alt="the agent's browser"></div>
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
    if (m.t === 'focus') { if (m.editable) setKb(true); return }
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
const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)) }

let buttons = 0
img.addEventListener('pointerdown', (e) => {
  e.preventDefault(); img.focus(); buttons = 1
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
img.addEventListener('keydown', (e) => { e.preventDefault(); send({ t:'key', key:e.key, modifiers:mods(e) }) })

// ── the keyboard ────────────────────────────────────────────────────────────
const sink = document.getElementById('sink')
const kbBtn = document.getElementById('kb')
const setKb = (on) => {
  kbBtn.setAttribute('aria-pressed', String(on))
  if (on) sink.focus({ preventScroll: true }); else sink.blur()
}
kbBtn.addEventListener('click', () => setKb(kbBtn.getAttribute('aria-pressed') !== 'true'))

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
if (window.innerWidth < 700) {
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
