<svelte:options runes={true} />

<!--
  Bots: the roster on the left, the open bot's chat in the middle, its
  routines on the right. Bots live in the Agente runtime, so they keep
  working (routines, handoffs) while this screen is closed.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AlertCircle } from 'lucide-svelte';
  import BotRoster from './BotRoster.svelte';
  import BotChat from './BotChat.svelte';
  import BotRoutines from './BotRoutines.svelte';
  import BotEditor from './BotEditor.svelte';
  import { botsStore } from './bots.svelte';

  let editor = $state<'new' | 'edit' | null>(null);
  // Routines sit beside the chat on wide windows; narrower ones open them on demand.
  let routinesOpen = $state(typeof window !== 'undefined' && window.innerWidth >= 1280);

  onMount(() => {
    void botsStore.load();
  });
</script>

<section class="bots-screen flex min-h-0 min-w-0 flex-1 bg-background" aria-label={$t('bots.title')}>
  <BotRoster oncreate={() => (editor = 'new')} />

  {#if botsStore.error}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <AlertCircle class="size-5 text-muted-foreground" />
      <p class="text-[13px] font-medium text-foreground">{$t('bots.unavailable')}</p>
      <p class="max-w-md text-[12px] text-muted-foreground">{botsStore.error}</p>
    </div>
  {:else if botsStore.current}
    <BotChat bot={botsStore.current} onedit={() => (editor = 'edit')} {routinesOpen} ontoggleroutines={() => (routinesOpen = !routinesOpen)} />
    {#if routinesOpen}<div class="routines-slot"><BotRoutines bot={botsStore.current} onclose={() => (routinesOpen = false)} /></div>{/if}
  {:else}
    <div class="flex-1"></div>
  {/if}
</section>

{#if editor === 'new'}
  <BotEditor bot={null} onclose={() => (editor = null)} />
{:else if editor === 'edit' && botsStore.detail}
  <BotEditor bot={botsStore.detail} onclose={() => (editor = null)} />
{/if}

<style>
  .bots-screen {
    position: relative;
    container-type: inline-size;
  }
  .routines-slot {
    display: flex;
    min-height: 0;
  }
  /* Roster + a readable chat + routines don't fit: routines slide over the chat. */
  @container (max-width: 940px) {
    .routines-slot {
      position: absolute;
      inset: 0 0 0 auto;
      z-index: 10;
      background: var(--background);
      box-shadow: -12px 0 32px rgb(0 0 0 / 0.18);
    }
  }
</style>
