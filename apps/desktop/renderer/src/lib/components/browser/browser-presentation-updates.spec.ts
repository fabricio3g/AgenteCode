// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { affectsBrowserPresentation } from './browser-presentation-updates';
import { sameBrowserPresentation } from '$shared/browser-presentation';
afterEach(() => document.body.replaceChildren());
it('ignores transcript streaming but reacts to overlay opening, moving and removal', () => {
  document.body.innerHTML = '<div id="chat"><p>Reply</p></div><div class="workspace-panel"><div id="viewport"></div></div>';
  const viewport = document.getElementById('viewport')!, chat = document.getElementById('chat')!;
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  chat.firstElementChild!.textContent = 'Reply with another token'; chat.setAttribute('style', 'height:100px');
  expect(affectsBrowserPresentation(observer.takeRecords(), viewport)).toBe(false);
  const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); document.body.append(menu);
  expect(affectsBrowserPresentation(observer.takeRecords(), viewport)).toBe(true);
  menu.style.left = '100px'; expect(affectsBrowserPresentation(observer.takeRecords(), viewport)).toBe(true);
  menu.remove(); expect(affectsBrowserPresentation(observer.takeRecords(), viewport)).toBe(true);
  viewport.parentElement!.style.left = '200px'; expect(affectsBrowserPresentation(observer.takeRecords(), viewport)).toBe(true);
  observer.disconnect();
});
it('deduplicates identical geometry while retaining exposure, occlusion and resize changes', () => {
  const value = { exposed: true, occluded: false, bounds: { x: 1, y: 2, width: 400, height: 300 } };
  expect(sameBrowserPresentation(value, { ...value, bounds: { ...value.bounds } })).toBe(true);
  for (const next of [{ ...value, exposed: false }, { ...value, occluded: true }, { ...value, bounds: null }, { ...value, bounds: { ...value.bounds, width: 500 } }]) expect(sameBrowserPresentation(value, next)).toBe(false);
});

it('updates browser occlusion when the ghost sidebar opens or closes', () => {
  document.body.innerHTML = '<aside class="sidebar-view-full"></aside><div id="viewport"></div>';
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { subtree: true, attributes: true });
  const sidebar = document.querySelector('aside')!;
  sidebar.classList.add('preview');
  expect(affectsBrowserPresentation(observer.takeRecords(), document.getElementById('viewport')!)).toBe(true);
  sidebar.classList.remove('preview');
  expect(affectsBrowserPresentation(observer.takeRecords(), document.getElementById('viewport')!)).toBe(true);
  observer.disconnect();
});
