<svelte:options runes={true} />
<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ArrowDown, ArrowUp, Folder, FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from '$lib/icons';
  import { appStore } from '$lib/stores/app.svelte';
  import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
  import { copy } from '$lib/copy';
  import { Button, IconButton, Menu, MenuItem } from '$lib/components/ui';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';
  import type { ChatFolder, ChatSession, CodeProject } from '$lib/types/chat';
  import { codeStore } from './code.svelte';
  import { sidebarOrganization as organization, itemKey, type SidebarItem } from './sidebar-organization.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  let { project, sessions, missing = false, onsplit, statusFor }: {
    project: CodeProject; sessions: ChatSession[]; missing?: boolean;
    onsplit: (chatId: string, edge: 'right' | 'bottom') => void;
    statusFor: (chatId: string) => 'running' | 'approval' | null;
  } = $props();
  const folders = $derived(organization.folders(project.id));
  const rootKey = $derived(`root:${project.id}`);
  const entries = $derived(organization.list(rootKey, [
    ...folders.map(folder => ({ id: folder.id, folder, chat: null as ChatSession | null })),
    ...sessions.filter(chat => !folders.some(folder => folder.id === chat.folderId)).map(chat => ({ id: chat.id, folder: null as ChatFolder | null, chat }))
  ]));
  let newName = $state('');
  let editing = $state('');
  let rename = $state('');
  let input = $state<HTMLInputElement>();
  const chatGroup = (folderId: string | null) => folderId ? `chats:${folderId}` : rootKey;
  const children = (folderId: string) => organization.list(chatGroup(folderId), sessions.filter(chat => chat.folderId === folderId));
  const folderItem = (folder: ChatFolder): SidebarItem => ({kind:'folder',id:folder.id,projectId:project.id});
  const chatItem = (chat: ChatSession): SidebarItem => ({kind:'chat',id:chat.id,projectId:project.id});
  const idsIn = (chat: ChatSession) => chat.folderId && folders.some(folder => folder.id === chat.folderId) ? children(chat.folderId).map(item=>item.id) : entries.map(item=>item.id);
  function focusNewFolder(node: HTMLInputElement) { node.focus(); }
  async function create() {
    try { await organization.createFolder(project.id,newName); newName=''; organization.creatingIn=null; } catch(error) { toastStore.error(String(error)); }
  }
  async function edit(folder: ChatFolder) { editing=folder.id;rename=folder.name;await tick();input?.focus();input?.select(); }
  async function commit(folder: ChatFolder) {
    if(editing!==folder.id)return; const value=rename;editing='';
    try { await organization.renameFolder(folder,value); } catch(error) { toastStore.error(String(error)); }
  }
  function drop(event: DragEvent, target: SidebarItem, folderId: string | null = null) {
    if (!organization.over(event,target)) return;
    const source=organization.dragging!;
    if (source.kind==='folder') organization.reorder(rootKey,entries.map(item=>item.id),source.id,target.id);
    else if(source.kind==='chat') {
      const chat=appStore.chats.find(item=>item.id===source.id);
      if(chat && organization.moveChat(chat,target.kind==='folder'?target.id:folderId)) {
        const group=chatGroup(chat.folderId), ids=chat.folderId?children(chat.folderId).map(item=>item.id):entries.map(item=>item.id);
        organization.reorder(group,ids,chat.id,target.kind==='chat'?target.id:null);
      }
    }
    organization.end();
  }
</script>

{#snippet conversation(chat: ChatSession)}
  {@const status=statusFor(chat.id)}
  <SessionRow {chat} active={appStore.currentChatId===chat.id} open={!!workspaceLayout.paneForChat(chat.id)}
    onselect={()=>codeStore.openConversation(chat.id)} onsplit={(edge)=>onsplit(chat.id,edge)} {status}
    statusLabel={status==='approval'?$t('code.awaitingApproval'):$t('code.running')} menuLabel={$t('code.conversationOptions')}
    ondragstart={(event)=>organization.start(event,chatItem(chat))} ondragend={()=>organization.end()}
    ondragover={(event)=>organization.over(event,chatItem(chat))} ondrop={(event)=>drop(event,chatItem(chat),chat.folderId)}
    dropActive={organization.hover===itemKey(chatItem(chat))}
  >
    {#snippet extraActions()}
      <MenuItem icon={ArrowUp} label={$t('sidebarOrganize.moveUp')} onselect={()=>organization.move(chatGroup(chat.folderId),idsIn(chat),chat.id,-1)} />
      <MenuItem icon={ArrowDown} label={$t('sidebarOrganize.moveDown')} onselect={()=>organization.move(chatGroup(chat.folderId),idsIn(chat),chat.id,1)} />
      {#if chat.folderId}<MenuItem icon={Folder} label={$t('sidebarOrganize.ungroup')} onselect={()=>organization.moveChat(chat,null)} />{/if}
      {#each folders.filter(folder=>folder.id!==chat.folderId) as folder(folder.id)}
        <MenuItem icon={Folder} label={$t('sidebarOrganize.moveTo',{values:{name:folder.name}})} onselect={()=>organization.moveChat(chat,folder.id)} />
      {/each}
    {/snippet}
  </SessionRow>
{/snippet}

{#if organization.creatingIn===project.id}
  <form class="folder-form" onsubmit={(event)=>{event.preventDefault();void create();}}>
    <UiInput action={focusNewFolder} class={uiClass("chat-rename-input", "ui-local-01f39bb9")} bind:value={newName} maxlength={80} aria-label={$t('sidebarOrganize.folderName')} placeholder={$t('sidebarOrganize.folderName')} onkeydown={(event)=>{if(event.key==='Escape')organization.creatingIn=null;}} />
    <Button size="xs" type="submit" disabled={!newName.trim()}>{$t('sidebarOrganize.create')}</Button>
  </form>
{/if}
{#each entries as entry(entry.id)}
  {#if entry.folder}
    {@const folder=entry.folder}
    {@const expanded=organization.expanded[folder.id]!==false}
    {@const chats=children(folder.id)}
    <div class="conversation-folder" data-conversation-folder={folder.id}>
      <div class="sidebar-row group" class:is-drop-target={organization.hover===itemKey(folderItem(folder))} role="button" tabindex="0" aria-expanded={expanded}
        draggable={editing!==folder.id} ondragstart={(event)=>organization.start(event,folderItem(folder))} ondragend={()=>organization.end()}
        ondragover={(event)=>organization.over(event,folderItem(folder))} ondrop={(event)=>drop(event,folderItem(folder))}
        onclick={()=>{if(editing!==folder.id)organization.expanded[folder.id]=!expanded;}}
        onkeydown={(event)=>{if(editing===folder.id)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();organization.expanded[folder.id]=!expanded;}else if(event.key==='F2'){event.preventDefault();void edit(folder);}}}
      >
        {#if expanded}<FolderOpen class="sidebar-row-icon" />{:else}<Folder class="sidebar-row-icon" />{/if}
        {#if editing===folder.id}
          <UiInput bind:ref={input} bind:value={rename} class={uiClass("chat-rename-input sidebar-row-label", "ui-local-01f39bb9")} aria-label={$t('sidebarOrganize.folderName')} onclick={(event)=>event.stopPropagation()} onkeydown={(event)=>{event.stopPropagation();if(event.key==='Enter')void commit(folder);if(event.key==='Escape')editing='';}} onblur={()=>void commit(folder)} />
        {:else}<span class="sidebar-row-label">{folder.name}</span><span class="folder-count">{chats.length}</span>{/if}
        <Menu placement="bottom-end" label={$t('sidebarOrganize.folderOptions')}>
          {#snippet trigger(props)}<IconButton {...props} class="sidebar-row-action" label={$t('sidebarOrganize.folderOptions')}><MoreHorizontal /></IconButton>{/snippet}
          <MenuItem icon={Pencil} label={copy.actions.rename} onselect={()=>void edit(folder)} />
          <MenuItem icon={ArrowUp} label={$t('sidebarOrganize.moveUp')} onselect={()=>organization.move(rootKey,entries.map(item=>item.id),folder.id,-1)} />
          <MenuItem icon={ArrowDown} label={$t('sidebarOrganize.moveDown')} onselect={()=>organization.move(rootKey,entries.map(item=>item.id),folder.id,1)} />
          <MenuItem icon={Trash2} label={$t('sidebarOrganize.removeFolder')} onselect={()=>void organization.removeFolder(folder).catch(error=>toastStore.error(String(error)))} />
        </Menu>
      </div>
      {#if expanded}<div class="folder-children">{#each chats as chat(chat.id)}{@render conversation(chat)}{:else}<p class="folder-empty">{$t('sidebarOrganize.dropHere')}</p>{/each}</div>{/if}
    </div>
  {:else if entry.chat}{@render conversation(entry.chat)}{/if}
{/each}
{#if !missing}
  <UiListRow  type="button" class={uiClass("sidebar-row is-muted", "ui-local-01f39bb9")} onclick={()=>codeStore.newConversation(project)}><Plus class="sidebar-row-icon" /><span class="sidebar-row-label">{$t('code.newConversation')}</span></UiListRow>
{/if}

<style>
  .folder-form { display:flex;gap:0.375rem;align-items:center;padding:0.375rem; } .folder-form :global(input.ui-local-01f39bb9) { min-width:0;flex:1; }
  .folder-count { font-size:var(--text-xs);color:var(--muted-foreground);font-variant-numeric:tabular-nums; }
  .folder-children { margin-left:0.875rem;padding-left:0.25rem;border-left:1px solid var(--border-subtle); }
  .folder-empty { padding:0.5rem;font-size:var(--text-xs);color:var(--muted-foreground); }
</style>
