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
  #back{color:#d8d8e2;text-decoration:none;font-size:17px;line-height:1;padding:2px 6px;border-radius:6px;border:1px solid #33333f}
  #back:hover{background:#23232e}
  #msg{color:#e9a}
  #wrap{flex:1;overflow:auto;display:grid;place-items:start center;padding:8px}
  #screen{display:block;max-width:100%;background:#000;touch-action:none;outline:none}
  #drop{position:fixed;inset:0;background:#000c;display:none;place-items:center;padding:20px;text-align:center}
  #drop.on{display:grid}
</style>
<div id="bar">
  <a id="back" href="/" title="back to muxpad">&#8592;</a>
  <span>handoff</span>
  <span>fps <b id="fps">–</b></span>
  <span><b id="kb">–</b> KB</span>
  <span id="msg"></span>
</div>
<div id="wrap"><img id="screen" tabindex="0" alt="the agent's browser"></div>
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
ws.onmessage = (e) => {
  if (typeof e.data === 'string') {
    const m = JSON.parse(e.data)
    if (m.t === 'frame') { meta = m.meta; document.getElementById('kb').textContent = (m.bytes/1024).toFixed(0) }
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
  if (times.length > 1) {
    const fps = 1000 * (times.length - 1) / (times[times.length-1] - times[0])
    document.getElementById('fps').textContent = fps.toFixed(0)
  }
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

document.getElementById('fpick').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return
  const r = await fetch(base + 'upload', { method:'POST', headers:{ 'x-filename': f.name }, body: await f.arrayBuffer() })
  const j = await r.json().catch(() => ({ ok:false, error:'upload failed' }))
  msg.textContent = j.ok ? '' : j.error
  document.getElementById('drop').classList.remove('on')
})
</script>
`;
