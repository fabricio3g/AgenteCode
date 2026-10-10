<svelte:options runes={true} />

<!--
  One artifact in the library grid: a real preview on top (see
  ArtifactThumb, loaded once the card scrolls into view), then its kind,
  title, chat and date. A trash button appears on hover or keyboard focus.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { locale } from 'svelte-i18n';
  import { BarChart3, FileSpreadsheet, FileText, Globe, Presentation, Trash2 } from 'lucide-svelte';
  import ArtifactThumb from './ArtifactThumb.svelte';
  import type { LibraryEntry } from './artifact-library';
  import { artifactKindAccent } from '$lib/ui/components/artifact-accent';

  let { entry, onopen, ondelete }: { entry: LibraryEntry; onopen: () => void; ondelete: () => void } = $props();

  const ICONS = { documents: FileText, presentations: Presentation, spreadsheets: FileSpreadsheet, visuals: BarChart3, web: Globe } as const;
  const Icon = $derived(ICONS[entry.group]);

  let card = $state<HTMLElement>();
  let visible = $state(false);
  $effect(() => {
    if (!card || visible) return;
    const observer = new IntersectionObserver((items) => {
      if (items.some((item) => item.isIntersecting)) {
        visible = true;
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(card);
    return () => observer.disconnect();
  });

  function when(ts: number): string {
    if (!ts) return '';
    const days = Math.floor((Date.now() - ts) / 86_400_000);
    const lang = $locale || 'en';
    if (days < 7) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-days, 'day');
    return new Date(ts).toLocaleDateString(lang, { month: 'short', day: 'numeric' });
  }
</script>

<div class="card group" bind:this={card} style:--artifact-accent={artifactKindAccent(entry.kind)}>
  <UiButton variant="plain" type="button" class={uiClass("open", "ui-local-b2856088")} onclick={onopen}>
    <div class="thumb" data-group={entry.group}>
      <ArtifactThumb artifact={entry.artifact} {visible} />
    </div>
    <div class="min-w-0 px-3.5 pb-3 pt-2.5 text-left">
      <p class="kind flex items-center gap-1.5 text-[length:var(--text-xs)]">
        <span class="kind-tile" aria-hidden="true"><Icon class="size-3" /></span>
        <span class="truncate">{$t(`artifacts.group.${entry.group}`)}</span>
      </p>
      <p class="mt-1 line-clamp-2 text-sm font-medium leading-snug text-foreground">{entry.artifact.title || $t('artifacts.untitled')}</p>
      <p class="mt-1 truncate text-[12px] text-muted-foreground">{entry.chatTitle} · {when(entry.createdAt)}</p>
    </div>
  </UiButton>
  <IconButton label={$t('artifacts.delete')} size="xs" variant="ghost" type="button" class={uiClass("delete", "ui-local-b2856088")}  title={$t('artifacts.delete')} onclick={ondelete}>
    <Trash2 class="size-3.5" />
  </IconButton>
</div>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--artifact-accent) 24%, var(--border));
    border-radius: 1rem;
    background: var(--background);
    text-align: left;
    transition: border-color var(--motion-fast) var(--motion-ease), box-shadow var(--motion-fast) var(--motion-ease), transform var(--motion-fast) var(--motion-ease);
  }
  .card:hover {
    border-color: color-mix(in srgb, var(--artifact-accent) 45%, var(--border));
    box-shadow: var(--shadow-md);
  }
  .card:has(:is(.open:focus-visible, :global(.open:focus-visible.ui-local-b2856088))) {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent);
  }
  :global(.open.ui-local-b2856088) {
    display: flex;
    flex-direction: column;
    text-align: left;
    outline: none;
  }
  .kind { color: var(--artifact-accent); }
  /* The kind's glyph rides its accent tile, white on colour, like every other
     artifact surface. */
  .kind-tile {
    display: inline-flex;
    width: 1.125rem;
    height: 1.125rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.3125rem;
    background: var(--artifact-accent);
    color: #fff;
  }
  :global(.delete.ui-local-b2856088) {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    width: 1.75rem;
    height: 1.75rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--background) 88%, transparent);
    color: var(--muted-foreground);
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }
  .card:hover :global(.delete.ui-local-b2856088),
  .card:focus-within :global(.delete.ui-local-b2856088) {
    opacity: 1;
  }
  :global(.delete:hover.ui-local-b2856088),
  :global(.delete:focus-visible.ui-local-b2856088) {
    color: var(--destructive);
    background: var(--background);
    outline: none;
  }
  .thumb {
    position: relative;
    display: flex;
    aspect-ratio: 16 / 10;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-bottom: 1px solid var(--border-subtle);
    background: color-mix(in srgb, var(--artifact-accent) 6%, var(--muted));
    color: var(--muted-foreground);
  }
</style>
