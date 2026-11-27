import { describe, expect, it } from 'vitest';
import { EMPTY_NAV, canStep, settle, step, visit, type NavLocation } from './nav-history';

const at = (chatId: string | null, extra: Partial<NavLocation> = {}): NavLocation => ({
  space: 'home',
  chatId,
  view: 'chat',
  artifactKey: null,
  settings: false,
  ...extra
});

describe('nav history', () => {
  it('records each new place once', () => {
    let state = visit(EMPTY_NAV, at('a'));
    state = visit(state, at('a'));
    state = visit(state, at('b'));
    expect(state.entries.map((entry) => entry.chatId)).toEqual(['a', 'b']);
    expect(state.index).toBe(1);
  });

  it('steps back and forward within bounds', () => {
    let state = visit(visit(EMPTY_NAV, at('a')), at('b'));
    expect(canStep(state, 1)).toBe(false);
    state = step(state, -1);
    expect(state.entries[state.index].chatId).toBe('a');
    expect(canStep(state, -1)).toBe(false);
    expect(step(state, -1)).toBe(state);
    expect(step(state, 1).index).toBe(1);
  });

  it('drops forward history when going somewhere new', () => {
    let state = visit(visit(visit(EMPTY_NAV, at('a')), at('b')), at('c'));
    state = step(step(state, -1), -1);
    state = visit(state, at('d'));
    expect(state.entries.map((entry) => entry.chatId)).toEqual(['a', 'd']);
    expect(canStep(state, 1)).toBe(false);
  });

  it('treats Settings and library views as places of their own', () => {
    let state = visit(EMPTY_NAV, at('a'));
    state = visit(state, at('a', { settings: true }));
    state = visit(state, at('a', { view: 'files' }));
    expect(state.entries).toHaveLength(3);
  });

  it('keeps only the newest entries past the limit', () => {
    let state = EMPTY_NAV;
    for (let index = 0; index < 5; index += 1) state = visit(state, at(String(index)), 3);
    expect(state.entries.map((entry) => entry.chatId)).toEqual(['2', '3', '4']);
    expect(state.index).toBe(2);
  });

  it('corrects the current entry when a restore lands elsewhere', () => {
    const state = step(visit(visit(EMPTY_NAV, at('a')), at('b')), -1);
    const settled = settle(state, at('c'));
    expect(settled.entries.map((entry) => entry.chatId)).toEqual(['c', 'b']);
    expect(settled.index).toBe(0);
  });
});
