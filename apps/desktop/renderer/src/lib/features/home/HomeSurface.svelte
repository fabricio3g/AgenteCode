<svelte:options runes={true} />

<script lang="ts">
  import { locale } from 'svelte-i18n';
  import { motionFly } from '$lib/utils/transitions';
  import Thread from '$lib/features/chat/thread/Thread.svelte';
  import Composer from '$lib/features/chat/Composer.svelte';
  import UpcomingCalendar from './UpcomingCalendar.svelte';
  import ActivityDrawer from '$lib/components/agent/ActivityDrawer.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  const DAILY_GREETINGS_ES = [
    '¿En qué puedo ayudarte hoy?',
    '¿Qué vamos a construir hoy?',
    '¿Por dónde empezamos?',
    '¿Qué tienes en mente hoy?',
    '¿Qué resolvemos hoy?',
    '¿Listo para crear algo nuevo?',
    '¿En qué trabajamos ahora?'
  ] as const;

  const DAILY_GREETINGS_EN = [
    'How can I help you today?',
    'What are we building today?',
    'Where should we start?',
    "What's on your mind today?",
    'What should we solve today?',
    'Ready to build something new?',
    'What are we working on?'
  ] as const;

  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const dailyGreeting = $derived.by(() => {
    const lang = ($locale || '').toLowerCase();
    if (lang.startsWith('es')) return DAILY_GREETINGS_ES[dayIndex % DAILY_GREETINGS_ES.length];
    if (lang.startsWith('en') || !lang) return DAILY_GREETINGS_EN[dayIndex % DAILY_GREETINGS_EN.length];
    return copy.emptyState.greeting;
  });

  const threadIsEmpty = $derived(!(appStore.currentChat?.messages?.length));

</script>

<div class="chat-panel relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  <!-- Empty conversation: the prompt and the composer sit together in
       the middle of the panel. The composer drops to the bottom as soon
       as there is a message to read above it. -->
  <div
    class="chat-content-layer relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    class:empty={threadIsEmpty}
  >
    {#if threadIsEmpty}
      <!-- Centered daily headline directly above the composer. -->
      <h1 class="empty-greeting composer-column px-3 md:px-6">{dailyGreeting}</h1>
      <UpcomingCalendar />
    {/if}
    <Thread />
    <Composer />
  </div>

  <!-- Floats over the conversation: opening it must not reflow the
       thread or the composer. -->
  {#if appStore.activityDrawerOpen}
    <div class="activity-drawer-slot" transition:motionFly={{ x: 24, duration: 160 }}>
      <ActivityDrawer />
    </div>
  {/if}
</div>

<style>
  .chat-content-layer.empty {
    justify-content: safe center;
    overflow-y: auto;
    padding-block: 1rem;
  }

  /* Centered daily headline directly above the composer: generous scale,
     tight tracking, balanced wrapping. */
  .empty-greeting {
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    margin-block: 0 1.25rem;
    color: var(--foreground);
    font-size: clamp(1.625rem, 2.8vw, 2.125rem);
    font-weight: 500;
    letter-spacing: -0.028em;
    line-height: 1.2;
    text-align: center;
    text-wrap: balance;
  }

  @media (max-width: 640px) {
    .empty-greeting {
      margin-bottom: 0.875rem;
    }
  }

  .chat-panel {
    background: var(--background);
    /* No seam between the rail and the conversation — they are one surface. */
    border: 0;
    border-radius: var(--radius-2xl) 0 0 0;
  }

  /*
   * A floating panel, not a layout column. It is absolutely positioned inside
   * the chat panel and inset from the edges, so showing it never changes the
   * width of the thread or the composer — it only ever animates its own
   * transform and opacity.
   */
  .activity-drawer-slot {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    bottom: 0.75rem;
    z-index: 30;
    display: flex;
    overflow: hidden;
    border: 1px solid var(--float-border);
    border-radius: var(--radius-2xl);
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
    transform-origin: right center;
    will-change: transform, opacity;
  }
</style>
