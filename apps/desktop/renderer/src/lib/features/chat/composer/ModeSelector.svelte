<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, Sparkles, Zap } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { Button } from '$lib/components/ui';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';

  let { modes = ['agent', 'instant'] }: { modes?: Array<'instant' | 'agent'> } = $props();
  let open = $state(false);
</script>

{#if modes.length > 1}
  <Menu bind:open placement="top-start" label={copy.composer.selectMode}>
    {#snippet trigger(props)}
      <Button variant="plain" type="button" class="composer-selector mode-trigger mode-selector flex h-6 items-center gap-1 px-2"
        aria-label={copy.composer.selectMode} title={$t(`chat.mode.${appStore.composerMode}Hint`)} {...props}>
        <span class="trigger-label">{$t(`chat.mode.${appStore.composerMode}`)}</span>
        <ChevronDown class="size-3 shrink-0" />
      </Button>
    {/snippet}
    {#each modes as mode (mode)}
      <MenuItem icon={mode === 'agent' ? Sparkles : Zap} label={$t(`chat.mode.${mode}`)}
        title={$t(`chat.mode.${mode}Hint`)} active={appStore.composerMode === mode}
        onselect={() => appStore.setComposerMode(mode)} />
    {/each}
  </Menu>
{/if}
