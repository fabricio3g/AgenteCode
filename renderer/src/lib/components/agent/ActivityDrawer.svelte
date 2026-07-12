<svelte:options runes={true} />

<script lang="ts">
  import { motionFly } from '$lib/utils/transitions';
  import { cubicOut } from 'svelte/easing';
  import { ExternalLink, Loader2, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import type { AgentStep, ChatMessage } from '$lib/types/chat';
  import { domainLabel, faviconUrl } from '$lib/ui/message-utils';

  const message = $derived(appStore.activityMessage);
  const steps = $derived(message?.agentSteps || []);
  const reasoning = $derived(message?.reasoning || '');
  const sources = $derived(message?.sources || []);
  const displaySources = $derived.by(() => dedupeSources(sources));
  const sourceCount = $derived(displaySources.length);
  const activeTab = $derived(appStore.activityDrawerTab);

  type Source = NonNullable<ChatMessage['sources']>[number];

  function sourceKey(source: Source) {
    return String(source.url || source.title || '').trim().toLowerCase().replace(/#.*$/, '');
  }

  function richerSource(left: Source, right: Source): Source {
    return {
      ...left,
      ...right,
      title: right.title || left.title || right.url || left.url,
      url: right.url || left.url,
      snippet: (right.snippet || '').length > (left.snippet || '').length ? right.snippet : left.snippet,
      full_content: (right.full_content || '').length > (left.full_content || '').length ? right.full_content : left.full_content,
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

  function shortDetail(detail?: string) {
    const clean = String(detail || '').replace(/\s+/g, ' ').trim();
    return clean.length > 180 ? `${clean.slice(0, 180)}...` : clean;
  }

  function rowText(step: AgentStep) {
    const detail = shortDetail(step.detail);
    return detail ? `${step.label}: ${detail}` : step.label;
  }

  function hideOnError(event: Event) {
    (event.currentTarget as HTMLElement).style.display = 'none';
  }

  function sourceExcerpt(source: Source) {
    return String(source.snippet || source.full_content || '').replace(/\s+/g, ' ').trim();
  }

  function sourceBadges(source: Source) {
    const inferred = String(source.url || '').match(/\.(pdf|docx?|pptx?|xlsx?|rtf|epub|odt|ods|odp)(?:$|[?#])/i)?.[1] || '';
    const fileType = String(source.metadata?.file_type || inferred || '').trim().toUpperCase();
    const provider = String(source.provider || '').trim();
    return [fileType, provider].filter(Boolean).slice(0, 2);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<aside
  class="activity-drawer"
  aria-label="Activity"
  tabindex="-1"
  transition:motionFly={{ x: 22, duration: 260, opacity: 0.55, easing: cubicOut }}
  onpointerdown={stopBubble}
>
  <header class="activity-header">
    <div class="header-pills">
      <button type="button" class="header-pill" class:active={activeTab === 'activity'} onclick={() => (appStore.activityDrawerTab = 'activity')}>Activity</button>
      <button type="button" class="header-pill" class:active={activeTab === 'sources'} onclick={() => (appStore.activityDrawerTab = 'sources')} disabled={!sourceCount}>
        {sourceCount} Source{sourceCount === 1 ? '' : 's'}
      </button>
    </div>
    <button type="button" class="activity-close" onclick={close} aria-label="Close activity" title="Close">
      <X class="h-3.5 w-3.5" />
    </button>
  </header>

  <div class="activity-body">
    {#if activeTab === 'sources'}
      {#if displaySources.length}
        <div class="source-list">
          {#each displaySources as source, index (source.url || source.title || index)}
            <a href={source.url} target="_blank" rel="noopener noreferrer" class="source-item">
              <span class="source-index">{index + 1}</span>
              <img class="source-favicon" src={faviconUrl(source.url)} alt="" loading="lazy" onerror={hideOnError} />
              <span class="source-text">
                <span class="source-title">{source.title || source.url}</span>
                <span class="source-domain">{domainLabel(source.url)}</span>
                {#if sourceBadges(source).length}
                  <span class="source-meta">
                    {#each sourceBadges(source) as badge}
                      <span class="source-chip">{badge}</span>
                    {/each}
                  </span>
                {/if}
                {#if sourceExcerpt(source)}
                  <span class="source-snippet">{sourceExcerpt(source)}</span>
                {/if}
              </span>
              <ExternalLink class="h-3.5 w-3.5 shrink-0" />
            </a>
          {/each}
        </div>
      {:else}
        <div class="empty-state"><p>No sources were recorded for this message.</p></div>
      {/if}
    {:else if steps.length}
      <div class="timeline">
        {#each steps as step (step.id)}
          <article class="timeline-step" class:running={step.status === 'running'} class:error={step.status === 'error'} class:done={step.status === 'done'}>
            <span class="step-dot" aria-hidden="true">
              {#if step.status === 'running'}<Loader2 class="h-3 w-3 animate-spin" />{/if}
            </span>
            <div class="step-content">
              <p>{rowText(step)}</p>
              {#if step.output}
                <details class="timeline-output">
                  <summary>Result</summary>
                  <pre>{step.output}</pre>
                </details>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {:else}
      <div class="empty-state">
        <p>No activity steps have been recorded yet.</p>
      </div>
    {/if}

    {#if activeTab === 'activity' && reasoning}
      <section class="reasoning-card">
        <p>{reasoning}</p>
      </section>
    {/if}
  </div>
</aside>

<style>
  .activity-drawer {
    display: flex;
    width: min(21rem, 28vw);
    min-width: 18rem;
    max-width: 24rem;
    height: 100%;
    flex: 0 0 auto;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 22px;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    outline: none;
    transform-origin: right center;
    will-change: transform, opacity;
  }

  .activity-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    padding: 0.65rem 0.7rem 0.45rem;
    position: relative;
  }

  .header-pills {
    display: flex;
    width: min(100%, 15.5rem);
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
  }

  .header-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1 1 0;
    min-width: 0;
    height: 2rem;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
    color: var(--text-muted);
    padding: 0 0.9rem;
    font-size: 0.82rem;
    font-weight: 720;
    line-height: 1;
    text-align: center;
    white-space: nowrap;
    cursor: pointer;
  }

  .header-pill.active {
    background: color-mix(in srgb, var(--primary) 9%, var(--surface-hover));
    color: var(--text);
  }

  .header-pill:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .header-pill:not(:disabled):hover {
    background: color-mix(in srgb, var(--surface-hover) 92%, var(--primary) 8%);
    color: var(--text);
  }

  .activity-close {
    position: absolute;
    right: 0.65rem;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    height: 1.8rem;
    width: 1.8rem;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }

  .activity-close:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .activity-body {
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 0.65rem 0.7rem 0.85rem;
  }

  .timeline {
    display: flex;
    flex-direction: column;
    gap: 0.48rem;
  }

  .timeline-step {
    display: grid;
    grid-template-columns: 0.7rem 1fr;
    gap: 0.5rem;
    align-items: start;
  }

  .step-dot {
    display: inline-flex;
    width: 0.48rem;
    height: 0.48rem;
    margin-top: 0.45rem;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-muted) 45%, transparent);
    color: var(--primary);
  }

  .timeline-step.running .step-dot {
    width: 0.9rem;
    height: 0.9rem;
    margin-top: 0.2rem;
    background: transparent;
  }

  .timeline-step.error .step-dot {
    background: var(--error);
  }

  .step-content {
    min-width: 0;
  }

  .step-content p,
  .empty-state p,
  .reasoning-card p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.78rem;
    line-height: 1.48;
    overflow-wrap: anywhere;
  }

  .timeline-step.running .step-content p {
    color: var(--text);
    font-weight: 560;
  }

  .timeline-output {
    margin-top: 0.3rem;
  }

  .timeline-output summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 600;
  }

  .timeline-output pre {
    margin: 0.45rem 0 0;
    max-height: 16rem;
    overflow: auto;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .reasoning-card,
  .empty-state {
    margin-top: 0.8rem;
    border-top: 1px solid var(--border);
    padding-top: 0.65rem;
  }

  .empty-state {
    color: var(--text-muted);
  }

  .source-list {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .source-item {
    display: grid;
    grid-template-columns: 1.35rem 1rem minmax(0, 1fr) auto;
    gap: 0.45rem;
    align-items: start;
    border-radius: 0.65rem;
    color: var(--text-secondary);
    padding: 0.35rem 0.25rem;
    text-decoration: none;
  }

  .source-item:hover {
    background: color-mix(in srgb, var(--surface-hover) 70%, transparent);
    color: var(--text);
  }

  .source-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.68rem;
    font-weight: 650;
  }

  .source-favicon {
    width: 1rem;
    height: 1rem;
    margin-top: 0.08rem;
    border-radius: 0.2rem;
  }

  .source-text {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.08rem;
  }

  .source-title {
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 0.76rem;
    font-weight: 560;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-domain {
    overflow: hidden;
    color: var(--text-muted);
    font-size: 0.68rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-meta {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.08rem;
  }

  .source-chip {
    display: inline-flex;
    max-width: 8rem;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
    border-radius: 999px;
    color: var(--text-muted);
    font-size: 0.58rem;
    font-weight: 700;
    line-height: 1;
    overflow: hidden;
    padding: 0.13rem 0.36rem;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .source-snippet {
    display: -webkit-box;
    margin-top: 0.16rem;
    overflow: hidden;
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.4;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
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
