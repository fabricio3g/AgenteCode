<svelte:options runes={true} />
<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Code, FolderOpen, PanelsTopLeft, Play, Plus, Upload, X } from 'lucide-svelte';
  import { Button, IconButton, Menu, MenuItem } from '$lib/components/ui';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { copy } from '$lib/copy';
  import { codeWorkspace } from '../workspace.svelte';
  import { openFileInEditor } from './editor-actions';
  import { codeStore } from '../code.svelte';
  import BranchMenu from './BranchMenu.svelte';
  import type { ChatSession, CodeProject } from '$lib/types/chat';
  import type { WorkspaceLayoutStore } from '$lib/stores/workspace-layout.svelte';
  import type { Snippet } from 'svelte';

  type Script = { name:string; command:string };
  const KEY = 'agente.projectScripts';
  function read(): Record<string, Script[]> {
    try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
  }
  let { chat, project, layout, children }: {chat:ChatSession;project:CodeProject;layout:WorkspaceLayoutStore;children:Snippet}=$props();
  let scripts=$state(read());
  let adding=$state(false),name=$state(''),command=$state(''),busy=$state(false);
  const branch=$derived(codeWorkspace.branchFor(project.rootPath));
  const changes=$derived(codeWorkspace.changesFor(chat.id));
  const totals=$derived((changes?.files??[]).reduce((sum,file)=>({add:sum.add+file.additions,del:sum.del+file.deletions}),{add:0,del:0}));
  function save() { try { localStorage.setItem(KEY,JSON.stringify(scripts)); }catch{ /* Session-only. */ } }
  function add() { if(!name.trim()||!command.trim())return;scripts[project.id]=[...(scripts[project.id]??[]),{name:name.trim(),command:command.trim()}];save();name=command='';adding=false; }
  async function run(value:string) {
    if(busy)return;busy=true;
    try { await codeWorkspace.startProcess(chat.id,value,project.rootPath);layout.show('processes','bottom'); } catch(error) {toastStore.error(String(error));} finally {busy=false;}
  }
</script>
<Menu placement="bottom-end" minWidth="16rem" label={$t('projectControls.title')}>
  {#snippet trigger(props)}<IconButton {...props} label={$t('projectControls.title')} size="sm"><PanelsTopLeft /></IconButton>{/snippet}
  <div class="project-controls" data-project-controls={chat.id}>
    <p class="project-name"><FolderOpen class="size-3.5" /><span>{project.rootName}</span></p>
    <p class="project-path" title={project.rootPath}>{project.rootPath}</p>
    <MenuItem icon={Code} label={$t('projectControls.openEditor')} onselect={()=>void openFileInEditor(project.rootPath,'.',undefined,layout.scope)} />
    <MenuItem icon={FolderOpen} label={copy.actions.reveal} onselect={()=>void codeStore.revealProject(project.id).catch(error=>toastStore.error(String(error)))} />
    <div class="project-divider"></div>
    <BranchMenu projectRoot={project.rootPath} />
    {#if branch?.source==='git'}<MenuItem icon={Upload} label={$t('projectControls.push')} disabled={busy} onselect={()=>void run('git push')} />{/if}
    <div class="project-changes"><span>{$t('codeWs.changes')}</span><span class="text-success">+{totals.add}</span><span class="text-error">−{totals.del}</span></div>
    <div class="project-divider"></div>
    <div class="project-tools">{@render children()}</div>
    <div class="project-divider"></div>
    {#each scripts[project.id]??[] as script,index(index)}
      <div class="script-row"><button type="button" disabled={busy} title={script.command} onclick={()=>void run(script.command)}><Play class="size-3" /><span>{script.name}</span></button><IconButton quiet size="xs" label={copy.actions.remove} onclick={()=>{scripts[project.id]=scripts[project.id].filter((_,i)=>i!==index);save();}}><X /></IconButton></div>
    {/each}
    {#if adding}
      <form class="script-form" onsubmit={(event)=>{event.preventDefault();add();}}>
        <input class="ui-legacy-field" bind:value={name} placeholder={$t('projectControls.scriptName')} aria-label={$t('projectControls.scriptName')} />
        <input class="ui-legacy-field" bind:value={command} placeholder="npm run dev" aria-label={$t('projectControls.command')} />
        <div><Button size="xs" variant="ghost" onclick={()=>adding=false}>{copy.actions.cancel}</Button><Button size="xs" type="submit" disabled={!name.trim()||!command.trim()}>{copy.actions.save}</Button></div>
      </form>
    {:else}<button type="button" role="menuitem" data-keep-open class="ui-menu-item" onclick={()=>adding=true}><Plus class="size-4" /><span>{$t('projectControls.addScript')}</span></button>{/if}
  </div>
</Menu>
<style>
  .project-controls { padding:0.25rem; } .project-name { display:flex;align-items:center;gap:0.5rem;color:var(--foreground);font-weight:550;padding:0.375rem 0.625rem; }
  .project-path { padding:0 0.625rem 0.5rem;font-size:var(--text-xs);color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:20rem; }
  .project-divider { height:1px;background:var(--border-subtle);margin:0.375rem 0; }
  .project-tools { display:flex;flex-wrap:wrap;gap:0.25rem;padding:0.375rem; }
  .project-changes { display:flex;gap:0.375rem;padding:0.375rem 0.625rem;font-size:var(--text-xs); } .project-changes span:first-child { margin-right:auto; }
  .script-row { display:flex;align-items:center;gap:0.375rem; } .script-row>button { display:flex;align-items:center;gap:0.5rem;padding:0.5rem;min-width:0;flex:1;border-radius:var(--radius-md);font-size:var(--text-sm); } .script-row>button:hover { background:var(--companion-soft); }
  .script-form { display:grid;gap:0.375rem;padding:0.5rem; } .script-form input { width:100%;min-width:0;padding:0.375rem 0.5rem;font-size:var(--text-sm); } .script-form>div { display:flex;justify-content:flex-end;gap:0.375rem; }
</style>
