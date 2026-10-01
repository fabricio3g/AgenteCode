<script lang="ts">
  import { t } from 'svelte-i18n';
  let { items, active, onchange }: { items: Array<{ id: string; title: string }>; active: string; onchange: (id: string) => void } = $props();
  function navigate(event: KeyboardEvent, index: number) {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    onchange(items[next].id);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }
</script>
{#if items.length > 1}
  <div class="viewer-tabs" role="tablist" aria-label={$t('artifacts.group.documents')}>
    {#each items as item, index (item.id)}<button type="button" role="tab" aria-selected={item.id === active} tabindex={item.id === active ? 0 : -1} class:active={item.id === active} title={item.title} onclick={() => onchange(item.id)} onkeydown={event => navigate(event, index)}>{item.title}</button>{/each}
  </div>
{/if}
<style>
  .viewer-tabs { display:flex; height:24px; flex-shrink:0; gap:2px; padding:0 6px 4px; overflow-x:auto; scrollbar-width:none; }
  button { flex-shrink:0; max-width:9rem; height:20px; padding:0 9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border-radius:999px; color:var(--muted-foreground); font-size:11.5px; }
  button:hover { background:var(--surface-hover); color:var(--foreground); }
  button.active { background:var(--muted); color:var(--foreground); }
  button:focus-visible { outline:1px solid var(--muted-foreground); outline-offset:-1px; }
</style>
