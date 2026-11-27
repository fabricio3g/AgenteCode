<svelte:options runes={true} />

<!--
  Back and Forward, as a browser draws them: two arrows at a fixed place in the
  top bar, dimmed when there is nowhere to go.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ArrowLeft, ArrowRight } from '$lib/icons';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { navHistory } from '$lib/stores/nav-history.svelte';
  import { isMacPlatform } from '$lib/utils/shortcuts';

  const mac = isMacPlatform();
</script>

<div class="nav-history titlebar-no-drag">
  <Tooltip label={$t('titlebar.back')} shortcut={mac ? 'mod+[' : 'alt+left'} position="bottom">
    <UiIconButton label={$t('titlebar.back')} title="" size="sm" disabled={!navHistory.canBack} onclick={() => navHistory.back()}>
      <ArrowLeft class="size-4" />
    </UiIconButton>
  </Tooltip>
  <Tooltip label={$t('titlebar.forward')} shortcut={mac ? 'mod+]' : 'alt+right'} position="bottom">
    <UiIconButton label={$t('titlebar.forward')} title="" size="sm" disabled={!navHistory.canForward} onclick={() => navHistory.forward()}>
      <ArrowRight class="size-4" />
    </UiIconButton>
  </Tooltip>
</div>

<style>
  .nav-history {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    -webkit-app-region: no-drag;
  }
</style>
