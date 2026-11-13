<svelte:options runes={true} />
<!--
  The project card: the project's folder, editor and reveal, its branch and
  push, the change tally, the less frequent panes and the project's scripts.
  It floats in the conversation's top-right corner and stays until hidden —
  the strip's button shows and hides it, the card's × hides it.
-->
<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { Code, FolderOpen, PanelsTopLeft, Play, Plus, Upload, X } from '$lib/icons';
  import Portal from '$lib/components/ui/Portal.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { motionFly } from '$lib/utils/transitions';
  import { projectControls } from './project-controls.svelte';
  import { Button, IconButton, MenuItem } from '$lib/components/ui';
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

  /**
   * The corner it floats in: the conversation's own top-right, so a split
   * keeps each card over its own pane. Measured, because the trigger sits in
   * the title bar while the conversation it belongs to sits below it.
   */
  let trigger=$state<HTMLElement|undefined>(undefined);
  let place=$state({top:0,right:0});
  function measure() {
    if(!trigger)return;
    const area=trigger.closest<HTMLElement>('[data-conversation-workspace]')??document.querySelector<HTMLElement>(`[data-conversation-workspace="${chat.id}"]`);
    const bar=trigger.getBoundingClientRect();
    const box=area?.getBoundingClientRect();
    place={top:Math.max(bar.bottom,box?.top??0)+8,right:Math.max(8,window.innerWidth-(box?.right??window.innerWidth)+12)};
  }
  $effect(()=>{
    if(!projectControls.open||!trigger)return;
    measure();
    const area=trigger.closest('[data-conversation-workspace]')??document.querySelector(`[data-conversation-workspace="${chat.id}"]`);
    const observer=new ResizeObserver(measure);
    if(area)observer.observe(area);
    window.addEventListener('resize',measure);
    return ()=>{observer.disconnect();window.removeEventListener('resize',measure);};
  });
  function onKeydown(event:KeyboardEvent) {
    if(event.key!=='Escape')return;
    event.stopPropagation();projectControls.set(false);trigger?.querySelector('button')?.focus();
  }
</script>
<span class="contents" bind:this={trigger}>
  <Tooltip label={$t('projectControls.title')} position="bottom">
    <IconButton label={$t('projectControls.title')} size="sm" class="titlebar-no-drag" aria-pressed={projectControls.open} aria-expanded={projectControls.open} onclick={()=>projectControls.toggle()}><PanelsTopLeft /></IconButton>
  </Tooltip>
</span>
{#if projectControls.open}
  <Portal>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <section class="ui-float project-controls" aria-label={$t('projectControls.title')} data-project-controls={chat.id} style:top="{place.top}px" style:right="{place.right}px" onkeydown={onKeydown} transition:motionFly={{ y: -4, duration: 150 }}>
      <header class="project-head">
        <p class="project-name"><FolderOpen class="size-3.5" /><span>{project.rootName}</span></p>
        <IconButton quiet size="xs" label={copy.actions.close} onclick={()=>projectControls.set(false)}><X /></IconButton>
      </header>
      <p class="project-path" title={project.rootPath}>{project.rootPath}</p>
      <MenuItem role="button" icon={Code} label={$t('projectControls.openEditor')} onselect={()=>void openFileInEditor(project.rootPath,'.',undefined,layout.scope)} />
      <MenuItem role="button" icon={FolderOpen} label={copy.actions.reveal} onselect={()=>void codeStore.revealProject(project.id).catch(error=>toastStore.error(String(error)))} />
      <div class="project-divider"></div>
      <BranchMenu projectRoot={project.rootPath} />
      {#if branch?.source==='git'}<MenuItem role="button" icon={Upload} label={$t('projectControls.push')} disabled={busy} onselect={()=>void run('git push')} />{/if}
      <div class="project-changes"><span>{$t('codeWs.changes')}</span><span class="text-success">+{totals.add}</span><span class="text-error">−{totals.del}</span></div>
      <div class="project-divider"></div>
      <div class="project-tools">{@render children()}</div>
      <div class="project-divider"></div>
      {#each scripts[project.id]??[] as script,index(index)}
        <div class="script-row"><Button variant="plain" class={uiClass('', "ui-local-7b76bc47")} type="button" disabled={busy} title={script.command} onclick={()=>void run(script.command)}><Play class="size-3" /><span>{script.name}</span></Button><IconButton quiet size="xs" label={copy.actions.remove} onclick={()=>{scripts[project.id]=scripts[project.id].filter((_,i)=>i!==index);save();}}><X /></IconButton></div>
      {/each}
      {#if adding}
        <form class="script-form" onsubmit={(event)=>{event.preventDefault();add();}}>
          <UiInput class={uiClass("ui-legacy-field", "ui-local-7b76bc47")} bind:value={name} placeholder={$t('projectControls.scriptName')} aria-label={$t('projectControls.scriptName')} />
          <UiInput class={uiClass("ui-legacy-field", "ui-local-7b76bc47")} bind:value={command} placeholder="npm run dev" aria-label={$t('projectControls.command')} />
          <div><Button size="xs" variant="ghost" onclick={()=>adding=false}>{copy.actions.cancel}</Button><Button size="xs" type="submit" disabled={!name.trim()||!command.trim()}>{copy.actions.save}</Button></div>
        </form>
      {:else}<UiListRow type="button" data-keep-open class={uiClass("ui-menu-item", "ui-local-7b76bc47")} onclick={()=>adding=true}><Plus class="size-4" /><span>{$t('projectControls.addScript')}</span></UiListRow>{/if}
    </section>
  </Portal>
{/if}
<style>
  /* The menu surface (`.ui-float`), pinned instead of dropped. */
  .project-controls { position:fixed;z-index:var(--z-float);width:17rem;max-height:calc(100vh - 6rem);overflow-y:auto;padding:var(--float-pad); }
  .project-head { display:flex;align-items:center;gap:0.25rem;padding-right:0.25rem; }
  .project-name { display:flex;flex:1;min-width:0;align-items:center;gap:0.5rem;color:var(--foreground);font-weight:550;padding:0.375rem 0.625rem; } .project-name span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
  .project-path { padding:0 0.625rem 0.5rem;font-size:var(--text-xs);color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:20rem; }
  .project-divider { height:1px;background:var(--border-subtle);margin:0.375rem 0; }
  .project-tools { display:flex;flex-wrap:wrap;gap:0.25rem;padding:0.375rem; }
  .project-changes { display:flex;gap:0.375rem;padding:0.375rem 0.625rem;font-size:var(--text-xs); } .project-changes span:first-child { margin-right:auto; }
  .script-row { display:flex;align-items:center;gap:0.375rem; } .script-row>:global(button.ui-local-7b76bc47) { display:flex;align-items:center;gap:0.5rem;padding:0.5rem;min-width:0;flex:1;border-radius:var(--radius-md);font-size:var(--text-sm); } .script-row>:global(button:hover.ui-local-7b76bc47) { background:var(--companion-soft); }
  .script-form { display:grid;gap:0.375rem;padding:0.5rem; } .script-form :global(input.ui-local-7b76bc47) { width:100%;min-width:0;padding:0.375rem 0.5rem;font-size:var(--text-sm); } .script-form>div { display:flex;justify-content:flex-end;gap:0.375rem; }
</style>
