// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const native = vi.hoisted(() => ({ value: true }));
vi.mock('$lib/services/bridge', () => ({ isElectron: () => native.value }));
import { saveChatState, loadChatState, loadChatStateFromDb } from './storage';
beforeEach(()=>{localStorage.clear(); native.value=true;});
afterEach(()=>{ delete (window as any).electronAPI; vi.restoreAllMocks(); });
describe('transcript persistence ownership',()=>{
 it('keeps native navigation small and never parses the legacy backup on startup',()=>{
  const legacy={chats:[{id:'legacy',messages:[{content:'migration evidence'}]}],currentChatId:'legacy'};
  localStorage.setItem('chatealm_chat_state_v2',JSON.stringify(legacy));
  saveChatState({chats:[{id:'live',messages:[{content:'x'.repeat(2_000_000)}]}],currentChatId:'live',activeSpace:'code'});
  expect(localStorage.getItem('chatealm_chat_state_v2')).toBe(JSON.stringify(legacy));
  expect(localStorage.getItem('chatealm_chat_state_v2.navigation')!.length).toBeLessThan(200);
  const read=vi.spyOn(Storage.prototype,'getItem');
  const restored=loadChatState({chats:[] as unknown[],currentChatId:null as string|null});
  expect(restored.currentChatId).toBe('live');expect(restored.chats).toEqual([]);
  expect(read.mock.calls.map(([key])=>key)).not.toContain('chatealm_chat_state_v2');
 });
 it('retains complete chat persistence in the browser fallback',()=>{
  native.value=false;
  const state={chats:[{id:'browser',messages:[{content:'retained transcript'}]}],currentChatId:'browser'};
  saveChatState(state);expect(loadChatState({chats:[],currentChatId:null})).toEqual(state);
 });
 it('copies legacy-only payloads into SQLite once, then stops reading the backup',async()=>{
  const steps=[{id:'s1',type:'tool'}];
  localStorage.setItem('chatealm_db_migrated','1');
  localStorage.setItem('chatealm_chat_state_v2',JSON.stringify({chats:[{id:'a',messages:[{id:'m1',content:'hi',agentSteps:steps}]}]}));
  const saved:unknown[]=[];
  (window as any).electronAPI={invoke:vi.fn(async(channel:string,args?:{session:unknown})=>{
   if(channel==='chat_db_load_all')return [{id:'a',messages:[{id:'m1',content:'hi',agentSteps:[]}]}];
   if(channel==='chat_db_load_folders')return [];
   if(channel==='chat_db_save_session'){saved.push(args!.session);return true;}
  })};
  const first=await loadChatStateFromDb();
  expect(first!.chats[0].messages[0].agentSteps).toEqual(steps);
  expect(saved).toHaveLength(1);
  // SQLite now holds what only the backup had, so the backup is gone.
  expect(localStorage.getItem('chatealm_chat_state_v2')).toBeNull();
  const read=vi.spyOn(Storage.prototype,'getItem');
  await loadChatStateFromDb();
  expect(saved).toHaveLength(1);
  expect(read.mock.calls.map(([key])=>key)).not.toContain('chatealm_chat_state_v2');
 });
 it('keeps the backup when a backfill write fails',async()=>{
  localStorage.setItem('chatealm_db_migrated','1');
  const backup=JSON.stringify({chats:[{id:'a',messages:[{id:'m1',content:'hi',agentSteps:[{id:'s1'}]}]}]});
  localStorage.setItem('chatealm_chat_state_v2',backup);
  vi.spyOn(console,'error').mockImplementation(()=>{});
  (window as any).electronAPI={invoke:vi.fn(async(channel:string)=>{
   if(channel==='chat_db_load_all')return [{id:'a',messages:[{id:'m1',content:'hi',agentSteps:[]}]}];
   if(channel==='chat_db_load_folders')return [];
   if(channel==='chat_db_save_session')throw new Error('disk full');
  })};
  await loadChatStateFromDb();
  expect(localStorage.getItem('chatealm_chat_state_v2')).toBe(backup);
  expect(localStorage.getItem('chatealm_db_backfilled')).toBeNull();
 });
});
