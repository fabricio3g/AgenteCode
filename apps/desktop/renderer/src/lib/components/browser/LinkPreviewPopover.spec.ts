// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { addMessages, init, locale } from 'svelte-i18n';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '$lib/locales/en.json';

const mockBridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  isElectron: vi.fn(() => true)
}));

const mockBrowser = vi.hoisted(() => {
  const scopedOpenUrl = vi.fn(async () => undefined);
  const rootOpenUrl = vi.fn(async () => undefined);
  const forScope = vi.fn(() => ({ openUrl: scopedOpenUrl }));
  return { scopedOpenUrl, rootOpenUrl, forScope };
});

vi.mock('$lib/services/bridge', () => mockBridge);
vi.mock('$lib/stores/browser-panel.svelte', () => ({
  browserPanelStore: {
    openUrl: mockBrowser.rootOpenUrl,
    forScope: mockBrowser.forScope
  }
}));

import LinkPreviewPopover from './LinkPreviewPopover.svelte';

addMessages('en', en);
init({ fallbackLocale: 'en', initialLocale: 'en' });

function pointer(type: string, relatedTarget: EventTarget | null = null): Event {
  const EventCtor = window.PointerEvent ?? window.MouseEvent;
  return new EventCtor(type, { bubbles: true, cancelable: true, relatedTarget });
}

beforeEach(() => {
  vi.useFakeTimers();
  locale.set('en');
  mockBridge.isElectron.mockReturnValue(true);
  mockBridge.invoke.mockReset();
  mockBridge.invoke.mockResolvedValue({
    url: 'https://github.com/anomalyco/opencode',
    host: 'github.com',
    title: 'opencode repository',
    description: 'Open source AI coding agent.',
    imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ=='
  });
  mockBrowser.scopedOpenUrl.mockClear();
  mockBrowser.rootOpenUrl.mockClear();
  mockBrowser.forScope.mockClear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountMarkdownLink(url = 'https://github.com/anomalyco/opencode') {
  const host = document.createElement('div');
  host.setAttribute('data-conversation-workspace', 'chat-1');
  host.innerHTML = `
    <div class="markdown-body">
      <a class="site-reference" href="${url}">
        <span class="link-site-icon"><img src="https://github.com/favicon.ico" alt="" /></span>
        <span class="link-label">github.com/anomalyco/opencode</span>
      </a>
    </div>
  `;
  document.body.appendChild(host);
  const anchor = host.querySelector('a')!;
  const img = host.querySelector('img')!;
  const labelSpan = host.querySelector('.link-label')!;
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
    left: 40,
    top: 80,
    right: 220,
    bottom: 100,
    width: 180,
    height: 20,
    x: 40,
    y: 80,
    toJSON: () => ({})
  });
  return { host, anchor, img, labelSpan };
}

it('keeps the hover preview timer alive when pointer moves across child nodes inside a link', async () => {
  render(LinkPreviewPopover);
  const { anchor, img, labelSpan } = mountMarkdownLink();

  img.dispatchEvent(pointer('pointerover'));
  await vi.advanceTimersByTimeAsync(80);

  // Moving from favicon <img> to text <span> inside the same <a> before the delay expires
  // must NOT cancel the hover preview timer.
  img.dispatchEvent(pointer('pointerout', labelSpan));
  labelSpan.dispatchEvent(pointer('pointerover', img));
  await vi.advanceTimersByTimeAsync(150);

  const card = document.querySelector('.link-preview-card');
  expect(card).not.toBeNull();
  expect(mockBridge.invoke).toHaveBeenCalledWith('link_preview', {
    url: 'https://github.com/anomalyco/opencode'
  });
  expect(card?.textContent).toContain('opencode repository');
  expect(card?.querySelector('img[src^="data:image/jpeg"]')).not.toBeNull();
  expect(anchor.isConnected).toBe(true);
});

it('stays open when moving from the link onto the preview card, and closes after leaving', async () => {
  render(LinkPreviewPopover);
  const { anchor } = mountMarkdownLink();

  anchor.dispatchEvent(pointer('pointerover'));
  await vi.advanceTimersByTimeAsync(220);

  const card = document.querySelector('.link-preview-card')!;
  expect(card).not.toBeNull();

  anchor.dispatchEvent(pointer('pointerout', card));
  card.dispatchEvent(pointer('pointerenter', anchor));
  await vi.advanceTimersByTimeAsync(260);
  expect(document.querySelector('.link-preview-card')).not.toBeNull();

  card.dispatchEvent(pointer('pointerleave', document.body));
  await vi.advanceTimersByTimeAsync(200);
  expect(document.querySelector('.link-preview-card')).toBeNull();
});

it('opens plain clicks in the built-in conversation browser and leaves Ctrl+click alone', () => {
  render(LinkPreviewPopover);
  const { anchor } = mountMarkdownLink();

  const plainClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  anchor.dispatchEvent(plainClick);
  expect(plainClick.defaultPrevented).toBe(true);
  expect(mockBrowser.forScope).toHaveBeenCalledWith('chat:chat-1');
  expect(mockBrowser.scopedOpenUrl).toHaveBeenCalledWith('https://github.com/anomalyco/opencode');

  mockBrowser.forScope.mockClear();
  mockBrowser.scopedOpenUrl.mockClear();

  const ctrlClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
  anchor.dispatchEvent(ctrlClick);
  expect(ctrlClick.defaultPrevented).toBe(false);
  expect(mockBrowser.forScope).not.toHaveBeenCalled();
  expect(mockBrowser.scopedOpenUrl).not.toHaveBeenCalled();
});

it('closes the open preview card on Escape', async () => {
  render(LinkPreviewPopover);
  const { anchor } = mountMarkdownLink();

  anchor.dispatchEvent(pointer('pointerover'));
  await vi.advanceTimersByTimeAsync(220);
  expect(document.querySelector('.link-preview-card')).not.toBeNull();

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('.link-preview-card')).toBeNull();
});
