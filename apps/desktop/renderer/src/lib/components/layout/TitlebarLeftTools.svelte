<svelte:options runes={true} />

<!--
  The top bar's sidebar toggle: always the first control, so everything after
  it (Back/Forward, the space tabs) keeps its place. Hovering it previews the
  closed sidebar. While Settings owns the window there is no sidebar to show,
  so it stays put but disabled.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { t } from 'svelte-i18n';
  import { PanelLeftClose, PanelLeftOpen } from '$lib/icons';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { appStore } from '$lib/stores/app.svelte';

  let { expanded, disabled = false, onToggle, onEnter, onLeave }: {
    /** The sidebar is showing (pinned or previewed). */
    expanded: boolean;
    disabled?: boolean;
    onToggle: () => void;
    onEnter?: () => void;
    onLeave?: (event: PointerEvent) => void;
  } = $props();

  const toggleLabel = $derived(appStore.sidebarOpen ? $t('titlebar.hideSidebar') : $t('titlebar.showSidebar'));
</script>

<div class="flex min-w-0 items-center pl-1.5">
  <Tooltip label={toggleLabel} shortcut="mod+b">
    <UiIconButton label={toggleLabel} title="" size="sm"
      class="titlebar-no-drag"
      data-sidebar-toggle
      {disabled}
      onclick={onToggle}
      onpointerenter={disabled ? undefined : onEnter}
      onpointerleave={disabled ? undefined : onLeave}
      aria-controls="app-sidebar"
      aria-expanded={expanded}
      aria-pressed={appStore.sidebarOpen}
    >
      {#if appStore.sidebarOpen}<PanelLeftClose class="size-4" />{:else}<PanelLeftOpen class="size-4" />{/if}
    </UiIconButton>
  </Tooltip>
</div>
