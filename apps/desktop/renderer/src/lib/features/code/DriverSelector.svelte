<svelte:options runes={true} />

<!--
  Which coding engine (Agente Core or a configured external CLI) drives this
  conversation, beside the project chip on the composer bar.

  Before the conversation starts it lets you switch to any configured CLI; once
  the session has messages it stays fixed and offers "Continue in another
  agent", which starts a fresh conversation in the same project seeded with a
  concise handoff brief.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button } from '$lib/components/ui';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { ChevronDown, Settings2 } from '$lib/icons';
  import DriverIcon from './DriverIcon.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import type { ChatSession } from '$lib/types/chat';
  import type { DriverStatus } from '$shared/agente-protocol';
  import { cn as uiClass } from '$lib/utils/cn';
  import { codeStore } from './code.svelte';
  import { driversStore, isExternalDriverId } from './drivers.svelte';

  let { chat }: { chat: ChatSession } = $props();

  let open = $state(false);
  const instanceId = $derived(chat.codeAgent?.instanceId || 'agente');
  const driver = $derived(driversStore.byId(instanceId));
  const external = $derived(isExternalDriverId(instanceId));
  const changeable = $derived(codeStore.canChangeDriver(chat));
  const label = $derived(driver?.label || (instanceId === 'agente' ? $t('code.driverPicker.builtin') : instanceId));
  const builtinDrivers = $derived(driversStore.drivers.filter((d) => d.instance_id === 'agente'));
  const externalDrivers = $derived(
    driversStore.drivers.filter(
      (d) =>
        d.instance_id !== 'agente' &&
        (d.status !== 'missing' || !d.builtin || d.instance_id === instanceId)
    )
  );
  const handoffTargets = $derived(
    driversStore.drivers.filter(
      (d) =>
        d.instance_id !== instanceId &&
        d.status !== 'disabled' &&
        (d.status !== 'missing' || !d.builtin)
    )
  );

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
    if (!item) return label;
    if (item.status === 'error' || item.status === 'needs_auth') {
      return item.error || item.auth_hint || item.use_for || item.label;
    }
    return item.use_for || item.label;
  }

  function selectExternal(id: string) {
    open = false;
    codeStore.setConversationDriver(chat.id, id);
    void driversStore.ensureProbed(id);
  }

  function openSettings() {
    open = false;
    appStore.openSettings('external-clis');
  }

  async function handoff(targetId: string) {
    open = false;
    try {
      await codeStore.handoffToDriver(chat.id, targetId);
    } catch (error) {
      toastStore.error(error instanceof Error ? error.message : String(error));
    }
  }
</script>

<Menu bind:open placement="top-start" minWidth="16rem" label={$t('code.driverPicker.label')} class="driver-menu">
  {#snippet trigger(props)}
    <Button
      variant="plain"
      type="button"
      class={uiClass('driver-trigger composer-selector flex h-6 items-center gap-1 px-2 transition', {
        'is-open': open,
        'is-external': external
      })}
      aria-label={`${$t('code.driverPicker.label')}: ${label}`}
      title={hintFor(driver)}
      {...props}
    >
      <DriverIcon
        {instanceId}
        driverKind={driver?.driver_kind}
        size={13}
        class={uiClass('driver-icon', external ? 'is-accent' : 'text-[var(--text-muted)]')}
      />
      <span class="trigger-label truncate">{label}</span>
      <ChevronDown class={`driver-chevron h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${open ? ' rotate-180' : ''}`} />
    </Button>
  {/snippet}

  {#if changeable}
    {#each builtinDrivers as item (item.instance_id)}
      <MenuItem
        class="driver-option"
        active={item.instance_id === instanceId}
        onselect={() => { open = false; codeStore.setConversationDriver(chat.id, item.instance_id); }}
      >
        <DriverIcon instanceId={item.instance_id} driverKind={item.driver_kind} size={15} class="driver-row-icon" />
        <span class="driver-name">{item.label}</span>
        <span class="driver-status">{statusText(item.instance_id, item.status)}</span>
      </MenuItem>
    {/each}
    {#if externalDrivers.length}
      <div class="ui-menu-separator" role="separator"></div>
      {#each externalDrivers as item (item.instance_id)}
        <MenuItem
          class="driver-option"
          active={item.instance_id === instanceId}
          disabled={item.status === 'disabled'}
          title={hintFor(item)}
          onselect={() => selectExternal(item.instance_id)}
        >
          <DriverIcon instanceId={item.instance_id} driverKind={item.driver_kind} size={15} class="driver-row-icon" />
          <span class="driver-name">{item.label}</span>
          <span class={uiClass('driver-status', statusTone(item.status))}>{statusText(item.instance_id, item.status)}</span>
        </MenuItem>
      {/each}
    {/if}
  {:else}
    <p class="driver-fixed-note">
      <span class="driver-fixed-name">{label}</span>
      <span class="driver-fixed-hint">{$t('code.driverPicker.fixedHint')}</span>
    </p>
    {#if handoffTargets.length}
      <div class="ui-menu-separator" role="separator"></div>
      <p class="driver-group-label">{$t('code.driverPicker.handoffTitle')}</p>
      {#each handoffTargets as item (item.instance_id)}
        <MenuItem
          class="driver-option"
          title={item.use_for || $t('code.driverPicker.handoffHint')}
          onselect={() => void handoff(item.instance_id)}
        >
          <DriverIcon instanceId={item.instance_id} driverKind={item.driver_kind} size={15} class="driver-row-icon" />
          <span class="driver-name">{item.label}</span>
          <span class={uiClass('driver-status', statusTone(item.status))}>{statusText(item.instance_id, item.status)}</span>
        </MenuItem>
      {/each}
    {/if}
  {/if}

  <div class="ui-menu-separator" role="separator"></div>
  <MenuItem icon={Settings2} label={$t('code.driverPicker.manage')} onselect={openSettings} />
</Menu>

<style>
  :global(.driver-trigger) { min-width: 0; max-width: 10.5rem; }
  :global(.driver-trigger:focus-visible) { outline: 2px solid var(--brand-accent); outline-offset: 2px; }
  :global(.driver-icon.is-accent) { color: var(--brand-accent-strong); }
  :global(.driver-menu) { width: 20rem; max-width: calc(100vw - 1.5rem); }
  :global(.driver-menu .driver-option) { padding: 0.3125rem 0.625rem; }
  :global(.driver-menu .driver-option.is-active) { background: var(--float-row-selected); }
  :global(.driver-menu .driver-row-icon) { color: var(--text-secondary); }
  :global(.driver-menu .driver-option:hover .driver-row-icon),
  :global(.driver-menu .driver-option.is-active .driver-row-icon) { color: var(--foreground); }
  :global(.driver-menu .ui-menu-check) { color: var(--brand-accent-strong); }
  .driver-name { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .driver-status { flex-shrink: 0; margin-left: auto; padding-left: 0.75rem; color: var(--muted-foreground); font-size: var(--text-xs); white-space: nowrap; }
  .driver-status.is-ready { color: var(--success); }
  .driver-status.is-warn { color: var(--warning); }
  .driver-status.is-error { color: var(--error); }
  .driver-fixed-note { display: flex; flex-direction: column; gap: 0.125rem; margin: 0; padding: 0.375rem 0.625rem; }
  .driver-fixed-name { color: var(--foreground); font-size: var(--text-xs); font-weight: 500; }
  .driver-fixed-hint { color: var(--muted-foreground); font-size: var(--text-xs); line-height: 1.4; }
  .driver-group-label { margin: 0; padding: 0.25rem 0.625rem 0.125rem; color: var(--muted-foreground); font-size: var(--text-xs); font-weight: 500; }
  @container composer (max-width: 480px) {
    :global(.driver-trigger .trigger-label), :global(.driver-trigger .driver-chevron) { display: none; }
    :global(.driver-trigger) { padding-inline: 0.375rem; }
  }
</style>
