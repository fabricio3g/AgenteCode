<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { ExternalLink, Globe, LoaderCircle } from '$lib/icons';
  import { invoke, isElectron } from '$lib/services/bridge';
  import { browserPanelStore } from '$lib/stores/browser-panel.svelte';
  import { conversationScope } from '$shared/workspace-scope';
  import { faviconUrlFor, hostOf, needsDarkModeInvert } from '$lib/utils/site-favicon';

  interface LinkPreviewData {
    url: string;
    host: string;
    title: string;
    description: string;
    imageDataUrl?: string;
    error?: string;
  }

  const CARD_WIDTH = 312;
  const CARD_HEIGHT = 274;
  const HOVER_DELAY_MS = 200;
  const LEAVE_DELAY_MS = 180;

  let activeUrl = $state<string | null>(null);
  let activeScope = $state<string | null>(null);
  let activeAnchor = $state<HTMLAnchorElement | null>(null);
  let preview = $state<LinkPreviewData | null>(null);
  let loading = $state(false);
  let pos = $state({ left: 0, top: 0 });
  let pendingAnchor: HTMLAnchorElement | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  let requestSeq = 0;

  const clientCache = new Map<string, LinkPreviewData>();

  function clearHoverTimer() {
    pendingAnchor = null;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function clearLeaveTimer() {
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  }

  function closePreview() {
    clearHoverTimer();
    clearLeaveTimer();
    requestSeq += 1;
    activeUrl = null;
    activeScope = null;
    activeAnchor = null;
    preview = null;
    loading = false;
  }

  function scheduleLeave() {
    clearHoverTimer();
    clearLeaveTimer();
    leaveTimer = setTimeout(() => {
      closePreview();
    }, LEAVE_DELAY_MS);
  }

  function eventElement(target: EventTarget | null): Element | null {
    if (target instanceof Element) return target;
    if (target instanceof Node) return target.parentElement;
    return null;
  }

  function findSiteAnchor(target: EventTarget | null): HTMLAnchorElement | null {
    const element = eventElement(target);
    if (!element) return null;
    if (element.closest('.link-preview-card')) return null;
    const anchor = element.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return null;
    if (!anchor.closest('.markdown-body, .research')) return null;
    try {
      const parsed = new URL(anchor.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return anchor;
    } catch {
      return null;
    }
  }

  function scopeForAnchor(anchor: HTMLAnchorElement): string | null {
    const chatId = anchor.closest('[data-conversation-workspace]')?.getAttribute('data-conversation-workspace');
    return chatId ? conversationScope(chatId) : null;
  }

  function positionCard(rect: DOMRect) {
    const margin = 12;
    const gap = 8;
    const maxLeft = Math.max(margin, window.innerWidth - CARD_WIDTH - margin);
    const left = Math.min(Math.max(margin, rect.left), maxLeft);
    const fitsBelow = rect.bottom + gap + CARD_HEIGHT <= window.innerHeight - margin;
    const fitsAbove = rect.top - gap - CARD_HEIGHT >= margin;
    const top = fitsBelow
      ? rect.bottom + gap
      : fitsAbove
        ? rect.top - gap - CARD_HEIGHT
        : Math.max(margin, Math.min(window.innerHeight - CARD_HEIGHT - margin, rect.bottom + gap));
    pos = { left: Math.round(left), top: Math.round(top) };
  }

  async function openPreviewFor(anchor: HTMLAnchorElement) {
    const href = anchor.href;
    const host = hostOf(href);
    activeUrl = href;
    activeAnchor = anchor;
    activeScope = scopeForAnchor(anchor);
    positionCard(anchor.getBoundingClientRect());

    const cached = clientCache.get(href);
    if (cached) {
      preview = cached;
      loading = false;
      return;
    }

    preview = { url: href, host, title: host, description: '' };
    if (!isElectron()) {
      loading = false;
      return;
    }

    const seq = ++requestSeq;
    loading = true;
    try {
      const result = await invoke<LinkPreviewData>('link_preview', { url: href });
      if (seq !== requestSeq || activeUrl !== href) return;
      if (result && !result.error) {
        clientCache.set(href, result);
        preview = result;
      } else {
        preview = {
          url: href,
          host,
          title: result?.title || host,
          description: result?.description || '',
          error: result?.error
        };
      }
    } catch {
      if (seq !== requestSeq || activeUrl !== href) return;
      preview = { url: href, host, title: host, description: '' };
    } finally {
      if (seq === requestSeq && activeUrl === href) loading = false;
    }
  }

  function openInBuiltInBrowser(href: string, scope: string | null) {
    if (scope) {
      void browserPanelStore.forScope(scope).openUrl(href);
    } else {
      void browserPanelStore.openUrl(href);
    }
  }

  function openExternal(href: string) {
    closePreview();
    if (isElectron()) {
      void invoke('open_url_window', { url: href }).catch(() => {});
    } else {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  }

  onMount(() => {
    const onPointerOver = (event: PointerEvent) => {
      const element = eventElement(event.target);
      if (element?.closest('.link-preview-card')) {
        clearLeaveTimer();
        return;
      }
      const anchor = findSiteAnchor(event.target);
      if (!anchor) return;
      clearLeaveTimer();
      if ((activeAnchor === anchor && activeUrl) || (pendingAnchor === anchor && hoverTimer)) return;
      clearHoverTimer();
      pendingAnchor = anchor;
      const targetAnchor = anchor;
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        pendingAnchor = null;
        if (!targetAnchor.isConnected) return;
        void openPreviewFor(targetAnchor);
      }, HOVER_DELAY_MS);
    };

    const onPointerOut = (event: PointerEvent) => {
      const targetEl = eventElement(event.target);
      const leavingCard = !!targetEl?.closest('.link-preview-card');
      const leavingAnchor = findSiteAnchor(event.target);
      if (!leavingCard && !leavingAnchor) return;
      if (!leavingCard && leavingAnchor !== activeAnchor && leavingAnchor !== pendingAnchor) return;
      const relatedEl = eventElement(event.relatedTarget);
      if (relatedEl) {
        if (relatedEl.closest('.link-preview-card')) return;
        const relatedAnchor = findSiteAnchor(relatedEl);
        if (leavingAnchor && relatedAnchor === leavingAnchor) return;
        if (activeAnchor && relatedAnchor === activeAnchor) return;
        if (pendingAnchor && relatedAnchor === pendingAnchor) return;
      }
      scheduleLeave();
    };

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = findSiteAnchor(event.target);
      if (!anchor) return;
      if (!isElectron()) return;
      event.preventDefault();
      event.stopPropagation();
      const href = anchor.href;
      const scope = scopeForAnchor(anchor);
      closePreview();
      openInBuiltInBrowser(href, scope);
    };

    const onScroll = () => {
      if (activeUrl) closePreview();
    };

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && activeUrl) closePreview();
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKeydown);
    };
  });

  onDestroy(() => closePreview());
</script>

{#if activeUrl && preview}
  {@const faviconSrc = faviconUrlFor(preview.url)}
  {@const darkMono = needsDarkModeInvert(preview.host)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="link-preview-card"
    style={`left:${pos.left}px;top:${pos.top}px;width:${CARD_WIDTH}px;`}
    onpointerenter={() => clearLeaveTimer()}
    onpointerleave={() => scheduleLeave()}
  >
    <button
      type="button"
      class="link-preview-main"
      onclick={() => {
        const href = preview!.url;
        const scope = activeScope;
        closePreview();
        openInBuiltInBrowser(href, scope);
      }}
    >
      <div class="link-preview-shot">
        {#if preview.imageDataUrl}
          <img src={preview.imageDataUrl} alt="" />
        {:else if loading}
          <div class="link-preview-placeholder">
            <LoaderCircle class="size-4 animate-spin text-muted-foreground" />
            <span>{$t('browser.preview.loading')}</span>
          </div>
        {:else}
          <div class="link-preview-placeholder">
            <Globe class="size-4 text-muted-foreground" />
            <span>{preview.host}</span>
          </div>
        {/if}
      </div>
      <div class="link-preview-body">
        <div class="link-preview-head">
          {#if faviconSrc}
            <img
              class="link-preview-favicon"
              src={faviconSrc}
              data-favicon-tone={darkMono ? 'dark-mono' : undefined}
              alt=""
              referrerpolicy="no-referrer"
              onerror={(e) => ((e.currentTarget as HTMLImageElement).hidden = true)}
            />
          {/if}
          <span class="link-preview-host">{preview.host}</span>
        </div>
        <p class="link-preview-title">{preview.title || preview.host}</p>
        {#if preview.description}
          <p class="link-preview-desc">{preview.description}</p>
        {/if}
      </div>
    </button>
    <div class="link-preview-foot">
      <span class="link-preview-hint">{$t('browser.preview.openInBrowser')}</span>
      <button
        type="button"
        class="link-preview-ext"
        title={$t('browser.preview.openExternal')}
        aria-label={$t('browser.preview.openExternal')}
        onclick={() => openExternal(preview!.url)}
      >
        <ExternalLink class="size-3.5" />
      </button>
    </div>
  </div>
{/if}

<style>
  .link-preview-card {
    position: fixed;
    z-index: var(--z-tooltip, 800);
    overflow: hidden;
    border-radius: var(--radius-lg);
    background: var(--popover);
    border: 1px solid var(--float-border);
    box-shadow: var(--shadow-lg);
    animation: preview-in var(--motion-fast) var(--motion-ease-out) both;
  }
  .link-preview-main {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .link-preview-shot {
    width: 100%;
    aspect-ratio: 16 / 10;
    overflow: hidden;
    background: color-mix(in srgb, var(--foreground) 4%, var(--popover));
    border-bottom: 1px solid var(--border-subtle);
  }
  .link-preview-shot img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
  }
  .link-preview-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    height: 100%;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  .link-preview-body {
    display: grid;
    gap: 0.25rem;
    padding: 0.625rem 0.75rem 0.5rem;
  }
  .link-preview-head {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }
  .link-preview-favicon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
    object-fit: contain;
    border-radius: 2px;
  }
  .link-preview-host {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  .link-preview-title {
    margin: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 1.35;
    color: var(--foreground);
  }
  .link-preview-desc {
    margin: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    font-size: var(--text-xs);
    line-height: 1.4;
    color: var(--text-secondary);
  }
  .link-preview-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem 0.5rem 0.75rem;
    border-top: 1px solid var(--border-subtle);
  }
  .link-preview-hint {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  .link-preview-ext {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: background var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  .link-preview-ext:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  @keyframes preview-in {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .link-preview-card { animation: none; }
  }
</style>
