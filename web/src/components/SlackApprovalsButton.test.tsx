import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SlackApprovalsButton } from './SlackApprovalsButton';
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(url: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ approval_url: url }) }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<SlackApprovalsButton approvalURL={url} />));
  return host;
}
it('uses one native Review link with opener isolation and no script-popup inference', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const h = await mount('https://secure.example.test/review');
  const link = h.querySelector('a');
  expect(link?.href).toBe('https://secure.example.test/review');
  expect(link?.target).toBe('_blank');
  expect(link?.rel).toBe('noopener noreferrer');
  expect(h.textContent).toBe('Review');
  expect(h.querySelectorAll('a')).toHaveLength(1);
  expect(open).not.toHaveBeenCalled();
});
it.each([
  'http://secure.example.test/review',
  'https://user:secret@secure.example.test/review',
  'https://secure.example.test/review?approve=true',
  'javascript:alert(1)',
])('does not launch an invalid configured destination: %s', async (url) => {
  const h = await mount(url);
  expect(h.querySelector('a')).toBeNull();
});
