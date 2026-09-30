// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ContextUsageRing from './ContextUsageRing.svelte';
import ReasoningLevelSelector from './ReasoningLevelSelector.svelte';
import type { ReasoningCapabilities, ReasoningLevel } from '$lib/types/chat';

const store = vi.hoisted(() => ({
  reasoningCapabilities: { supported: true, source: 'api', levels: ['low', 'medium', 'high'], paramShape: 'openai_reasoning_effort' } as ReasoningCapabilities,
  reasoningLevel: null as ReasoningLevel | null,
  backendMode: 'api',
  config: {},
  setReasoningLevel: vi.fn()
}));
vi.mock('$lib/stores/app.svelte', () => ({ appStore: store }));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  store.reasoningCapabilities = { supported: true, source: 'api', levels: ['low', 'medium', 'high'], paramShape: 'openai_reasoning_effort' };
  store.reasoningLevel = null;
  store.setReasoningLevel.mockReset();
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('context details', () => {
  it('shows exact usage, remaining and pricing on hover, then closes on leave', async () => {
    const view = render(ContextUsageRing, { props: { usedTokens: 800, maxTokens: 1000, remaining: 150, estimatedInputCostUsd: 0.02 } });
    const button = view.getByRole('button');
    expect(button.textContent?.trim()).toBe('');
    expect(view.queryByRole('tooltip')).toBeNull();
    await fireEvent.mouseEnter(button);
    const card = view.getByRole('tooltip');
    expect(card.textContent).toContain('800 / 1,000');
    expect(card.textContent).toContain('80%');
    expect(card.textContent).toContain('150 tokens remaining');
    expect(card.textContent).toContain('$0.0200');
    expect(document.body.contains(card)).toBe(true);
    expect(view.container.contains(card)).toBe(false);
    await fireEvent.mouseLeave(button);
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it('opens on keyboard focus and dismisses with Escape or blur', async () => {
    const view = render(ContextUsageRing, { props: { usedTokens: 950, maxTokens: 1000 } });
    const button = view.getByRole('button');
    button.focus();
    await tick();
    expect(view.getByRole('tooltip').id).toBe(button.getAttribute('aria-describedby'));
    await fireEvent.keyDown(button, { key: 'Escape' });
    expect(view.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(button);
    button.blur();
    button.focus();
    await tick();
    expect(view.getByRole('tooltip')).toBeTruthy();
    button.blur();
    await tick();
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it.each([[79, '--ring'], [80, '--warning'], [95, '--destructive']])('uses the threshold colour at %s%%', (used, colour) => {
    const view = render(ContextUsageRing, { props: { usedTokens: Number(used), maxTokens: 100 } });
    expect(view.container.querySelector('.progress')?.getAttribute('style')).toContain(String(colour));
  });

  it('keeps spend and cache information in the card', async () => {
    const view = render(ContextUsageRing, { props: { usedTokens: 1000, maxTokens: 4000,
      spend: { costUsd: 0.04, promptTokens: 180, cacheReadTokens: 820, cacheWriteTokens: 0, estimated: true, unpriced: false } } });
    await fireEvent.mouseEnter(view.getByRole('button'));
    expect(view.getByRole('tooltip').textContent).toContain('Estimated conversation cost: $0.040');
    expect(view.getByRole('tooltip').textContent).toContain('82% from cache');
  });
});

describe('thinking menu', () => {
  it('lists Auto plus the supported levels, each with a hint, and applies a pick', async () => {
    const view = render(ReasoningLevelSelector);
    const button = view.getByRole('button', { name: 'Thinking: Auto' });
    await fireEvent.click(button);
    const items = view.getAllByRole('menuitem');
    expect(items.map((item) => item.querySelector('.truncate')?.textContent)).toEqual(['Auto', 'Low', 'Medium', 'High']);
    expect(items[2].textContent).toContain('Balanced speed and depth');
    expect(items[0].getAttribute('aria-current')).toBe('true');
    await fireEvent.click(items[2]);
    expect(store.setReasoningLevel).toHaveBeenLastCalledWith('medium');
    expect(view.queryByRole('menu')).toBeNull();
  });

  it('marks the selected level and fills the meter to it', async () => {
    store.reasoningLevel = 'high';
    const view = render(ReasoningLevelSelector);
    const button = view.getByRole('button', { name: 'Thinking: High' });
    expect(button.querySelectorAll('.meter .is-on')).toHaveLength(3);
    await fireEvent.click(button);
    const current = view.getAllByRole('menuitem').find((item) => item.getAttribute('aria-current') === 'true');
    expect(current?.textContent).toContain('High');
  });

  it('hides the control for models without reported reasoning levels', () => {
    store.reasoningCapabilities = { supported: false, source: 'unknown', levels: [], paramShape: 'openai_reasoning_effort' };
    const view = render(ReasoningLevelSelector);
    expect(view.queryByRole('button')).toBeNull();
  });
});
