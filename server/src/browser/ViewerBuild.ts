import { createHash } from 'node:crypto';

/**
 * Telling a viewer that it is out of date.
 *
 * A browser host restarts whenever its code changes. The page already open on
 * somebody's phone does NOT: its socket drops, reconnects to the new process,
 * and frames resume. Nothing about it looks stale — the stream is live, the
 * buttons respond — but the script running it is the one that was served before
 * the restart.
 *
 * This cost a whole evening of testing. Fix after fix was shipped, each verified
 * in the served page, and each tested against a tab that was still running the
 * version from before it. The reports that came back were accurate and described
 * code that had already been replaced, which is the most expensive kind of bug
 * report there is: it sends you looking for a fault that is no longer there.
 *
 * So the page is stamped with the build it was served from, and every connection
 * tells it the build now running. A mismatch means the host has been replaced
 * underneath it, and the page says so and offers a reload. One string compare.
 */

/** The placeholder the served page carries, replaced with the real id. */
export const VIEWER_BUILD_MARK = '__MUXPAD_VIEWER_BUILD__';

/**
 * An id for one version of the page.
 *
 * Content-hashed rather than a version or a timestamp: the question being asked
 * is "is the script in that tab the same script I am serving now", and the only
 * honest answer comes from the bytes. A build number would have to be remembered
 * and bumped, which is a thing people forget precisely when it matters.
 */
export function viewerBuildId(html: string): string {
  return createHash('sha256').update(html).digest('hex').slice(0, 12);
}

/**
 * The page as served: the placeholder replaced by the id of the page itself.
 *
 * Hashed BEFORE substitution, so the id is stable: hashing afterwards would mean
 * the id was computed over bytes containing the id, which cannot be reproduced
 * by anything reading the result.
 */
export function stampViewer(html: string): { html: string; build: string } {
  const build = viewerBuildId(html);
  return { html: html.split(VIEWER_BUILD_MARK).join(build), build };
}
