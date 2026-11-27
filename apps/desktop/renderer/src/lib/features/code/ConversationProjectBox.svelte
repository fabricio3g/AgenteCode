<svelte:options runes={true} />

<!--
  Where a new conversation will work and with which agent, asked in the middle
  of the empty page. Two short columns in one card — project | agent — split by
  a hairline, stacked when narrow. Projects: 
  the ones you used last (newest
  first, three of them; the path is the tooltip), the one in effect checked;
  "View all" in the title line opens the rest in place, and the last row adds
  a project and points the conversation at it. It only shows while
  the folder can still change (no message, no engine session) — afterwards the
  top bar's chip names both. A folder that went missing is left out: it cannot
  host a turn. Agents: Agente Core and the CLIs that are installed, each with
  its mark; the one in effect checked.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
  import { Check, Folder, FolderPlus } from '$lib/icons';
  import { Button } from '$lib/components/ui';
  import type { ChatSession } from '$lib/types/chat';
  import { codeStore } from './code.svelte';
  import { driversStore, isExternalDriverId } from './drivers.svelte';
  import DriverIcon from './DriverIcon.svelte';

  let { chat }: { chat: ChatSession } = $props();

  const RECENT = 3;
  let showAll = $state(false);

  const usable = $derived(
    [...codeStore.projects]
      .filter((project) => !codeStore.missingProjects[project.id])
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
  );
  /** The one in effect always shows, even when it is not among the newest. */
  const shown = $derived.by(() => {
    if (showAll) return usable;
    const recent = usable.slice(0, RECENT);
    const current = usable.find((project) => project.id === chat.projectId);
    return current && !recent.includes(current) ? [...recent.slice(0, RECENT - 1), current] : recent;
  });
  const more = $derived(usable.length - RECENT);

  // ── Agent ──────────────────────────────────────────────────────────────
  const instanceId = $derived(chat.codeAgent?.instanceId || 'agente');
  /** Installed engines only (a missing CLI is Settings' business), built-in first. */
  const agents = $derived(
    driversStore.drivers
      .filter((d) => d.instance_id === 'agente' || d.instance_id === instanceId || (d.status !== 'missing' && d.status !== 'disabled'))
      .sort((a, b) => Number(b.instance_id === 'agente') - Number(a.instance_id === 'agente'))
  );

  function useAgent(id: string) {
    codeStore.setConversationDriver(chat.id, id);
    if (isExternalDriverId(id)) void driversStore.ensureProbed(id);
  }

  async function addAndUse() {
    const added = await codeStore.addProject();
    if (added) codeStore.setConversationProject(chat.id, added.id);
  }
</script>

<div class="start-wrap">
<section class="start-box">
<div class="box-col">
  <div class="box-head">
    <span class="box-title">{$t('code.projectBox.title')}</span>
    {#if more > 0}
      <Button variant="plain" type="button" class="head-link" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
        {showAll ? $t('code.projectBox.fewer') : $t('code.projectBox.all', { values: { n: usable.length } })}
      </Button>
    {/if}
  </div>
  <div class="box-rows" role="radiogroup" aria-label={$t('code.projectBox.title')}>
    {#each shown as project (project.id)}
      {@const selected = project.id === chat.projectId}
      <div class="box-row-slide" transition:slide={{ duration: 140 }}>
        <Button
          variant="plain"
          type="button"
          role="radio"
          aria-checked={selected}
          class="box-row {selected ? 'is-selected' : ''}"
          title={project.rootPath}
          onclick={() => codeStore.setConversationProject(chat.id, project.id)}
        >
          <Folder class="row-icon" aria-hidden="true" />
          <span class="row-name">{project.rootName}</span>
          {#if selected}<Check class="row-check" aria-hidden="true" />{/if}
        </Button>
      </div>
    {/each}
    <Button variant="plain" type="button" class="box-row is-add" onclick={() => void addAndUse()}>
      <FolderPlus class="row-icon" aria-hidden="true" />
      <span class="row-name">{$t('code.projectPicker.add')}</span>
    </Button>
  </div>
</div>
<div class="box-col">
  <div class="box-head"><span class="box-title">{$t('code.projectBox.agent')}</span></div>
  <div class="box-rows" role="radiogroup" aria-label={$t('code.projectBox.agent')}>
    {#each agents as agent (agent.instance_id)}
      {@const selected = agent.instance_id === instanceId}
      <Button
        variant="plain"
        type="button"
        role="radio"
        aria-checked={selected}
        class="box-row {selected ? 'is-selected' : ''}"
        title={agent.use_for || agent.label}
        onclick={() => useAgent(agent.instance_id)}
      >
        <DriverIcon instanceId={agent.instance_id} driverKind={agent.driver_kind} name={agent.label} size={14} class="row-icon" />
        <span class="row-name">{agent.label}</span>
        {#if selected}<Check class="row-check" aria-hidden="true" />{/if}
      </Button>
    {/each}
  </div>
</div>
</section>
</div>

<style>
  /* A small card centred over the composer: a title line with "View all" hard
     right, the projects as compact rows (the path is the tooltip), and Add
     project as the last row. A fill a step off the page and a hairline ring. */
  /* The card measures its column, not the window: a pane beside it narrows it. */
  .start-wrap { container-type: inline-size; }
  .start-box {
    display: grid;
    width: min(32rem, 100%);
    grid-template-columns: 1fr 1fr;
    margin: 0 auto 1rem;
    padding: 0.25rem;
    border-radius: calc(var(--float-row-radius) + 0.25rem);
    background: color-mix(in srgb, var(--foreground) 2.5%, transparent);
    box-shadow: 0 0 0 1px var(--border-subtle);
  }
  .box-col {
    display: flex;
    min-width: 0;
    flex-direction: column;
    padding: 0 0.125rem;
  }
  /* The hairline between the two questions. */
  .box-col + .box-col {
    padding-left: 0.375rem;
    border-left: 1px solid var(--border-subtle);
  }
  @container (max-width: 34rem) {
    .start-box { grid-template-columns: 1fr; width: min(17rem, 100%); }
    .box-col + .box-col { margin-top: 0.25rem; padding: 0.25rem 0.125rem 0; border-left: 0; border-top: 1px solid var(--border-subtle); }
  }
  .box-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem 0.25rem;
  }
  .box-title {
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .box-head :global(.head-link) {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .box-head :global(.head-link:hover) { color: var(--foreground); }
  .box-head :global(.head-link:focus-visible) { outline: 2px solid var(--brand-accent); outline-offset: 2px; border-radius: 2px; }
  .box-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .box-row-slide {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }
  .box-rows :global(.box-row) {
    display: flex;
    width: 100%;
    min-width: 0;
    height: 1.875rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.5rem;
    border: 0;
    border-radius: var(--float-row-radius);
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  .box-rows :global(.box-row:hover) { background: var(--float-row-hover); color: var(--foreground); }
  .box-rows :global(.box-row.is-selected) { background: var(--float-row-selected); color: var(--foreground); }
  .box-rows :global(.box-row.is-add) { color: var(--muted-foreground); }
  .box-rows :global(.box-row.is-add:hover) { color: var(--foreground); }
  .box-rows :global(.box-row:focus-visible) { outline: 2px solid var(--brand-accent); outline-offset: -2px; }
  .box-rows :global(.box-row .row-icon) { width: 0.875rem; height: 0.875rem; flex: none; color: var(--muted-foreground); }
  .row-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .box-rows :global(.box-row .row-check) { width: 0.875rem; height: 0.875rem; flex: none; color: var(--brand-accent-strong); }
</style>
