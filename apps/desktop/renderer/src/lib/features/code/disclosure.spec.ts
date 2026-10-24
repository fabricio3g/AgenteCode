// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { DisclosureStore, disclosure, disclosureKey } from './disclosure-state.svelte';

afterEach(() => disclosure.clear());

it('answers with the caller default until the reader chooses', () => {
  expect(disclosure.isOpen('chat:m:s-1', false)).toBe(false);
  expect(disclosure.isOpen('chat:m:s-1', true)).toBe(true);
});

it('remembers a choice across a remount, which is the whole point', () => {
  const key = disclosureKey('chat-1', 'msg-1', 's-step');
  disclosure.toggle(key, false);
  // A remount reads the same key through a fresh component.
  expect(disclosure.isOpen(key, false)).toBe(true);
  disclosure.toggle(key, false);
  expect(disclosure.isOpen(key, false)).toBe(false);
});

it('keeps two messages apart even when their entry keys collide', () => {
  disclosure.set(disclosureKey('chat-1', 'msg-1', 't-0'), true);
  expect(disclosure.isOpen(disclosureKey('chat-1', 'msg-2', 't-0'), false)).toBe(false);
});

it('forgets one conversation without touching another', () => {
  disclosure.set(disclosureKey('chat-1', 'msg-1', 's-1'), true);
  disclosure.set(disclosureKey('chat-2', 'msg-1', 's-1'), true);
  disclosure.forget('chat-1');
  expect(disclosure.isOpen(disclosureKey('chat-1', 'msg-1', 's-1'), false)).toBe(false);
  expect(disclosure.isOpen(disclosureKey('chat-2', 'msg-1', 's-1'), false)).toBe(true);
});

it('drops the oldest rows once a long session outgrows the bound', () => {
  const bounded = new DisclosureStore(4);
  for (let index = 0; index < 6; index++) bounded.set(`chat:m:s-${index}`, true);
  expect(bounded.isOpen('chat:m:s-0', false)).toBe(false);
  expect(bounded.isOpen('chat:m:s-1', false)).toBe(false);
  expect(bounded.isOpen('chat:m:s-5', false)).toBe(true);
});
