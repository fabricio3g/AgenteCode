// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeferredMessage from './DeferredMessage.svelte';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('deferred transcript content', () => {
  it('loads on approach and retains mounted content when it leaves the viewport', async () => {
    let notify: IntersectionObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe() {} disconnect = disconnect;
    });
    const children = createRawSnippet(() => ({ render: () => '<p>Full retained evidence</p>' }));
    const {container} = render(DeferredMessage, {content:'history '.repeat(100), children});
    expect(container.textContent).not.toContain('Full retained evidence');
    notify([{isIntersecting:true} as IntersectionObserverEntry], {} as IntersectionObserver);
    await tick();
    const paragraph = container.querySelector('p');
    expect(paragraph?.textContent).toBe('Full retained evidence');
    notify([{isIntersecting:false} as IntersectionObserverEntry], {} as IntersectionObserver);
    await tick();
    expect(container.querySelector('p')).toBe(paragraph);
    expect(disconnect).toHaveBeenCalled();
  });
  it('renders the latest or live message immediately without an observer', () => {
    const observer = vi.fn(); vi.stubGlobal('IntersectionObserver', observer);
    const children = createRawSnippet(() => ({ render: () => '<p>Latest response</p>' }));
    const {container} = render(DeferredMessage, {immediate:true, children});
    expect(container.textContent).toContain('Latest response');
    expect(observer).not.toHaveBeenCalled();
  });
});
