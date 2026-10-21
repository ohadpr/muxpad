import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { slackBrokerRequest, slackBrokerURL } from './slack-broker.js';
export const SLACK_VERSION = 'inchat-slack-capabilities-v2-2026-10-20';
export type SetupRelease = {
  id: string;
  kind: 'install' | 'update' | 'enroll' | 'connect';
  label: string;
  command: string;
  sha256: string;
  origin?: string;
  fromVersion?: string;
  platforms?: string[];
};
/** Public release commands only. No execution, no credentials, no arbitrary paths. */
export function setupReleases(origin?: string): SetupRelease[] {
  try {
    const list = JSON.parse(
      readFileSync(new URL('../assets/slack-setup-releases.json', import.meta.url), 'utf8'),
    );
    if (!Array.isArray(list) || list.length > 16) return [];
    return list
      .filter(
        (r: SetupRelease) =>
          r &&
          ['install', 'update', 'enroll', 'connect'].includes(r.kind) &&
          typeof r.id === 'string' &&
          typeof r.command === 'string' &&
          r.command.length <= 65536 &&
          typeof r.label === 'string' &&
          /^[a-f0-9]{64}$/.test(r.sha256) &&
          createHash('sha256').update(r.command).digest('hex') === r.sha256,
      )
      .flatMap((r: SetupRelease) => {
        if (!r.command.includes('__MUXPAD_ORIGIN__')) return [r];
        try {
          const u = new URL(origin || '');
          if (
            u.origin !== origin ||
            u.protocol !== 'https:' ||
            u.username ||
            u.password ||
            !/^[a-z0-9.-]+$/i.test(u.hostname) ||
            !/[a-z]/i.test(u.hostname)
          )
            return [];
          const command = r.command.replaceAll('__MUXPAD_ORIGIN__', u.origin);
          return [{ ...r, command, sha256: createHash('sha256').update(command).digest('hex') }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
export async function slackSetupStatus(origin: string, releases = setupReleases(origin)) {
  let configured = false;
  try {
    configured = !!slackBrokerURL();
  } catch {
    /* Report invalid routing without exposing raw configuration. */
  }
  const at = Date.now();
  const [healthResult, statusResult] = configured
    ? await Promise.allSettled([
        slackBrokerRequest('/health', undefined, 3000),
        slackBrokerRequest('/inline/status', undefined, 3000),
      ])
    : [];
  const version =
    healthResult?.status === 'fulfilled' && typeof healthResult.value.version === 'string'
      ? healthResult.value.version
      : null;
  const status = statusResult?.status === 'fulfilled' ? statusResult.value : null;
  const inline = status?.mode === 'passkey-inline';
  const registered = inline && status.registered === true;
  const service = version ? 'responding' : configured ? 'unreachable' : 'not-configured';
  const next = !version
    ? configured
      ? 'recheck'
      : 'install'
    : version !== SLACK_VERSION
      ? 'update'
      : !inline
        ? 'configure'
        : !registered
          ? 'enroll'
          : 'test';
  return {
    checkedAt: at,
    platform: process.platform,
    architecture: process.arch,
    expectedVersion: SLACK_VERSION,
    version,
    service,
    inline,
    registered,
    teamID: typeof status?.teamID === 'string' ? status.teamID : null,
    next,
    commands: releases
      .filter(
        (r) =>
          (!r.origin || r.origin === origin) &&
          (!r.fromVersion || r.fromVersion === version) &&
          (!r.platforms || r.platforms.includes(`${process.platform}-${process.arch}`)),
      )
      .map((r) => ({ ...r })),
    // A reachable process and enrolled credential do NOT establish Slack API success.
    liveSlackVerified: false,
  };
}
