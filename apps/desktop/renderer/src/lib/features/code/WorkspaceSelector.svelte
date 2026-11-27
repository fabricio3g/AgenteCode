<svelte:options runes={true} />

<!--
  Where and with what the conversation works, as one chip in the top bar,
  beside the conversation's pane tools (Changes, Files, Browser…):
  the engine's mark (its own logo, or the app's for Agente Core), then the
  project folder's name — so which agent is working is always on screen.

  One menu holds both choices. Before the first message: the projects (the one
  in effect checked, its path dim on the right) and "Add project…". The folder
  is fixed once the conversation starts; the engine is not: picking another
  keeps the conversation, and its next turn hands the new agent the history.
  While a turn runs the engines wait, greyed.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button } from '$lib/components/ui';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { ChevronDown, Folder, FolderPlus, Settings2 } from '$lib/icons';
  import DriverIcon from './DriverIcon.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ChatSession } from '$lib/types/chat';
  import type { DriverStatus } from '$shared/agente-protocol';
  import { cn as uiClass } from '$lib/utils/cn';
  import { codeStore } from './code.svelte';
  import { driversStore, isExternalDriverId } from './drivers.svelte';

  let { chat, placement = 'bottom-start' }: { chat: ChatSession; placement?: 'bottom-start' | 'bottom-end' | 'top-start' } = $props();

  let open = $state(false);

  // ── Project ───────────────────────────────────────────────────────────
  const project = $derived(codeStore.projectById(chat.projectId ?? null));
  const projectChangeable = $derived(codeStore.canChangeProject(chat));
  const projectLabel = $derived(project?.rootName ?? $t('code.projectPicker.none'));

  async function addAndUse() {
    open = false;
    const added = await codeStore.addProject();
    if (added) codeStore.setConversationProject(chat.id, added.id);
  }

  // ── Engine ────────────────────────────────────────────────────────────
  const instanceId = $derived(chat.codeAgent?.instanceId || 'agente');
  const driver = $derived(driversStore.byId(instanceId));
  const external = $derived(isExternalDriverId(instanceId));
  const driverChangeable = $derived(codeStore.canChangeDriver(chat));
  const driverLabel = $derived(driver?.label || (instanceId === 'agente' ? $t('code.driverPicker.builtin') : instanceId));
  const builtinDrivers = $derived(driversStore.drivers.filter((d) => d.instance_id === 'agente'));
  const externalDrivers = $derived(
    driversStore.drivers.filter((d) => d.instance_id !== 'agente' && (d.status !== 'missing' || !d.builtin || d.instance_id === instanceId))
  );
  const started = $derived(chat.messages.length > 0 || !!chat.codeAgent?.sessionId);

  onMount(() => {
    void driversStore.load(false);
  });

  function statusText(id: string, status: DriverStatus): string {
    if (id === 'agente') return $t('code.driverPicker.builtinTag');
    return $t(`code.driverPicker.status.${status}`);
  }

  function statusTone(status: DriverStatus): string {
    if (status === 'error') return 'is-error';
    if (status === 'needs_auth') return 'is-warn';
    if (status === 'ready') return 'is-ready';
    return '';
  }

  function hintFor(item?: typeof driver): string {
    if (!item) return driverLabel;
    if (item.status === 'error' || item.status === 'needs_auth') return item.error || item.auth_hint || item.use_for || item.label;
    return item.use_for || item.label;
  }

  function selectDriver(id: string) {
    open = false;
    codeStore.setConversationDriver(chat.id, id);
    if (isExternalDriverId(id)) void driversStore.ensureProbed(id);
  }

  function openSettings() {
    open = false;
    appStore.openSettings('external-clis');
  }

  const title = $derived([project?.rootPath ?? projectLabel, driverLabel].join(' · '));
</script>

<Menu bind:open {placement} minWidth="18rem" label={$t('code.projectPicker.label')} class="workspace-menu">
  {#snippet trigger(props)}
    <Button
      variant="plain"
      type="button"
      class={uiClass('workspace-trigger has-label titlebar-no-drag flex items-center gap-1.5 transition', { 'is-open': open })}
      aria-label={`${$t('code.projectPicker.label')}: ${projectLabel} · ${$t('code.driverPicker.label')}: ${driverLabel}`}
      {title}
      {...props}
    >
      <DriverIcon {instanceId} driverKind={driver?.driver_kind} name={driverLabel} size={15} class={uiClass('workspace-engine', { 'is-external': external })} />
      <span class="trigger-label truncate">{projectLabel}</span>
      <ChevronDown class={`workspace-chevron h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${open ? ' rotate-180' : ''}`} />
    </Button>
  {/snippet}

  <p class="workspace-group">{$t('code.projectPicker.label')}</p>
  {#if projectChangeable}
    {#each codeStore.projects as item (item.id)}
      <MenuItem class="workspace-option" icon={Folder} active={item.id === project?.id} title={item.rootPath} onselect={() => { open = false; codeStore.setConversationProject(chat.id, item.id); }}>
        <span class="option-name">{item.rootName}</span>
        <!-- rtl so a long path loses its start, not its folder; bdi keeps the slashes in place. -->
        <span class="option-path"><bdi>{item.rootPath}</bdi></span>
      </MenuItem>
    {/each}
    <MenuItem icon={FolderPlus} label={$t('code.projectPicker.add')} onselect={() => void addAndUse()} />
  {:else if project}
    <p class="workspace-fixed">{$t('code.projectPicker.fixed', { values: { path: project.rootPath } })}</p>
  {/if}

  <div class="ui-menu-separator" role="separator"></div>
  <p class="workspace-group">{$t('code.driverPicker.label')}</p>
  {#each [...builtinDrivers, ...externalDrivers] as item (item.instance_id)}
    <MenuItem
      class="workspace-option"
      active={item.instance_id === instanceId}
      disabled={item.status === 'disabled' || (!driverChangeable && item.instance_id !== instanceId)}
      title={hintFor(item)}
      onselect={() => selectDriver(item.instance_id)}
    >
      <DriverIcon instanceId={item.instance_id} driverKind={item.driver_kind} name={item.label} size={15} class="option-icon" />
      <span class="option-name">{item.label}</span>
      <span class={uiClass('option-status', statusTone(item.status))}>{statusText(item.instance_id, item.status)}</span>
    </MenuItem>
  {/each}
  {#if started}
    <p class="workspace-fixed">{driverChangeable ? $t('code.driverPicker.switchHint') : $t('code.driverPicker.busyHint')}</p>
  {/if}
  <MenuItem icon={Settings2} label={$t('code.driverPicker.manage')} onselect={openSettings} />
</Menu>

<style>
  :global(.workspace-trigger) { min-width: 0; max-width: 16rem; color: var(--text-secondary); font-size: var(--text-sm); }
  :global(.workspace-trigger:hover), :global(.workspace-trigger.is-open) { color: var(--foreground); }
  /* The top bar sizes its icon buttons' glyphs at 1rem; a breadcrumb's are text-sized. */
  :global(.titlebar-row .ui-button.workspace-trigger svg) { inline-size: 0.875rem; block-size: 0.875rem; }
  :global(.workspace-trigger:focus-visible) { outline: 2px solid var(--brand-accent); outline-offset: 2px; }
  :global(.workspace-trigger .workspace-engine) { flex-shrink: 0; color: var(--foreground); }
  :global(.workspace-menu) { width: 22rem; max-width: calc(100vw - 1.5rem); }
  :global(.workspace-menu .workspace-option) { padding: 0.3125rem 0.625rem; }
  :global(.workspace-menu .workspace-option.is-active) { background: var(--float-row-selected); }
  :global(.workspace-menu .option-icon) { color: var(--text-secondary); }
  :global(.workspace-menu .workspace-option:hover .option-icon),
  :global(.workspace-menu .workspace-option.is-active .option-icon) { color: var(--foreground); }
  :global(.workspace-menu .ui-menu-check) { color: var(--brand-accent-strong); }
  .workspace-group { margin: 0; padding: 0.375rem 0.625rem 0.125rem; color: var(--muted-foreground); font-size: var(--text-xs); font-weight: 500; }
  .workspace-fixed { margin: 0; padding: 0.25rem 0.625rem 0.375rem; color: var(--muted-foreground); font-size: var(--text-xs); line-height: 1.45; }
  .fixed-name { color: var(--foreground); font-weight: 500; }
  .option-name { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .option-path { min-width: 0; margin-left: auto; padding-left: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: right; color: var(--muted-foreground); font-family: var(--font-mono); font-size: var(--text-xs); }
  .option-status { flex-shrink: 0; margin-left: auto; padding-left: 0.75rem; color: var(--muted-foreground); font-size: var(--text-xs); white-space: nowrap; }
  .option-status.is-ready { color: var(--success); }
  .option-status.is-warn { color: var(--warning); }
  .option-status.is-error { color: var(--error); }
</style>
