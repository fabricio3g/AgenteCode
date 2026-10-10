<svelte:options runes={true} />

<!--
  Starter screens for the empty dock: one quiet list row per screen, in the same
  row idiom as the app's menus. Picking one fills the composer and focuses it,
  so a mis-tap costs nothing and the prompt can still be edited before sending.
-->

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

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


  /** Each starter's glyph carries its own muted hue, the way the artifact list's glyphs do. */
  const HUES: Record<string, number> = { landing: 250, dashboard: 200, mobile: 160, pricing: 40, login: 300, micro: 340 };

  /** A starter's description: its first clause, so the row says what the screen is. */
  const firstClause = (prompt: string) => prompt.split(/[.,]\s/)[0].replace(/\.$/, '');

  function pick(prompt: string) {
    appStore.composer = prompt;
    window.dispatchEvent(new Event('focus-composer'));
  }
</script>

<ul class="starters" aria-label={copy.design.dock.starters}>
  {#each copy.design.suggestions as suggestion (suggestion.id)}
    {@const Icon = ICONS[suggestion.id as keyof typeof ICONS]}
    <li>
      <UiListRow  type="button" class={uiClass("ui-row starter", "ui-local-ac9f1bb9")} onclick={() => pick(suggestion.prompt)}>
        <span class="tile" style:--hue={HUES[suggestion.id] ?? 250}><Icon aria-hidden="true" /></span>
        <span class="text">
          <span class="label">{suggestion.label}</span>
          <span class="hint">{firstClause(suggestion.prompt)}</span>
        </span>
      </UiListRow>
    </li>
  {/each}
</ul>

<style>
  .starters {
    display: flex;
    width: 100%;
    margin: 0;
    padding: 0;
    flex-direction: column;
    gap: 0.0625rem;
    list-style: none;
  }

  :global(.starter.ui-local-ac9f1bb9) { min-height: 2.5rem; }

  /* The glyph sits on a soft tint of its own hue, the same tile the composer's starters carry, in both themes. */
  .tile {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    background: oklch(0.62 0.09 var(--hue) / 0.12);
    color: oklch(0.72 0.11 var(--hue));
  }

  :global(html:not(.dark)) .tile { color: oklch(0.5 0.12 var(--hue)); }

  .tile :global(svg) { width: 0.875rem; height: 0.875rem; }

  .text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .label {
    overflow: hidden;
    color: var(--foreground);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    overflow: hidden;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
