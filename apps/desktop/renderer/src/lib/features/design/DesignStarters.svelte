<svelte:options runes={true} />

<!--
  Starter screens for the empty dock: one row per screen, rendered through the
  shared list look so the Design dock and the Code space's first conversation
  teach the same grammar.

  Picking one fills the composer and focuses it, so a mis-tap costs nothing and
  the prompt can still be edited before sending.
-->

<script lang="ts">
  import StarterList from '$lib/components/ui/StarterList.svelte';
  import type { Starter } from '$lib/components/ui/starter-list';

  import { BadgeDollarSign, LayoutDashboard, LayoutTemplate, LogIn, MousePointerClick, Smartphone } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  const ICONS = {
    landing: LayoutTemplate,
    dashboard: LayoutDashboard,
    mobile: Smartphone,
    pricing: BadgeDollarSign,
    login: LogIn,
    micro: MousePointerClick
  } as const;

  /** Each starter's glyph carries its own muted hue, the way the artifact list's glyphs do.
   *  Kept clear of the brand's own hue (47°) so a tile never reads as the accent. */
  const HUES: Record<string, number> = { landing: 250, dashboard: 200, mobile: 165, pricing: 62, login: 300, micro: 340 };

  /** A starter's description: its first clause, so the row says what the screen is. */
  const firstClause = (prompt: string) => prompt.split(/[.,]\s/)[0].replace(/\.$/, '');

  const starters = $derived<Starter[]>(copy.design.suggestions.map((suggestion) => ({
    id: suggestion.id,
    hue: HUES[suggestion.id] ?? 250,
    icon: ICONS[suggestion.id as keyof typeof ICONS],
    label: suggestion.label,
    hint: firstClause(suggestion.prompt)
  })));

  function pick(id: string) {
    const suggestion = copy.design.suggestions.find((item) => item.id === id);
    if (!suggestion) return;
    appStore.composer = suggestion.prompt;
    window.dispatchEvent(new Event('focus-composer'));
  }
</script>

<StarterList {starters} label={copy.design.dock.starters} onpick={pick} />
