<svelte:options runes={true} />

<!--
  The Settings screen's nav rail: one column for Models, the preferences and
  the model providers.

  This replaces the two rails the modal carried — `ModelNavRail` for Models and
  an `<aside>` for the settings sections — which shared a class and nothing
  else. Switching between "Library" and "General" no longer swaps the whole
  left column.

  It is a sidebar, not a second nav language: the column carries the sidebar's
  own plane (--sidebar) closed by the same 1px seam as the app sidebar, and
  every row rides app.css `.sidebar-row` — one height, one radius, one hover
  and current fill, one focus ring, shared with the conversation list next
  door. Group titles use `.sidebar-section`, status dots use `.sidebar-dot`.

  The rail renders the navigation model it is handed (groups of rows); the
  screen owns that model, so a label exists in one place only and the header
  can name the active row without re-deriving it.
-->

<script module lang="ts">
  import { Compass } from 'lucide-svelte';
  import type { ModelHubTab } from '$lib/types/model-hub';
  import type { SettingsNavigationSection } from '$lib/utils/model-hub-routing';

  /** lucide-svelte ships one component shape; any icon fits. */
  export type RailIcon = typeof Compass;

  export type RailItem =
    | { kind: 'section'; id: SettingsNavigationSection; label: string; icon: RailIcon; dot?: boolean }
    | { kind: 'tab'; id: ModelHubTab; label: string; icon: RailIcon; count?: number; dot?: boolean }
    | { kind: 'provider'; id: string; label: string; status: 'in-use' | 'ready' | 'none' };

  export type RailGroup = {
    id: string;
    title: string;
    /** A quiet sub-heading inside the group (Providers: Cloud, On device). */
    subgroups?: Array<{ title: string | null; items: RailItem[] }>;
    items: RailItem[];
  };
</script>

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { Plus } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import ModelSearchField from './ModelSearchField.svelte';
  import ProviderIcon from '$lib/components/ui/ProviderIcon.svelte';

  let {
    groups,
    selected,
    onselect,
    onaddendpoint
  }: {
    groups: RailGroup[];
    /** The row on screen, as `kind:id`. */
    selected: string;
    onselect: (item: RailItem) => void;
    onaddendpoint: () => void;
  } = $props();

  let rail = $state<HTMLElement>();
  let query = $state('');

  function key(item: RailItem): string {
    return `${item.kind}:${item.id}`;
  }

  function matches(item: RailItem): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return item.label.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle);
  }

  const visibleGroups = $derived(
    groups
      .map((group) => ({
        ...group,
        subgroups: group.subgroups?.map((sub) => ({ ...sub, items: sub.items.filter(matches) })),
        items: group.items.filter(matches)
      }))
      .filter((group) => group.items.length || group.subgroups?.some((sub) => sub.items.length))
  );
  const noMatches = $derived(!visibleGroups.length);

  /** Arrow keys walk every row in the rail, library actions included. */
  function onKeydown(event: KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = Array.from(rail?.querySelectorAll<HTMLButtonElement>('[data-nav-row]') ?? []).filter(
      (row) => !row.disabled
    );
    if (!rows.length) return;
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? rows.length - 1
      : event.key === 'ArrowDown' ? (index + 1 + rows.length) % rows.length
      : (index - 1 + rows.length) % rows.length;
    event.preventDefault();
    rows[next]?.focus();
  }

</script>

<aside
  bind:this={rail}
  class="flex shrink-0 flex-col gap-2 overflow-hidden border-b border-[var(--border)] bg-sidebar px-3 py-2.5 md:w-[236px] md:border-b-0 md:border-r md:pt-2 md:pb-4"
  aria-label={$t('settingsNav.label')}
>
  <div class="px-1">
    <ModelSearchField
      bind:value={query}
      placeholder={$t('settingsNav.filterSections')}
      label={$t('settingsNav.filterSections')}
      clearLabel={$t('settingsNav.clearFilter')}
      class="min-w-[11rem]"
    />
  </div>

  {#if noMatches}
    <p class="px-2.5 py-6 text-center text-xs text-muted-foreground">{$t('settingsNav.noMatches')}</p>
  {/if}

  <!-- Arrow keys walk the rows; the nav element itself takes no focus, which
       is what svelte's a11y rule wants here (the rows are the tab stops). -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <nav class="flex min-h-0 flex-1 flex-row gap-4 overflow-x-auto md:flex-col md:gap-1 md:overflow-x-hidden md:overflow-y-auto" aria-label={$t('settingsNav.label')} onkeydown={onKeydown}>
    {#snippet row(item: RailItem)}
      {@const active = selected === key(item)}
      {@const status = item.kind === 'provider' ? item.status : item.dot ? 'in-use' : 'none'}
      <UiListRow
        type="button"
        data-nav-row
        class={uiClass("sidebar-row", {"is-current": active})}

        aria-current={active ? 'page' : undefined}
        onclick={() => onselect(item)}
      >
        {#if item.kind === 'provider'}
          <ProviderIcon provider={item.id} size={16} />
        {:else}
          {@const Icon = item.icon}
          <Icon class="sidebar-row-icon" />
        {/if}
        <span class="sidebar-row-label">{item.label}</span>
        {#if item.kind === 'tab' && item.count}
          <span class="rounded-full bg-primary px-1.5 text-[length:var(--text-xs)] font-semibold tabular-nums text-primary-fg">{item.count}</span>
        {:else if status === 'in-use'}
          <span class="sidebar-dot is-active" title={$t('settingsNav.inUse')}></span>
        {:else if status === 'ready'}
          <span class="sidebar-dot is-idle" title={$t('settingsNav.connected')}></span>
        {/if}
      </UiListRow>
    {/snippet}

    {#snippet groupRows(items: RailItem[])}
      {#each items as item (key(item))}{@render row(item)}{/each}
    {/snippet}

    {#each visibleGroups as group (group.id)}
      <div class="min-w-max md:min-w-0 md:mt-3 md:first:mt-0">
        <div class="flex items-center justify-between gap-2 pr-2.5">
          <span class="sidebar-section min-w-0 truncate whitespace-nowrap">{group.title}</span>
          {#if group.id === 'providers'}
            <IconButton label={$t('settingsNav.addEndpoint')} size="xs" variant="ghost"
              type="button"
              data-nav-row
              class={uiClass("flex size-5 items-center justify-center rounded-md text-muted-foreground transition hover:bg-[var(--surface-hover)] hover:text-foreground")}
              onclick={onaddendpoint}
              title={$t('settingsNav.addEndpoint')}

            >
              <Plus class="size-3.5" />
            </IconButton>
          {/if}
        </div>
        {#if group.subgroups}
          <div class="flex flex-col gap-0.5">
            {#each group.subgroups as sub (sub.title)}
              {#snippet subRows()}
                {#if sub.title}<p class="sidebar-subsection">{sub.title}</p>{/if}
                {@render groupRows(sub.items)}
              {/snippet}
              {#if sub.items.length}{@render subRows()}{/if}
            {/each}
          </div>
        {:else}
          <div class="flex flex-col gap-0.5">{@render groupRows(group.items)}</div>
        {/if}
      </div>
    {/each}
  </nav>
</aside>


