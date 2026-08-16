<svelte:options runes={true} />

<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowUp, Loader2, ShieldCheck, Square, Zap } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { ChatSession } from '$lib/types/chat';
  import { agenteStore } from './agente.svelte';

  let { chat }: { chat: ChatSession } = $props();

  let text = $state('');
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);

  const run = $derived(agenteStore.runFor(chat.id));
  const running = $derived(!!run?.running);
  const supervised = $derived(chat.codeAgent?.runtimeMode !== 'full');

  function adjustHeight() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
  }

  async function submit() {
    const value = text.trim();
    if (!value || running) return;
    text = '';
    await tick();
    adjustHeight();
    await agenteStore.send(chat.id, value);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  async function toggleMode() {
    await agenteStore.setMode(chat.id, supervised ? 'full' : 'supervised');
  }
</script>

<div class="border-t border-border bg-background px-4 pb-4 pt-3">
  <div class="mx-auto max-w-3xl">
    <div class="flex items-end gap-2 rounded-2xl border border-border bg-muted/40 px-3 py-2 focus-within:border-[var(--ring)]">
      <textarea
        bind:this={inputEl}
        bind:value={text}
        oninput={adjustHeight}
        onkeydown={onKeydown}
        rows="1"
        class="max-h-[200px] min-h-[1.75rem] flex-1 resize-none bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        placeholder={running ? $t('agente.steerPlaceholder') : $t('agente.composerPlaceholder')}
      ></textarea>
      {#if running}
        <button
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition hover:text-foreground"
          onclick={() => void agenteStore.stop(chat.id)}
          aria-label={$t('agente.stop')}
          title={$t('agente.stop')}
        >
          <Square class="size-3.5" />
        </button>
      {:else}
        <button
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition disabled:opacity-40"
          disabled={!text.trim()}
          onclick={() => void submit()}
          aria-label={$t('agente.send')}
        >
          <ArrowUp class="size-4" />
        </button>
      {/if}
    </div>

    <div class="mt-1.5 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition hover:bg-muted hover:text-foreground"
        onclick={() => void toggleMode()}
        title={supervised ? $t('agente.modeSupervisedHint') : $t('agente.modeFullHint')}
      >
        {#if supervised}
          <ShieldCheck class="size-3" />
          {$t('agente.modeSupervised')}
        {:else}
          <Zap class="size-3" />
          {$t('agente.modeFull')}
        {/if}
      </button>
      {#if running}
        <span class="inline-flex items-center gap-1.5">
          <Loader2 class="size-3 animate-spin" />
          {$t('agente.running')}
        </span>
      {:else}
        <span>{$t('agente.composerHint')}</span>
      {/if}
    </div>
  </div>
</div>
