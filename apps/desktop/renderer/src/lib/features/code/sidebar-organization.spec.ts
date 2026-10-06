// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFolder, ChatSession } from '$lib/types/chat';
const state=vi.hoisted(()=>({chats:[] as ChatSession[],folders:[] as ChatFolder[],markChatDirty:vi.fn(),persist:vi.fn()}));
const bridge=vi.hoisted(()=>({invoke:vi.fn().mockResolvedValue({ok:true})}));
vi.mock('$lib/stores/app.svelte',()=>({appStore:state}));
vi.mock('$lib/services/bridge',()=>bridge);
import { SidebarOrganization } from './sidebar-organization.svelte';
beforeEach(()=>{localStorage.clear();state.chats=[];state.folders=[];vi.clearAllMocks();});
const chat=(id:string,projectId='p'):ChatSession=>({id,projectId,title:id,folderId:null,draft:'',messages:[],createdAt:1,updatedAt:1,contextMode:'code'});
describe('sidebar organization',()=>{
  it('keeps manually ordered projects stable when their activity changes',()=>{
    const store=new SidebarOrganization();store.reorder('projects',['a','b','c'],'c','a');
    expect(store.list('projects',[{id:'b'},{id:'c'},{id:'a'},{id:'new'}]).map(item=>item.id)).toEqual(['c','a','b','new']);
    expect(new SidebarOrganization().orders.projects).toEqual(['c','a','b']);
  });
  it('supports keyboard ordering in both directions and at the list ends',()=>{
    const store=new SidebarOrganization();store.move('root:p',['folder','a','b'],'b',-1);expect(store.orders['root:p']).toEqual(['folder','b','a']);
    store.move('root:p',['folder','b','a'],'folder',1);expect(store.orders['root:p']).toEqual(['b','folder','a']);
    store.move('root:p',['b','folder','a'],'a',1);expect(store.orders['root:p']).toEqual(['b','folder','a']);
  });
  it('creates and renames folders using the existing persisted folder schema',async()=>{
    const store=new SidebarOrganization();await store.createFolder('p','  Release  ');
    expect(state.folders[0]).toMatchObject({name:'Release',parentId:'p'});expect(bridge.invoke).toHaveBeenCalledWith('chat_db_save_folder',{folder:expect.objectContaining({name:'Release'})});
    await store.renameFolder(state.folders[0],'Sprint');expect(state.folders[0].name).toBe('Sprint');
  });
  it('groups a conversation without changing its project or engine session',()=>{
    const store=new SidebarOrganization();state.folders=[{id:'f',name:'Folder',parentId:'p',createdAt:1}];const a=chat('a');state.chats=[a];
    expect(store.moveChat(a,'f')).toBe(true);expect(a.folderId).toBe('f');expect(a.projectId).toBe('p');
    expect(store.moveChat(a,'other-project')).toBe(false);expect(a.folderId).toBe('f');
  });
  it('removes a folder while keeping every conversation',async()=>{
    const store=new SidebarOrganization();const folder={id:'f',name:'Folder',parentId:'p',createdAt:1};state.folders=[folder];const a=chat('a');a.folderId='f';state.chats=[a];
    await store.removeFolder(folder);expect(state.folders).toEqual([]);expect(state.chats).toHaveLength(1);expect(a.folderId).toBeNull();
  });
  it('rejects a drag across unrelated projects while accepting a same-project folder',()=>{
    const store=new SidebarOrganization();store.dragging={kind:'chat',id:'a',projectId:'p'};const event={preventDefault:vi.fn(),stopPropagation:vi.fn(),dataTransfer:{}} as unknown as DragEvent;
    expect(store.over(event,{kind:'folder',id:'f',projectId:'q'})).toBe(false);expect(store.over(event,{kind:'folder',id:'f',projectId:'p'})).toBe(true);
  });
});
