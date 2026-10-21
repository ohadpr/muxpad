import { lstatSync, readFileSync } from 'node:fs';
/** The muxpad process holds no broker credential or approval key. */
export function slackBrokerURL(): string | null {
  let value = process.env.MUXPAD_SLACK_BROKER_URL;
  if (!value && process.platform === 'darwin') {
    // The installer publishes only routing metadata; never open its private state/config.
    try {
      for (const path of ['/Library/muxpad-broker', '/Library/muxpad-broker/setup-public.json']) {
        const st = lstatSync(path);
        if (
          st.isSymbolicLink() ||
          st.uid !== 0 ||
          st.mode & 0o022 ||
          (st.isFile() && st.nlink !== 1)
        )
          throw Error('Untrusted routing metadata');
      }
      const p = JSON.parse(readFileSync('/Library/muxpad-broker/setup-public.json', 'utf8'));
      if (p.version === 1 && typeof p.brokerURL === 'string') value = p.brokerURL;
    } catch {
      /* No routing metadata: Settings will show installation instructions. */
    }
  }
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('MUXPAD_SLACK_BROKER_URL must be a protected HTTPS origin');
  return url.origin;
}

export async function slackBrokerRequest(
  path: string,
  body?: unknown,
  timeoutMS = 35_000,
): Promise<Record<string, unknown>> {
  const base = slackBrokerURL();
  if (!base) throw new Error('Slack broker is not configured');
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMS),
    redirect: 'error',
  });
  if (!response.ok)
    throw Object.assign(new Error('Protected Slack broker refused the request'), {
      status: response.status,
    });
  return (await response.json()) as Record<string, unknown>;
}
