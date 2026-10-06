<svelte:options runes={true} />

<!--
  The Bots tab's main view: the open bot's chat. The roster is in the app
  sidebar and the bot's routines open as a card in the right dock. Bots live
  in the Agente runtime, so they keep working while this tab is closed.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AlertCircle, Bot as BotIcon } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import BotChat from './BotChat.svelte';
  import BotEditor from './BotEditor.svelte';
  import { botsStore } from './bots.svelte';

  onMount(() => {
    void botsStore.load();
  });
</script>

<section data-bots-surface class="flex min-h-0 min-w-0 w-full flex-1 bg-background" aria-label={$t('bots.title')}>
  {#if botsStore.error}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <AlertCircle class="size-5 text-muted-foreground" />
      <p class="text-sm font-medium text-foreground">{$t('bots.unavailable')}</p>
      <p class="max-w-md text-xs text-muted-foreground">{botsStore.error}</p>
    </div>
  {:else if botsStore.current}
    <BotChat
      bot={botsStore.current}
      onedit={() => (botsStore.editor = 'edit')}
      routinesOpen={botsStore.routinesOpen}
      ontoggleroutines={() => (botsStore.routinesOpen = !botsStore.routinesOpen)}
    />
  {:else if botsStore.loaded}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <BotIcon class="size-5 text-muted-foreground" />
      <p class="text-sm font-medium text-foreground">{$t('bots.none')}</p>
      <p class="max-w-sm text-sm text-muted-foreground">{$t('bots.noneHint')}</p>
      <Button size="sm" variant="outline" onclick={() => (botsStore.editor = 'new')}>{$t('bots.new')}</Button>
    </div>
  {/if}
</section>

{#if botsStore.editor === 'new'}
  <BotEditor bot={null} onclose={() => (botsStore.editor = null)} />
{:else if botsStore.editor === 'edit' && botsStore.detail}
  <BotEditor bot={botsStore.detail} onclose={() => (botsStore.editor = null)} />
{/if}
