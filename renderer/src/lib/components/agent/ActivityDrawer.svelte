<svelte:options runes={true} />

<script lang="ts">
  import { motionFly } from '$lib/utils/transitions';
  import { cubicOut } from 'svelte/easing';
  import { ExternalLink, Loader2, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { ChatMessage } from '$lib/types/chat';
  import { domainLabel, faviconUrl } from '$lib/ui/message-utils';
  import ToolCallRow from './ToolCallRow.svelte';

  const message = $derived(appStore.activityMessage);
  const steps = $derived(message?.agentSteps || []);
  const reasoning = $derived(message?.reasoning || '');
  const sources = $derived(message?.sources || []);
  const displaySources = $derived.by(() => dedupeSources(sources));
  const sourceCount = $derived(displaySources.length);
  const activeTab = $derived(appStore.activityDrawerTab);
  const isStreaming = $derived(message?.status === 'streaming');

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

  function hideOnError(event: Event) {
    (event.currentTarget as HTMLElement).style.display = 'none';
  }

  function sourceExcerpt(source: Source) {
    return String(source.snippet || source.full_content || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sourceBadges(source: Source) {
    const inferred =
      String(source.url || '').match(/\.(pdf|docx?|pptx?|xlsx?|rtf|epub|odt|ods|odp)(?:$|[?#])/i)?.[1] ||
      '';
    const fileType = String(source.metadata?.file_type || inferred || '')
      .trim()
      .toUpperCase();
    const provider = String(source.provider || '').trim();
    return [fileType, provider].filter(Boolean).slice(0, 2);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<aside
  class="activity-drawer flex h-full w-80 min-w-[18rem] max-w-[24rem] shrink-0 flex-col overflow-hidden bg-background outline-none"
  aria-label="Activity"
  tabindex="-1"
  transition:motionFly={{ x: 22, duration: 260, opacity: 0.55, easing: cubicOut }}
  onpointerdown={stopBubble}
>
  <header class="flex shrink-0 items-center gap-2 px-3 py-3">
    <div class="aui-segmented min-w-0 flex-1">
      <button
        type="button"
        class="aui-segmented-item flex-1 py-1.5 {activeTab === 'activity' ? 'is-active' : ''}"
        onclick={() => (appStore.activityDrawerTab = 'activity')}
      >
        Activity
      </button>
      <button
        type="button"
        class="aui-segmented-item flex-1 py-1.5 {activeTab === 'sources' ? 'is-active' : ''}"
        onclick={() => (appStore.activityDrawerTab = 'sources')}
        disabled={!sourceCount}
      >
        {sourceCount} Source{sourceCount === 1 ? '' : 's'}
      </button>
    </div>
    <button type="button" class="aui-icon-button size-8 shrink-0" onclick={close} aria-label="Close activity" title="Close">
      <X class="size-3.5" />
    </button>
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
              class="source-row group grid grid-cols-[1.25rem_1rem_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-2 text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground"
            >
              <span class="pt-0.5 text-center text-[0.68rem] font-medium tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <img
                class="mt-0.5 size-4 rounded-sm"
                src={faviconUrl(source.url)}
                alt=""
                loading="lazy"
                onerror={hideOnError}
              />
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate text-[0.8rem] font-medium text-foreground">
                  {source.title || source.url}
                </span>
                <span class="truncate text-[0.7rem] text-muted-foreground">{domainLabel(source.url)}</span>
                {#if sourceBadges(source).length}
                  <span class="mt-0.5 flex flex-wrap gap-1">
                    {#each sourceBadges(source) as badge}
                      <span class="rounded-md bg-muted px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide text-muted-foreground">
                        {badge}
                      </span>
                    {/each}
                  </span>
                {/if}
                {#if sourceExcerpt(source)}
                  <span class="source-snippet mt-0.5 text-[0.72rem] leading-snug text-muted-foreground">
                    {sourceExcerpt(source)}
                  </span>
                {/if}
              </span>
              <ExternalLink class="mt-0.5 size-3.5 shrink-0 opacity-50 group-hover:opacity-80" />
            </a>
          {/each}
        </div>
      {:else}
        <div class="px-1 py-8 text-center text-sm text-muted-foreground">
          <p class="m-0">No sources were recorded for this message.</p>
        </div>
      {/if}
    {:else}
      {#if isStreaming && !steps.length}
        <div class="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
          <Loader2 class="size-3 animate-spin" style="animation-duration: 0.6s" />
          <span class="aui-shimmer-host">
            <span>Working…</span>
            <span class="aui-shimmer" aria-hidden="true">Working…</span>
          </span>
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
          <p class="m-0">No activity steps have been recorded yet.</p>
        </div>
      {/if}

      {#if reasoning}
        <section class="mt-3 rounded-md bg-muted/40 px-3 py-2.5">
          <p class="mb-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">
            Reasoning
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
    transform-origin: right center;
    will-change: transform, opacity;
  }

  .source-snippet {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
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

  @media (prefers-reduced-motion: reduce) {
    .activity-drawer {
      will-change: auto;
    }
  }
</style>
