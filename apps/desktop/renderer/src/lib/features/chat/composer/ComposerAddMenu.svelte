<svelte:options runes={true} />

<!--
  The composer's "+" menu: attach a file or pick a search level.

  The options are listed flat rather than as nested dropdowns. A dropdown inside
  a dropdown portals its panel outside this menu's DOM, so selecting an item
  reads as an outside click, closes this menu, and unmounts the inner one before
  the choice registers — the selection silently does nothing.
-->

<script lang="ts">
  import { Check, Globe2, Layers, MessageSquare, Paperclip, Plus, Radar, X } from 'lucide-svelte';
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

<Menu bind:open placement="top-start" minWidth="16.5rem" label="Composer options">
  {#snippet trigger(props)}
    <button
      type="button"
      class="add-trigger"
      class:is-open={open}
      aria-label={copy.composer.attach}
      title={copy.composer.attach}
      {...props}
    >
      <Plus class="size-4" />
    </button>
  {/snippet}

  <button
    type="button"
    role="menuitem"
    class="aui-menu-item"
    onclick={() => { open = false; onattach(); }}
  >
    <Paperclip class="size-4" />
    <span class="aui-menu-item-text">{copy.composer.attach}</span>
  </button>

  {#if availableModes.length > 1}
    <div class="aui-menu-divider" role="separator"></div>
    {#each availableModes as id (id)}
      {@const Icon = MODE_ICONS[id]}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={searchMode === id}
        class="aui-menu-item"
        class:is-active={searchMode === id}
        onclick={() => { appStore.setSearchMode(id); open = false; }}
      >
        <Icon class="size-4" />
        <span class="aui-menu-item-text">
          <span>{copy.searchModes[id].label}</span>
          <span class="aui-menu-item-hint">{copy.searchModes[id].description}</span>
        </span>
        {#if searchMode === id}<Check class="aui-menu-check size-3.5" />{/if}
      </button>
    {/each}
  {/if}
</Menu>

<!-- The active research depth stays visible once the menu closes. -->
{#if searchMode !== 'chat' && availableModes.includes(searchMode)}
  {@const ActiveIcon = MODE_ICONS[searchMode]}
  <span class="mode-chip" title={copy.searchModes[searchMode].description}>
    <ActiveIcon class="size-3.5 shrink-0" />
    <span>{copy.searchModes[searchMode].label}</span>
    <button
      type="button"
      class="mode-chip-clear"
      aria-label={`${copy.actions.remove}: ${copy.searchModes[searchMode].label}`}
      onclick={() => appStore.setSearchMode('chat')}
    >
      <X class="size-3" />
    </button>
  </span>
{/if}

<style>
  /* Matches the model chip beside it: same height, borderless until hovered. */
  .add-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 1.75rem;
    width: 1.75rem;
    border: 1px solid transparent;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-secondary);
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .add-trigger:hover,
  .add-trigger.is-open {
    background: var(--muted);
    color: var(--foreground);
  }

  /* The active depth, tinted with the brand so it reads as "on". */
  .mode-chip {
    display: inline-flex;
    height: 1.75rem;
    align-items: center;
    gap: 0.3125rem;
    padding: 0 0.25rem 0 0.5625rem;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--primary) 9%, transparent);
    color: color-mix(in srgb, var(--primary) 82%, var(--foreground));
    font-size: 0.78125rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .mode-chip-clear {
    display: inline-flex;
    width: 1.25rem;
    height: 1.25rem;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: inherit;
    opacity: 0.6;
    transition: opacity var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }

  .mode-chip-clear:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--primary) 14%, transparent);
  }

  .add-trigger:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 35%, transparent);
  }
</style>
