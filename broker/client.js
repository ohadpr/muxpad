// Served only by the protected broker origin; no CDN and no muxpad scripts.
const $ = (id) => document.getElementById(id);
const id = location.pathname.split('/')[2];
const dec = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const enc = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
async function api(path, body) {
  const r = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function ceremony(options, registration) {
  options.challenge = dec(options.challenge);
  if (registration) options.user.id = dec(options.user.id);
  for (const key of ['allowCredentials', 'excludeCredentials'])
    if (options[key]) options[key] = options[key].map((c) => ({ ...c, id: dec(c.id) }));
  const c = await navigator.credentials[registration ? 'create' : 'get']({ publicKey: options });
  const response = { clientDataJSON: enc(c.response.clientDataJSON) };
  if (registration) {
    response.attestationObject = enc(c.response.attestationObject);
    response.transports = c.response.getTransports?.() || [];
  } else {
    response.authenticatorData = enc(c.response.authenticatorData);
    response.signature = enc(c.response.signature);
    response.userHandle = c.response.userHandle ? enc(c.response.userHandle) : null;
  }
  return {
    id: c.id,
    rawId: enc(c.rawId),
    type: c.type,
    response,
    clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment,
  };
}
async function run(fn) {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try {
    await fn();
  } catch (e) {
    $('status').textContent = e.message;
  } finally {
    for (const b of document.querySelectorAll('button')) b.disabled = false;
  }
}
if (location.pathname === '/enroll') {
  $('enrollment').hidden = false;
  $('enroll').onclick = () =>
    run(async () => {
      const secret = $('secret').value;
      $('secret').value = '';
      const options = await api('/registration/options', { secret });
      await api('/registration/verify', { secret, response: await ceremony(options, true) });
      $('status').textContent = 'Owner passkey enrolled. Enrollment is now disabled.';
      $('enrollment').hidden = true;
    });
} else if (id) {
  api(`/requests/${id}`)
    .then((r) => {
      $('payload').textContent = JSON.stringify(
        {
          action: r.action,
          payload: r.payload,
          state: r.state,
          expires: new Date(r.expires).toLocaleString(),
        },
        null,
        2,
      );
      $('actions').hidden = r.state !== 'pending';
    })
    .catch((e) => {
      $('status').textContent = e.message;
    });
  for (const decision of ['approve', 'reject'])
    $(decision).onclick = () =>
      run(async () => {
        const options = await api(`/requests/${id}/options`, { decision });
        const r = await api(`/requests/${id}/decision`, {
          response: await ceremony(options, false),
        });
        $('status').textContent = r.error || r.state;
        $('actions').hidden = true;
      });
}
