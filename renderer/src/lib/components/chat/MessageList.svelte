<svelte:options runes={true} />

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import ChatMessage from '$lib/components/chat/ChatMessage.svelte';

  interface Props {
    composerInset?: number;
  }

  let { composerInset = 320 }: Props = $props();

  let container = $state<HTMLDivElement | undefined>(undefined);
  let showTopFade = $state(false);
  const messages = $derived(appStore.currentChat?.messages || []);
  const hasMessages = $derived(messages.length > 0);
  const contentBottomInset = $derived(Math.max(composerInset + 24, 320));

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    container?.scrollTo({ top: container.scrollHeight, behavior });
  }

  function handleScroll() {
    if (!container) return;
    const scrollTop = container.scrollTop;
    showTopFade = scrollTop > 40;
  }

  $effect(() => {
    messages.length;
    tick().then(() => scrollToBottom(messages.at(-1)?.status === 'streaming' ? 'auto' : 'smooth'));
  });

  onMount(() => {});
</script>

<div class="relative flex-1 min-h-0 overflow-hidden" style="background:var(--chat-bg)">
  {#if !hasMessages}
    <div class="h-full"></div>
  {:else}
    <div class="message-list-wrapper relative h-full">
      <div
        bind:this={container}
        class="h-full overflow-y-auto px-4 pt-6 md:px-8"
        style={`padding-bottom:${contentBottomInset}px;`}
        onscroll={handleScroll}
      >
        <div class="mx-auto flex max-w-[55rem] flex-col gap-7">
          {#each messages as message (message.id)}
            <ChatMessage {message} />
          {/each}
        </div>
      </div>
      <div class="message-list-fade message-list-fade-top pointer-events-none" class:visible={showTopFade}></div>
      <div class="message-list-fade message-list-fade-bottom pointer-events-none"></div>
    </div>
  {/if}
</div>

<style>
  .message-list-wrapper {
    position: relative;
  }

  .message-list-fade {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 5;
    pointer-events: none;
  }

  .message-list-fade-top {
    top: 0;
    height: 80px;
    opacity: 0;
    transition: opacity 0.25s ease;
    background: linear-gradient(
      to bottom,
      var(--background) 0%,
      color-mix(in srgb, var(--background) 70%, transparent) 40%,
      color-mix(in srgb, var(--background) 20%, transparent) 70%,
      transparent 100%
    );
  }

  .message-list-fade-top.visible {
    opacity: 1;
  }

  .message-list-fade-bottom {
    bottom: 0;
    height: 120px;
    opacity: 1;
    background: linear-gradient(
      to top,
      var(--chat-bg, var(--background)) 0%,
      color-mix(in srgb, var(--chat-bg, var(--background)) 85%, transparent) 25%,
      color-mix(in srgb, var(--chat-bg, var(--background)) 50%, transparent) 50%,
      color-mix(in srgb, var(--chat-bg, var(--background)) 20%, transparent) 75%,
      transparent 100%
    );
  }
</style>
