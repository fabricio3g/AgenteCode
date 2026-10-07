<svelte:options runes={true} />

<!--
  The Home composer's Tools menu: which groups of agent tools the model may use.
  Rows toggle in place (data-keep-open) so several can be flipped in one visit.
  The setting is global and persists as `ui.home_tools_disabled`.
-->

<script lang="ts">
  import { Check, MoreHorizontal, Wrench } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { Menu } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { HOME_TOOL_GROUPS, isToolDisabled, toggleGroup, type HomeToolGroupId } from '$lib/services/agent-tool-registry';

  let { compact = false }: { compact?: boolean } = $props();
  let open = $state(false);

  const disabled = $derived(appStore.homeToolsDisabled);
  const groups = $derived(
    HOME_TOOL_GROUPS.map((group) => {
      const on = group.tools.filter((tool) => !isToolDisabled(tool, disabled)).length;
      return { ...group, on, total: group.tools.length };
    })
  );
  const totalOn = $derived(groups.reduce((sum, group) => sum + group.on, 0));
  const total = $derived(groups.reduce((sum, group) => sum + group.total, 0));

  function flip(id: HomeToolGroupId, enabled: boolean) {
    void appStore.setHomeToolsDisabled(toggleGroup(disabled, id, enabled));
  }
</script>

<Menu bind:open placement="top-start" minWidth="15rem" label={$t('home.tools.title')}>
  {#snippet trigger(props)}
    <button type="button" class="tools-trigger" class:is-compact={compact} class:is-open={open} title={$t('home.tools.title')} aria-label={`${$t('home.tools.title')} · ${$t('home.tools.button', { values: { on: totalOn, total } })}`} {...props}>
      {#if compact}<MoreHorizontal class="size-3.5" />{:else}<Wrench class="size-3.5" /><span>{$t('home.tools.button', { values: { on: totalOn, total } })}</span>{/if}
    </button>
  {/snippet}

  <div class="tools-head">{$t('home.tools.title')}</div>
  {#each groups as group (group.id)}
    {@const enabled = group.on > 0}
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={enabled}
      data-keep-open
      class="ui-menu-item"
      class:is-active={enabled}
      onclick={() => flip(group.id, !enabled)}
    >
      <span class="ui-menu-item-text">
        <span class="truncate">{$t(`home.tools.group.${group.id}`)}</span>
        <span class="ui-menu-item-hint">{$t('home.tools.count', { values: { on: group.on, total: group.total } })}</span>
      </span>
      {#if enabled}<Check class="ui-menu-check size-3.5" />{/if}
    </button>
  {/each}
</Menu>

<style>
  .tools-trigger {
    display: inline-flex;
    height: 26px;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.5rem;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .tools-trigger.is-compact { width:1.75rem;justify-content:center;padding:0; }

  .tools-trigger:hover,
  .tools-trigger.is-open {
    color: var(--foreground);
  }

  .tools-trigger:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  .tools-head {
    padding: 0.25rem 0.625rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
</style>
