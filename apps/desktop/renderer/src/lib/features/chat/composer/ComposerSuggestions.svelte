<svelte:options runes={true} />

<!--
  Starter prompts under the composer, shown only while a conversation is empty.

  One line of links, in the same look the Code space and the Design dock use: a
  row of pills with glyphs competed with the composer for the eye, and the same
  suggestion in three spaces should read the same way. Selecting one fills the
  composer and focuses it rather than sending, so a mis-tap costs nothing and
  the prompt can still be edited before it goes anywhere. The Design dock lists
  its own starters, so that composer is told to skip these.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import StarterList from '$lib/components/ui/StarterList.svelte';
  import type { Starter } from '$lib/components/ui/starter-list';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    /** Focuses the composer textarea after the prompt is inserted. */
    onpick: () => void;
  }

  let { onpick }: Props = $props();

  /** The links paint no description, so the prompt's first clause rides on the
   *  link's tooltip instead — the same thing the row look prints under the name. */
  const firstClause = (prompt: string) => prompt.split(/[.,]\s/)[0].replace(/\.$/, '').trim();

  const starters = $derived<Starter[]>(
    copy.emptyState.suggestions.map((suggestion) => ({
      id: suggestion.id,
      label: suggestion.label,
      hint: firstClause(suggestion.prompt)
    }))
  );

  async function pick(id: string) {
    const suggestion = copy.emptyState.suggestions.find((item) => item.id === id);
    if (!suggestion) return;
    appStore.composer = suggestion.prompt;
    // The textarea holds the prompt only once the update lands; focusing before
    // that puts the caret at the pre-insert length.
    await tick();
    onpick();
  }
</script>

<div class="suggestions">
  <StarterList {starters} label={copy.emptyState.greeting} onpick={(id) => void pick(id)} variant="links" />
</div>

<style>
  /* The composer dock is pointer-events:none so the thread stays scrollable
     behind it; anything interactive inside has to opt back in. The dock's own
     `px-3 md:px-6` already starts this line on the composer card's edge. */
  .suggestions {
    margin-top: 0.75rem;
    pointer-events: auto;
  }
</style>
