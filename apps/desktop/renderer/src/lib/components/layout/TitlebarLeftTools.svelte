<svelte:options runes={true} />

<!--
  The title bar's sidebar toggle and local-model settings when the sidebar is
  hidden. Conversation search lives alongside the space tabs in the title bar.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { PanelLeftClose, PanelLeftOpen, SlidersHorizontal } from 'lucide-svelte';
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
  <Tooltip label={toggleLabel} shortcut="mod+b">
    <UiIconButton label={toggleLabel} size="sm"
      class={uiClass(" titlebar-no-drag")}
      data-sidebar-toggle
      onclick={onToggle}
      onpointerenter={onEnter}
      onpointerleave={onLeave}
      aria-controls="app-sidebar"
      aria-expanded={expanded}
      aria-pressed={appStore.sidebarOpen}

    >
      {#if appStore.sidebarOpen}<PanelLeftClose class="size-4" />{:else}<PanelLeftOpen class="size-4" />{/if}
    </UiIconButton>
  </Tooltip>
  <!-- Local-engine tuning (context length, GPU layers…): a cloud model has none. -->
  {#if appStore.backendMode !== 'api'}
    <Tooltip label={$t('titlebar.llmSettings')}>
      <UiIconButton label={$t('titlebar.llmSettings')} size="sm" class={uiClass(" titlebar-no-drag titlebar-secondary")} onclick={() => (appStore.llmDrawerOpen = true)} >
        <SlidersHorizontal class="size-4" />
      </UiIconButton>
    </Tooltip>
  {/if}
</div>
