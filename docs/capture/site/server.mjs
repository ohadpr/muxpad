import { readFileSync } from 'node:fs';
// Two invented sites on loopback: Trellis's billing docs, and an internal app
// ("Ledgerkit Ops") that embeds a muxpad chat with ?embed=1.
import { createServer } from 'node:http';
const page = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const h = (req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (host.startsWith('docs.trellis')) return res.end(page('./trellis.html'));
  if (host.startsWith('ops'))
    return res.end(
      page('./ops.html').replaceAll(
        '%SRC%',
        new URL(req.url, 'http://x').searchParams.get('src') || '',
      ),
    );
  res.statusCode = 404;
  res.end('no');
};
createServer(h).listen(17879, '127.0.0.1');
createServer(h).listen(17879, '::1');
import { createServer as createTls } from 'node:https';
const tls = {
  key: readFileSync(new URL('./key.pem', import.meta.url)),
  cert: readFileSync(new URL('./cert.pem', import.meta.url)),
};
createTls(tls, h).listen(17880, '127.0.0.1');
createTls(tls, h).listen(17880, '::1');
