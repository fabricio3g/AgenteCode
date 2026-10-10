<svelte:options runes={true} />

<!--
  The composer's "+" menu: attach a file or pick a search level.

  The options are listed flat rather than as nested dropdowns. A dropdown inside
  a dropdown portals its panel outside this menu's DOM, so selecting an item
  reads as an outside click, closes this menu, and unmounts the inner one before
  the choice registers — the selection silently does nothing.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

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
    <IconButton label={copy.composer.attach} size="xs" variant="ghost"
      type="button"
      class={uiClass("add-trigger", "ui-local-0d4ea47c", {"is-open": open})}


      title={copy.composer.attach}
      {...props}
    >
      <Plus class="size-4" />
    </IconButton>
  {/snippet}

  <UiListRow
    type="button"
    role="menuitem"
    class={uiClass("ui-menu-item", "ui-local-0d4ea47c")}
    onclick={() => { open = false; onattach(); }}
  >
    <Paperclip class="size-4" />
    <span class="ui-menu-item-text">{copy.composer.attach}</span>
  </UiListRow>

  {#if availableModes.length > 1}
    <div class="ui-menu-divider" role="separator"></div>
    {#each availableModes as id (id)}
      {@const Icon = MODE_ICONS[id]}
      <UiListRow
        type="button"
        role="menuitemradio"
        aria-checked={searchMode === id}
        class={uiClass("ui-menu-item", "ui-local-0d4ea47c", {"is-active": searchMode === id})}

        title={copy.searchModes[id].description}
        onclick={() => { appStore.setSearchMode(id); open = false; }}
      >
        <Icon class="size-4" />
        <span class="ui-menu-item-text">
          <span>{copy.searchModes[id].label}</span>
        </span>
        {#if searchMode === id}<Check class="ui-menu-check size-3.5" />{/if}
      </UiListRow>
    {/each}
  {/if}
</Menu>

<!-- The active research depth stays visible once the menu closes. -->
{#if searchMode !== 'chat' && availableModes.includes(searchMode)}
  {@const ActiveIcon = MODE_ICONS[searchMode]}
  <span class="mode-chip" title={copy.searchModes[searchMode].description}>
    <ActiveIcon class="size-3.5 shrink-0" />
    <span>{copy.searchModes[searchMode].label}</span>
    <IconButton label={`${copy.actions.remove}: ${copy.searchModes[searchMode].label}`} size="xs" variant="ghost"
      type="button"
      class={uiClass("mode-chip-clear", "ui-local-0d4ea47c")}

      onclick={() => appStore.setSearchMode('chat')}
    >
      <X class="size-3" />
    </IconButton>
  </span>
{/if}

<style>
  /* Matches the model chip beside it: same height, borderless until hovered. */
  :global(.add-trigger.ui-local-0d4ea47c) {
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

  :global(.add-trigger:hover.ui-local-0d4ea47c),
  :global(.add-trigger.is-open.ui-local-0d4ea47c) {
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

  :global(.mode-chip-clear.ui-local-0d4ea47c) {
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

  :global(.mode-chip-clear:hover.ui-local-0d4ea47c) {
    opacity: 1;
    background: color-mix(in srgb, var(--primary) 14%, transparent);
  }

  :global(.add-trigger:focus-visible.ui-local-0d4ea47c) {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in oklch, var(--ring) 35%, transparent);
  }
</style>
