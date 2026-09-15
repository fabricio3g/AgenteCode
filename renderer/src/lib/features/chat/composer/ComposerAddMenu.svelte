<svelte:options runes={true} />

<!--
  The composer's "+" menu: attach a file or pick a search level.

  The options are listed flat rather than as nested dropdowns. A dropdown inside
  a dropdown portals its panel outside this menu's DOM, so selecting an item
  reads as an outside click, closes this menu, and unmounts the inner one before
  the choice registers — the selection silently does nothing.
-->

<script lang="ts">
  import { Bot, Check, Globe2, Layers, MessageSquare, Paperclip, Plus, Radar } from 'lucide-svelte';
  import { Menu } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { SPACES } from '$lib/spaces';

  interface Props {
    /** Opens the file picker owned by the composer. */
    onattach: () => void;
  }

  let { onattach }: Props = $props();
  let open = $state(false);

  type SearchModeId = keyof typeof copy.searchModes;
  const MODE_IDS: SearchModeId[] = ['chat', 'search', 'deep', 'max'];
  const MODE_ICONS = { chat: MessageSquare, search: Globe2, deep: Layers, max: Radar } as const;

  // Research depths are a Home capability; the code space offers plain chat.
  const availableModes = $derived(
    MODE_IDS.filter((id) => SPACES[appStore.activeSpace].searchModes.includes(id))
  );
  const searchMode = $derived(MODE_IDS.find((id) => id === appStore.searchMode) || 'chat');
</script>

<Menu bind:open placement="top-start" minWidth="14rem" label="Composer options">
  {#snippet trigger(props)}
    <button
      type="button"
      class="add-trigger"
      class:is-open={open}
      aria-label={copy.composer.attach}
      title={copy.composer.attach}
      {...props}
    >
      <Plus class="size-[18px]" />
    </button>
  {/snippet}

  <button
    type="button"
    role="menuitem"
    class="row"
    onclick={() => { open = false; onattach(); }}
  >
    <Paperclip class="size-4 shrink-0" />
    <span class="row-label">{copy.composer.attach}</span>
  </button>

  {#if availableModes.length > 1}
    <div class="group-label">Search</div>
    {#each availableModes as id (id)}
      {@const Icon = MODE_ICONS[id]}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={searchMode === id}
        class="row"
        onclick={() => { appStore.setSearchMode(id); open = false; }}
      >
        <Icon class="size-4 shrink-0" />
        <span class="row-label">{copy.searchModes[id].label}</span>
        {#if searchMode === id}<Check class="size-3.5 shrink-0" />{/if}
      </button>
    {/each}
  {/if}

  {#if appStore.activeSpace === 'code'}
  <button type="button" role="menuitemcheckbox" aria-checked={appStore.composerMode === 'agent'} class="row"
    onclick={() => { appStore.setComposerMode(appStore.composerMode === 'agent' ? 'chat' : 'agent'); open = false; }}>
    <Bot class="size-4 shrink-0" />
    <span class="row-label">Agent</span>
    {#if appStore.composerMode === 'agent'}<Check class="size-3.5 shrink-0" />{/if}
  </button>
  {/if}

</Menu>

<style>
  /* Matches the model chip beside it: same height, white, hairline border. */
  .add-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 2rem;
    width: 2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--card);
    color: var(--text-secondary);
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .add-trigger:hover,
  .add-trigger.is-open {
    border-color: color-mix(in srgb, var(--foreground) 22%, transparent);
    background: var(--muted);
    color: var(--foreground);
  }

  .add-trigger:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 35%, transparent);
  }

  .row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text);
    font-size: 0.8125rem;
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .row:hover,
  .row:focus-visible {
    background: var(--surface-hover);
    outline: none;
  }

  .row-label {
    flex: 1;
    min-width: 0;
  }

  .group-label {
    padding: 0.5rem 0.625rem 0.25rem;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 500;
  }
</style>
