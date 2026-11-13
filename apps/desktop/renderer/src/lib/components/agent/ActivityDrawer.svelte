<svelte:options runes={true} />

<script lang="ts">
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import UiButton from '$lib/components/ui/Button.svelte';
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Tooltip } from '$lib/components/ui';
  import { ExternalLink, X } from '$lib/icons';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ChatMessage } from '$lib/types/chat';
  import { domainLabel } from '$lib/ui/message-utils';
  import { copy } from '$lib/copy';
  import { countOf } from '$lib/utils/format';
  import { searchModeChip } from '$lib/utils/tool-ui';
  import ToolCallRow from './ToolCallRow.svelte';

  const message = $derived(appStore.activityMessage);
  const steps = $derived((message?.agentSteps || []).filter((step) => !step.preface));
  const reasoning = $derived(message?.reasoning || '');
  const sources = $derived(message?.sources || []);
  const displaySources = $derived.by(() => dedupeSources(sources));
  const sourceCount = $derived(displaySources.length);
  const activeTab = $derived(appStore.activityDrawerTab);
  const isStreaming = $derived(message?.status === 'streaming');
  const modeLabel = $derived(searchModeChip(message?.searchMode));

  type Source = NonNullable<ChatMessage['sources']>[number];

  function sourceKey(source: Source) {
    return String(source.url || source.title || '')
      .trim()
      .toLowerCase()
      .replace(/#.*$/, '');
  }

  function richerSource(left: Source, right: Source): Source {
    return {
      ...left,
      ...right,
      title: right.title || left.title || right.url || left.url,
      url: right.url || left.url,
      snippet: (right.snippet || '').length > (left.snippet || '').length ? right.snippet : left.snippet,
      full_content:
        (right.full_content || '').length > (left.full_content || '').length
          ? right.full_content
          : left.full_content,
      provider: right.provider || left.provider,
      providers: right.providers || left.providers,
      metadata: { ...(left.metadata || {}), ...(right.metadata || {}) }
    };
  }

  function dedupeSources(list: Source[]) {
    const byKey = new Map<string, Source>();
    for (const source of list || []) {
      const key = sourceKey(source);
      if (!key) continue;
      byKey.set(key, byKey.has(key) ? richerSource(byKey.get(key) as Source, source) : source);
    }
    return Array.from(byKey.values());
  }

  function close(event?: Event) {
    event?.preventDefault();
    appStore.closeActivityDrawer();
  }

  function stopBubble(event: Event) {
    event.stopPropagation();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') close();
  }

  function sourceExcerpt(source: Source) {
    return String(source.snippet || source.full_content || '')
      .replace(/\s+/g, ' ')
      .trim();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Frame, surface and enter/exit animation belong to the floating slot in
     AppShell; this is just the panel's contents. -->
<aside
  class="activity-drawer flex h-full w-80 min-w-[18rem] max-w-[24rem] shrink-0 flex-col overflow-hidden bg-transparent outline-none"
  aria-label={copy.thread.activity}
  tabindex="-1"
  onpointerdown={stopBubble}
>
  <header class="flex shrink-0 flex-col gap-2 px-3 py-3">
    {#if modeLabel}
      <div class="drawer-mode">{modeLabel}</div>
    {/if}
    <div class="flex items-center gap-2">
      <div class="ui-segmented min-w-0 flex-1">
        <UiButton variant="plain"
          type="button"
          class={uiClass(`ui-segmented-item flex-1 py-1.5 ${activeTab === 'activity' ? 'is-active' : ''}`)}
          onclick={() => (appStore.activityDrawerTab = 'activity')}
        >
          {copy.thread.activity}
        </UiButton>
        <UiButton variant="plain"
          type="button"
          class={uiClass(`ui-segmented-item flex-1 py-1.5 ${activeTab === 'sources' ? 'is-active' : ''}`)}
          onclick={() => (appStore.activityDrawerTab = 'sources')}
          disabled={!sourceCount}
        >
          {countOf(sourceCount, 'Source')}
        </UiButton>
      </div>
      <Tooltip label={copy.actions.close} position="bottom"><UiIconButton label={copy.actions.close} size="sm" type="button" class={uiClass(" shrink-0")} onclick={close} >
        <X class="size-3.5" />
      </UiIconButton></Tooltip>
    </div>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
    {#if activeTab === 'sources'}
      {#if displaySources.length}
        <div class="flex flex-col gap-0.5">
          {#each displaySources as source, index (source.url || source.title || index)}
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              class="source-row group grid grid-cols-[1.1rem_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-2 no-underline transition-colors"
            >
              <span class="pt-0.5 text-center text-[0.65rem] font-medium tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate text-[0.8rem] font-medium text-foreground">
                  {source.title || source.url}
                </span>
                <span class="truncate text-[0.7rem] text-muted-foreground">{domainLabel(source.url)}</span>
                {#if sourceExcerpt(source)}
                  <span class="source-snippet mt-0.5 line-clamp-2 text-[0.72rem] leading-snug text-muted-foreground">
                    {sourceExcerpt(source)}
                  </span>
                {/if}
              </span>
              <ExternalLink class="mt-0.5 size-3.5 shrink-0 opacity-40 group-hover:opacity-70" />
            </a>
          {/each}
        </div>
      {:else}
        <div class="px-1 py-8 text-center text-sm text-muted-foreground">
          <p class="m-0">{copy.empty.noSources}</p>
        </div>
      {/if}
    {:else}
      {#if isStreaming && !steps.length}
        <div class="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
          <TileMeter mode="busy" />
          <span>{copy.status.working}</span>
        </div>
      {/if}

      {#if steps.length}
        <div class="flex flex-col gap-0.5">
          {#each steps as step (step.id)}
            <ToolCallRow {step} />
          {/each}
        </div>
      {:else if !isStreaming}
        <div class="px-1 py-8 text-center text-sm text-muted-foreground">
          <p class="m-0">{copy.empty.noActivity}</p>
        </div>
      {/if}

      {#if reasoning}
        <section class="mt-3 rounded-md bg-muted/40 px-3 py-2.5">
          <p class="mb-1 text-[0.65rem] font-medium text-muted-foreground">
            {copy.status.reasoning}
          </p>
          <p class="m-0 whitespace-pre-wrap text-[0.8rem] leading-relaxed text-muted-foreground">
            {reasoning}
          </p>
        </section>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .activity-drawer {
    /* Sized here; positioned and animated by the floating slot. */
    min-height: 0;
  }

  .drawer-mode {
    color: var(--muted-foreground);
    font-size: 0.7rem;
    font-weight: 650;
    letter-spacing: 0.01em;
  }

  .source-row {
    color: var(--muted-foreground);
    border-radius: var(--radius-sm);
  }

  .source-row:hover {
    background: var(--artifact-surface-hover, var(--muted));
    color: var(--foreground);
  }

  .source-snippet {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  @media (max-width: 980px) {
    .activity-drawer {
      width: min(18rem, 36vw);
      min-width: 16rem;
    }
  }

  @media (max-width: 760px) {
    .activity-drawer {
      width: min(16rem, 42vw);
      min-width: 14rem;
    }
  }

</style>
