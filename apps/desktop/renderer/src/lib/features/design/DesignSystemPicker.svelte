<svelte:options runes={true} />

<!--
  The empty dock offers the saved design systems as one segmented control:
  picking one copies it into this design, "No system" stops using one. The
  control only appears once the library has something in it.
-->

<script lang="ts">
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { copy } from '$lib/copy';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { designStore } from './design.svelte';
  import { designSystems } from './design-systems.svelte';

  const NONE = 'none';
  const chatId = $derived(designStore.chatId);
  const value = $derived(designSystems.linked?.id ?? NONE);
  const options = $derived([
    { value: NONE, label: copy.design.systems.none },
    ...designSystems.list.map((system) => ({ value: system.id, label: system.name, title: system.description || system.name }))
  ]);

  async function choose(next: string) {
    if (!chatId || next === value) return;
    try {
      if (next === NONE) await designSystems.unlink(chatId);
      else await designSystems.apply(chatId, next);
    } catch (cause) {
      toastStore.error(String(cause));
    }
  }
</script>

{#if chatId && designSystems.list.length}
  <div class="systems">
    <p class="label">{copy.design.systems.intro}</p>
    <SegmentedControl label={copy.design.systems.intro} {options} {value} onchange={(next) => void choose(next)} />
  </div>
{/if}

<style>
  .systems {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    padding-inline: 0.625rem;
  }

  .label {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
</style>
