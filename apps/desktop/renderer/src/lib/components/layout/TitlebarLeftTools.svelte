<svelte:options runes={true} />

<!--
  The title bar's left group — sidebar toggle, search, model settings. The
  sidebar's hover preview reaches the top of the window and draws this same
  group in the same spot, so the buttons never vanish under it.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { PanelLeftClose, PanelLeftOpen, Search, SlidersHorizontal } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { appStore } from '$lib/stores/app.svelte';

  let { expanded, onToggle, onEnter, onLeave }: {
    /** The sidebar is showing (pinned or previewed). */
    expanded: boolean;
    onToggle: () => void;
    onEnter?: () => void;
    onLeave?: (event: PointerEvent) => void;
  } = $props();

  const isMac = typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin';
  const toggleLabel = $derived(appStore.sidebarOpen ? $t('titlebar.hideSidebar') : $t('titlebar.showSidebar'));
</script>

<div class="flex min-w-0 items-center gap-0.5 pl-1.5" style={isMac ? 'padding-left: 78px;' : ''}>
  <Tooltip label={toggleLabel}>
    <button
      class="ui-icon-button titlebar-no-drag"
      data-sidebar-toggle
      onclick={onToggle}
      onpointerenter={onEnter}
      onpointerleave={onLeave}
      aria-controls="app-sidebar"
      aria-expanded={expanded}
      aria-pressed={appStore.sidebarOpen}
      aria-label={toggleLabel}
    >
      {#if appStore.sidebarOpen}<PanelLeftClose class="size-4" />{:else}<PanelLeftOpen class="size-4" />{/if}
    </button>
  </Tooltip>
  <Tooltip label={$t('titlebar.search')}>
    <button class="ui-icon-button titlebar-no-drag titlebar-secondary" onclick={() => appStore.openSearch()} aria-label={$t('titlebar.search')}>
      <Search class="size-4" />
    </button>
  </Tooltip>
  <Tooltip label={$t('titlebar.llmSettings')}>
    <button class="ui-icon-button titlebar-no-drag titlebar-secondary" onclick={() => (appStore.llmDrawerOpen = true)} aria-label={$t('titlebar.llmSettings')}>
      <SlidersHorizontal class="size-4" />
    </button>
  </Tooltip>
</div>
