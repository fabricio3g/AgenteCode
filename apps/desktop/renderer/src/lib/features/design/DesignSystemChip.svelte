<svelte:options runes={true} />

<!--
  The toolbar's design-system control: the system this design uses, and a menu
  of the library's actions. Wide canvases show its name; narrow ones only the
  palette icon, with the name in the tooltip.
-->

<script lang="ts">
  import { Palette } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { copy } from '$lib/copy';
  import DesignSystemItems from './DesignSystemItems.svelte';
  import { designSystems } from './design-systems.svelte';

  let { showName = true, onmanage }: { showName?: boolean; onmanage: () => void } = $props();

  let menu = $state(false);
  const name = $derived(designSystems.linked?.name ?? copy.design.systems.none);
  const label = $derived(`${copy.design.systems.label}: ${name}`);
</script>

<Menu bind:open={menu} placement="bottom-start" minWidth="14rem" label={copy.design.systems.label}>
  {#snippet trigger(props)}
    {#if showName}
      <Button variant="ghost" size="sm" class="h-[1.625rem] max-w-[12rem] gap-1.5 px-2 text-xs" aria-label={label} title={copy.design.systems.label} {...props}>
        <Palette aria-hidden="true" />
        <span class="truncate">{name}</span>
      </Button>
    {:else}
      <Tooltip label={label} position="bottom">
        <IconButton label={label} title="" {...props}><Palette aria-hidden="true" /></IconButton>
      </Tooltip>
    {/if}
  {/snippet}
  <DesignSystemItems {onmanage} />
</Menu>
