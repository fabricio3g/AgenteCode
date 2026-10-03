// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
const native = vi.hoisted(() => ({ value: true }));
vi.mock('$lib/services/bridge', () => ({ isElectron: () => native.value }));
import { saveChatState, loadChatState } from './storage';
beforeEach(()=>{localStorage.clear(); native.value=true;});
describe('transcript persistence ownership',()=>{
 it('keeps native navigation small and preserves the legacy migration backup',()=>{
  const legacy={chats:[{id:'legacy',messages:[{content:'migration evidence'}]}],currentChatId:'legacy'};
  localStorage.setItem('chatealm_chat_state_v2',JSON.stringify(legacy));
  saveChatState({chats:[{id:'live',messages:[{content:'x'.repeat(2_000_000)}]}],currentChatId:'live',activeSpace:'code'});
  expect(localStorage.getItem('chatealm_chat_state_v2')).toBe(JSON.stringify(legacy));
  expect(localStorage.getItem('chatealm_chat_state_v2.navigation')!.length).toBeLessThan(200);
  const restored=loadChatState(legacy);
  expect(restored.currentChatId).toBe('live');expect(restored.chats).toEqual(legacy.chats);
 });
 it('retains complete chat persistence in the browser fallback',()=>{
  native.value=false;
  const state={chats:[{id:'browser',messages:[{content:'retained transcript'}]}],currentChatId:'browser'};
  saveChatState(state);expect(loadChatState({chats:[],currentChatId:null})).toEqual(state);
 });
});
