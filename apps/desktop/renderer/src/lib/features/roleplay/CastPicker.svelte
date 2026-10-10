<svelte:options runes={true} />

<!--
  Cast picker: toggle characters into an ordered scene cast.

  Shared by scene setup and the mid-chat cast editor so a roster is chosen the
  same way everywhere. Selection order is speaking order — the first member is
  the primary.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { Check } from 'lucide-svelte';
  import { charactersStore } from './characters.svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    /** Selected character ids, in speaking order. */
    value: string[];
    onchange: (ids: string[]) => void;
    emptyHint?: string;
  }

  let { value, onchange, emptyHint = '' }: Props = $props();

  function toggle(id: string) {
    onchange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]);
  }
</script>

{#if !charactersStore.characters.length}
  <p class="py-2 text-xs text-muted-foreground">
    {emptyHint || $t('roleplay.setup.noCharacters')}
  </p>
{:else}
  <div class="cast-grid">
    {#each charactersStore.characters as card (card.id)}
      {@const order = value.indexOf(card.id)}
      <UiButton variant="plain"
        type="button"
        class={uiClass(`cast-option ${order >= 0 ? 'is-on' : ''}`, "ui-local-5da35dd3")}
        onclick={() => toggle(card.id)}
        aria-pressed={order >= 0}
      >
        <span class="cast-avatar">
          <Avatar size="fill" name={card.name ?? ''} image={card.avatar} />
          {#if order >= 0}
            <span class="cast-check"><Check class="size-2.5" /></span>
          {/if}
        </span>
        <span class="min-w-0 flex-1 truncate text-left text-[12px] text-foreground">{card.name}</span>
        {#if order >= 0}
          <span class="cast-order" title={$t('roleplay.setup.speakingOrder', { values: { n: order + 1 } })}>#{order + 1}</span>
        {/if}
      </UiButton>
    {/each}
  </div>
{/if}

<style>
  .cast-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: 0.375rem;
    max-height: 15rem;
    overflow-y: auto;
    padding: 0.125rem;
  }

  :global(.cast-option.ui-local-5da35dd3) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease);
  }

  :global(.cast-option:hover.ui-local-5da35dd3) {
    background: var(--surface-hover);
  }

  :global(.cast-option.is-on.ui-local-5da35dd3) {
    border-color: var(--border-hover);
    background: var(--surface-active);
  }

  .cast-avatar {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    overflow: visible;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }


  .cast-check {
    position: absolute;
    right: -0.1875rem;
    bottom: -0.1875rem;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 0.875rem;
    height: 0.875rem;
    border-radius: var(--radius-full);
    background: var(--primary);
    color: var(--primary-foreground);
  }

  .cast-order {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
</style>
