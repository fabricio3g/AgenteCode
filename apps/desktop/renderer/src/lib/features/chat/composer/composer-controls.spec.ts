// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ContextUsageRing from './ContextUsageRing.svelte';
import ReasoningLevelSelector from './ReasoningLevelSelector.svelte';
import type { ReasoningCapabilities, ReasoningLevel } from '$lib/types/chat';

const store = vi.hoisted(() => ({
  reasoningCapabilities: { supported: true, source: 'catalog', levels: ['low', 'medium', 'high'] } as ReasoningCapabilities,
  reasoningLevel: null as ReasoningLevel | null,
  backendMode: 'api',
  config: {},
  setReasoningLevel: vi.fn()
}));
vi.mock('$lib/stores/app.svelte', () => ({ appStore: store }));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  store.reasoningCapabilities = { supported: true, source: 'catalog', levels: ['low', 'medium', 'high'] };
  store.reasoningLevel = null;
  // The real store keeps the choice, so the arrows read their own result.
  store.setReasoningLevel = vi.fn((level: ReasoningLevel | null) => { store.reasoningLevel = level; });
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The rail places a stop as `calc(7px + <fraction> * (100% - 14px))`. */
function fractionOf(style: string | null): number {
  return Number(/calc\([^)]*?([\d.]+)\s*\*\s*\(/.exec(style ?? '')?.[1]);
}

function mockRailBounds(rail: HTMLElement): void {
  const box = rail.getBoundingClientRect();
  vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({ ...box, left: 0, width: 400 });
}

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

describe('thinking level', () => {
  it('marks one stop per level between the named ends of the scale', async () => {
    store.reasoningCapabilities = {
      supported: true,
      source: 'catalog',
      levels: ['minimal', 'low', 'medium', 'high', 'xhigh']
    };
    const view = render(ReasoningLevelSelector);
    await fireEvent.click(view.getByRole('button', { name: 'Thinking: Auto' }));

    const rail = view.getByRole('slider', { name: 'Thinking' });
    // Auto plus the five levels, evenly spread from one end to the other.
    const ticks = [...rail.querySelectorAll('.tick')];
    // Each stop names its level and what it means, so the bar can stay wordless.
    expect(ticks.map((tick) => tick.getAttribute('title'))).toEqual([
      'Auto — The model decides how long to think',
      'Minimal — A quick glance before answering',
      'Low — Quick answers for simple questions',
      'Medium — Balanced speed and depth',
      'High — Thinks longer on hard problems',
      'Extra high — Very thorough; slower and uses more tokens'
    ]);
    expect(ticks.map((tick) => fractionOf(tick.getAttribute('style')))).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
        const card = view.getByRole('dialog');
    expect(card.textContent).toContain('Faster');
    expect(card.textContent).toContain('Deeper');
    expect(rail.getAttribute('aria-valuenow')).toBe('0');
    expect(rail.getAttribute('aria-valuemax')).toBe('5');
  });

  // The store mock is a plain object, not a rune, so derived values only settle
  // on render. Each key gets a fresh mount at the level it should start from.
  it.each([
    ['ArrowRight', null, 'low'],
    ['ArrowDown', null, 'low'],
    ['ArrowLeft', 'medium', 'low'],
    ['ArrowUp', 'medium', 'low'],
    ['Home', 'medium', null],
    ['End', 'low', 'high']
  ])('%s from the level in effect moves one step', async (key, from, to) => {
    store.reasoningLevel = from as ReasoningLevel | null;
    const view = render(ReasoningLevelSelector);
    await fireEvent.click(view.getByRole('button'));
    const rail = view.getByRole('slider');
    expect(document.activeElement).toBe(rail);
    await fireEvent.keyDown(rail, { key });
    expect(store.setReasoningLevel).toHaveBeenLastCalledWith(to);
  });

  it('snaps a pointer to the level under it and closes on Escape', async () => {
    store.reasoningLevel = 'low';
    const view = render(ReasoningLevelSelector);
    const button = view.getByRole('button', { name: 'Thinking: Low' });
    await fireEvent.click(button);
    const rail = view.getByRole('slider');

    // Three gaps across 400px: 300px is three quarters, so the next level up.
    mockRailBounds(rail);
    await fireEvent.pointerDown(rail, { clientX: 300, pointerId: 1 });
    expect(store.setReasoningLevel).toHaveBeenLastCalledWith('medium');

    await fireEvent.keyDown(rail, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('fills to the chosen level and leaves naming it to the trigger', async () => {
    store.reasoningLevel = 'high';
    const view = render(ReasoningLevelSelector);
    const button = view.getByRole('button', { name: 'Thinking: High' });
    expect(button.querySelectorAll('.meter .is-on')).toHaveLength(3);

    await fireEvent.click(button);
    const rail = view.getByRole('slider');
    expect(rail.getAttribute('aria-valuetext')).toBe('High');
    expect(rail.querySelectorAll('.tick.is-on')).toHaveLength(4);
    // The card does not repeat what the trigger already shows.
    const card = view.getByRole('dialog');
    expect(card.textContent).not.toContain('High');
    expect(card.querySelector('.meter')).toBeNull();
    // A level without a budget adds nothing between the ends.
    expect(card.querySelector('.effort-budget')).toBeNull();
  });

  it('shows a budget only for levels that have one', async () => {
    store.reasoningCapabilities = {
      supported: true,
      source: 'template',
      levels: ['off', 'low', 'max'],
      budgets: { low: 512 }
    };
    store.reasoningLevel = 'low';
    let view = render(ReasoningLevelSelector);
    await fireEvent.click(view.getByRole('button'));
    expect(view.getByRole('dialog').querySelector('.effort-budget')?.textContent).toBe('up to 512 tokens');
    cleanup();

    // Max is sized by the provider: nothing claims it is unlimited.
    store.reasoningLevel = 'max';
    view = render(ReasoningLevelSelector);
    await fireEvent.click(view.getByRole('button'));
    expect(view.getByRole('dialog').querySelector('.effort-budget')).toBeNull();
    expect(view.getByRole('dialog').textContent).not.toContain('limit');
  });

  it('names what Auto resolves to when the provider says', () => {
    store.reasoningCapabilities = { supported: true, source: 'live', levels: ['low', 'high'], default: 'high' };
    const view = render(ReasoningLevelSelector);
    expect(view.getByRole('button', { name: 'Thinking: Auto · High' })).toBeTruthy();
  });

  it('sends the fill sheen once, on a change, and not on open or on the level already chosen', async () => {
    store.reasoningLevel = 'low';
    const view = render(ReasoningLevelSelector);
    await fireEvent.click(view.getByRole('button'));

    // Opening is quiet: the sheen sits at its start with no animation.
    let sheen = view.getByRole('slider').querySelector('.sheen')!;
    expect(sheen.classList.contains('is-live')).toBe(false);

    const rail = view.getByRole('slider');
    mockRailBounds(rail);

    // A pointer landing on the level in effect changes nothing, so nothing plays.
    await fireEvent.pointerDown(rail, { clientX: 100, pointerId: 1 });
    expect(store.setReasoningLevel).not.toHaveBeenCalled();
    expect(view.getByRole('slider').querySelector('.sheen')!.classList.contains('is-live')).toBe(false);

    await fireEvent.pointerDown(rail, { clientX: 300, pointerId: 2 });
    expect(store.setReasoningLevel).toHaveBeenLastCalledWith('medium');
    sheen = view.getByRole('slider').querySelector('.sheen')!;
    expect(sheen.classList.contains('is-live')).toBe(true);
  });

  it('hides the control for models without reported reasoning levels', () => {
    store.reasoningCapabilities = { supported: false, source: 'unknown', levels: [] };
    const view = render(ReasoningLevelSelector);
    expect(view.queryByRole('button')).toBeNull();
    expect(view.container.textContent).not.toContain('Always thinking');
  });

  it('says a model always thinks when its provider offers nothing to pick', () => {
    store.reasoningCapabilities = { supported: false, source: 'live', levels: [], mandatory: true };
    const view = render(ReasoningLevelSelector);
    expect(view.queryByRole('button')).toBeNull();
    expect(view.container.textContent).toContain('Always thinking');
  });
});
