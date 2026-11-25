<svelte:options runes={true} />

<!--
  Which project folder the conversation works in, on the composer's bar —
  beside the mode and the model, the other things you set before you send.

  Until the first message it is a menu: every project you added (the one in
  effect checked, its path dim on the right), then "Add project…", which opens
  the Add project dialog and points the conversation at what it adds. Once the
  conversation has started, the engine session lives in that folder, so the
  chip stays as a plain label and its tooltip says why.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Button } from '$lib/components/ui';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { ChevronDown, Folder, FolderOpen, FolderPlus } from '$lib/icons';
  import type { ChatSession } from '$lib/types/chat';
  import { cn as uiClass } from '$lib/utils/cn';
  import { codeStore } from './code.svelte';

  let { chat }: { chat: ChatSession } = $props();

  let open = $state(false);
  const project = $derived(codeStore.projectById(chat.projectId ?? null));
  const changeable = $derived(codeStore.canChangeProject(chat));
  const label = $derived(project?.rootName ?? $t('code.projectPicker.none'));

  async function addAndUse() {
    const added = await codeStore.addProject();
    if (added) codeStore.setConversationProject(chat.id, added.id);
  }
</script>

{#if changeable}
  <Menu bind:open placement="top-start" minWidth="16rem" label={$t('code.projectPicker.label')} class="project-menu">
    {#snippet trigger(props)}
      <Button variant="plain"
        type="button"
        class={uiClass('project-trigger composer-selector flex h-6 items-center gap-1 px-2 transition', { 'is-open': open })}
        aria-label={`${$t('code.projectPicker.label')}: ${label}`}
        title={project?.rootPath}
        {...props}
      >
        <FolderOpen class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
        <span class="trigger-label truncate">{label}</span>
        <ChevronDown class={`h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${open ? ' rotate-180' : ''}`} />
      </Button>
    {/snippet}
    {#each codeStore.projects as item (item.id)}
      <MenuItem class="project-option" icon={Folder} active={item.id === project?.id} title={item.rootPath} onselect={() => codeStore.setConversationProject(chat.id, item.id)}>
        <span class="project-name">{item.rootName}</span>
        <!-- rtl so a long path loses its start, not its folder; bdi keeps the slashes in place. -->
        <span class="project-path"><bdi>{item.rootPath}</bdi></span>
      </MenuItem>
    {/each}
    <div class="ui-menu-separator" role="separator"></div>
    <MenuItem icon={FolderPlus} label={$t('code.projectPicker.add')} onselect={() => void addAndUse()} />
  </Menu>
{:else if project}
  <Tooltip label={$t('code.projectPicker.fixed', { values: { path: project.rootPath } })} position="top">
    <span class="project-fixed">
      <FolderOpen class="h-3 w-3 shrink-0" />
      <span class="truncate">{project.rootName}</span>
    </span>
  </Tooltip>
{/if}

<style>
  :global(.project-trigger) { min-width: 0; max-width: 11rem; }
  :global(.project-trigger:focus-visible) { outline: 2px solid var(--brand-accent); outline-offset: 2px; }
  :global(.project-menu) { width: 22rem; max-width: calc(100vw - 1.5rem); }
  :global(.project-menu .project-option) { padding: 0.3125rem 0.625rem; }
  :global(.project-menu .project-option.is-active) { background: var(--float-row-selected); }
  :global(.project-menu .ui-menu-check) { color: var(--brand-accent-strong); }
  /* Name hard left, path hard right and dim: the name is what you scan for. */
  .project-name { flex-shrink: 0; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project-path { min-width: 0; margin-left: auto; padding-left: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: right; color: var(--muted-foreground); font-family: var(--font-mono); font-size: var(--text-xs); }
  .project-fixed { display: inline-flex; min-width: 0; max-width: 11rem; height: 1.5rem; align-items: center; gap: 0.25rem; padding: 0 0.5rem; color: var(--muted-foreground); font-size: var(--text-xs); }
</style>
