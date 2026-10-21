import { useEffect } from 'react';
import { startNoticeDiagnostic } from '../lib/slack-notice-diagnostic';
/** Root sibling, deliberately independent of any pane/alert mounting path. */
export function SlackNoticeDiagnostic() {
  useEffect(() => startNoticeDiagnostic(), []);
  return null;
}
