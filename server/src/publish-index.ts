/**
 * THE INDEX MUXPAD WRITES WHEN THE ARTIFACT ISN'T A WEB PAGE.
 *
 * `publish` hands back a DIRECTORY url (`/<slug>/`), and the public server
 * serves `index.html` or nothing — no listings, by design. So publishing a
 * single `.md`, a `.mp3`, a pair of `.stl` files produced a link that 404'd
 * while the files themselves served fine one segment away. 21 of 208 live
 * slugs were in that state; the symptom reached the user twice as "not found"
 * and was worked around by republishing by hand.
 *
 * Rather than teach the server to list directories (it must not — one opaque
 * origin, no discovery), the PUBLISHER writes an index. It is deliberately a
 * single self-contained file with no network dependency beyond its own
 * siblings, because it is served from a sandboxed opaque origin.
 *
 * Markdown gets rendered, because that is what most of these are and a reader
 * who asked for a proposal should get a proposal rather than a download. The
 * renderer is small on purpose: headings, emphasis, code, lists, quotes, links
 * and paragraphs. Anything it does not know survives as its own text.
 */

const MD_RE = /\.(md|markdown)$/i;
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|ogg|flac)$/i;
const VIDEO_RE = /\.(mp4|webm|mov)$/i;
const TEXT_RE = /\.(txt|log|csv|json|ya?ml|toml)$/i;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
}

const STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1.25rem 4rem;font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  background:Canvas;color:CanvasText}
main{max-width:46rem;margin:0 auto}
h1,h2,h3{line-height:1.25;margin:2rem 0 .6rem}
h1{font-size:1.6rem}h2{font-size:1.28rem}h3{font-size:1.08rem}
p,ul,ol,blockquote,pre{margin:0 0 1rem}
a{color:#3b6fd4}@media(prefers-color-scheme:dark){a{color:#7aa7f0}}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:color-mix(in srgb,CanvasText 8%,Canvas);
  padding:.12em .35em;border-radius:4px}
pre{background:color-mix(in srgb,CanvasText 8%,Canvas);padding:.9rem 1rem;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}
blockquote{border-left:3px solid color-mix(in srgb,CanvasText 22%,Canvas);padding-left:1rem;
  margin-left:0;color:color-mix(in srgb,CanvasText 70%,Canvas)}
img,video{max-width:100%;height:auto;border-radius:8px}
audio{width:100%}
ul.files{list-style:none;padding:0}
ul.files li{padding:.55rem 0;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,Canvas)}
.hint{color:color-mix(in srgb,CanvasText 55%,Canvas);font-size:.85rem;margin-top:2.5rem}`;

/** A deliberately small markdown subset, inlined so the page needs nothing. */
const MD_JS = `const md=(src)=>{
const esc=(s)=>s.replace(/[&<>]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const inline=(s)=>esc(s)
  .replace(/\`([^\`]+)\`/g,(_,c)=>'<code>'+c+'</code>')
  .replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g,'<img alt="$1" src="$2">')
  .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,'<a href="$2" rel="noreferrer">$1</a>')
  .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
  .replace(/(^|[^*])\\*([^*]+)\\*/g,'$1<em>$2</em>');
const out=[];let i=0;const L=src.replace(/\\r\\n?/g,'\\n').split('\\n');
while(i<L.length){const l=L[i];
 if(/^\`\`\`/.test(l)){const b=[];i++;while(i<L.length&&!/^\`\`\`/.test(L[i]))b.push(L[i++]);i++;
   out.push('<pre><code>'+esc(b.join('\\n'))+'</code></pre>');continue}
 const h=l.match(/^(#{1,6})\\s+(.*)$/);
 if(h){out.push('<h'+h[1].length+'>'+inline(h[2])+'</h'+h[1].length+'>');i++;continue}
 if(/^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\1]*$/.test(l)){out.push('<hr>');i++;continue}
 if(/^\\s*>/.test(l)){const b=[];while(i<L.length&&/^\\s*>/.test(L[i]))b.push(L[i++].replace(/^\\s*>\\s?/,''));
   out.push('<blockquote>'+md(b.join('\\n'))+'</blockquote>');continue}
 const ol=/^\\s*\\d+[.)]\\s+/,ul=/^\\s*[-*+]\\s+/;
 if(ul.test(l)||ol.test(l)){const ordered=ol.test(l)&&!ul.test(l);const re=ordered?ol:ul;const items=[];
   while(i<L.length&&re.test(L[i]))items.push(inline(L[i++].replace(re,'')));
   out.push('<'+(ordered?'ol':'ul')+'>'+items.map((t)=>'<li>'+t+'</li>').join('')+'</'+(ordered?'ol':'ul')+'>');continue}
 if(!l.trim()){i++;continue}
 const para=[];while(i<L.length&&L[i].trim()&&!/^(#{1,6}\\s|\\s*[-*+]\\s|\\s*\\d+[.)]\\s|\\s*>|\`\`\`)/.test(L[i]))para.push(L[i++]);
 out.push('<p>'+inline(para.join(' '))+'</p>')}
return out.join('\\n')};`;

/**
 * An index for a slug whose content is not itself a web page.
 *
 * One markdown file → it is rendered as the page. Otherwise a plain list, with
 * images, audio and video shown inline rather than linked, because a published
 * recording whose link opens a file picker has not been published to anybody.
 */
export function indexForFiles(files: string[], title?: string): string {
  const mds = files.filter((f) => MD_RE.test(f));
  const heading = esc(title ?? '');
  if (files.length >= 1 && mds.length === 1 && files.length === 1) {
    const only = mds[0] as string;
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading || esc(only)}</title><style>${STYLE}</style>
<main><div id="doc">Loading ${esc(only)}…</div></main>
<script>${MD_JS}
fetch(${JSON.stringify(encodeURIComponent(only))}).then((r)=>r.text()).then((t)=>{
  document.getElementById('doc').innerHTML=md(t);
  const h1=document.querySelector('h1');if(h1)document.title=h1.textContent;
}).catch(()=>{document.getElementById('doc').innerHTML=
  '<p>Could not load <a href="${esc(only)}">${esc(only)}</a>.</p>';});
</script>`;
  }
  const rows = files
    .map((f) => {
      const href = encodeURIComponent(f);
      const name = esc(f);
      if (IMG_RE.test(f)) return `<li><img src="${href}" alt="${name}"><div>${name}</div></li>`;
      if (AUDIO_RE.test(f))
        return `<li><div>${name}</div><audio controls src="${href}"></audio></li>`;
      if (VIDEO_RE.test(f))
        return `<li><div>${name}</div><video controls src="${href}"></video></li>`;
      const kind = MD_RE.test(f) || TEXT_RE.test(f) ? '' : ' <small>(download)</small>';
      return `<li><a href="${href}">${name}</a>${kind}</li>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading || 'Published files'}</title><style>${STYLE}</style>
<main>${heading ? `<h1>${heading}</h1>` : ''}<ul class="files">
${rows}
</ul><p class="hint">Published by muxpad.</p></main>`;
}
