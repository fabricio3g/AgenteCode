<svelte:options runes={true} />

<!--
  First tap on the mic with nothing installed: pick a dictation model and
  download it, or go set up a cloud service. Sits above the composer; the
  download's progress then shows in the composer's recorder row.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { resolveModelHubSection } from '$lib/utils/model-hub-routing';
  import { formatBytes } from '$lib/utils/format';
  import { Button } from '$lib/components/ui';
  import SpeechModelPicker from './SpeechModelPicker.svelte';
  import { listSpeechModels, type SpeechModel } from './speech-models';
  import type { Dictation } from './use-dictation.svelte';

  let { dictation }: { dictation: Dictation } = $props();

  let models = $state<SpeechModel[]>([]);
  let selected = $state('');
  let panel = $state<HTMLElement>();

  const choice = $derived(models.find((m) => m.quality === selected));

  onMount(() => {
    void listSpeechModels().then((list) => {
      models = list;
      selected = (list.find((m) => m.installed) ?? list.find((m) => m.recommended) ?? list[0])?.quality ?? '';
    }).catch(() => (models = []));
    panel?.focus();
  });

  function useCloud() {
    dictation.closeChoice();
    appStore.modelManagerOpenSection = resolveModelHubSection('voice');
    appStore.modelManagerOpen = true;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dictation.closeChoice();
    }
  }
</script>

<div
  class="popover"
  bind:this={panel}
  role="dialog"
  aria-label={$t('voice.setup.title')}
  tabindex="-1"
  onkeydown={onKeydown}
>
  <div class="head">
    <h3>{$t('voice.setup.title')}</h3>
    <button type="button" class="close" onclick={() => dictation.closeChoice()} aria-label={$t('voice.recorder.cancel')}><X class="size-4" /></button>
  </div>
  <p class="lead">{$t('voice.setup.lead')}</p>

  {#if models.length}
    <SpeechModelPicker {models} bind:selected mode="select" />
  {/if}

  <div class="foot">
    <button type="button" class="link" onclick={useCloud}>{$t('voice.setup.cloud')}</button>
    <Button size="sm" disabled={!choice} onclick={() => choice && void dictation.installAndStart(choice.quality)}>
      {choice?.installed ? $t('voice.setup.start') : $t('voice.setup.download', { values: { size: formatBytes(choice?.bytes ?? 0) } })}
    </Button>
  </div>
</div>

<style>
  .popover {
    position: absolute;
    right: 0.35rem;
    bottom: calc(100% + 0.5rem);
    z-index: 40;
    display: flex;
    width: min(22rem, calc(100vw - 2rem));
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.95rem;
    border: 1px solid var(--border-subtle);
    border-radius: 1rem;
    background: var(--popover, var(--background));
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 12px 32px -8px rgb(0 0 0 / 0.18);
    outline: none;
    pointer-events: auto;
    animation: pop-in var(--motion-fast) var(--motion-ease);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h3 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .close {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--muted-foreground);
  }

  .close:hover {
    background: var(--muted);
    color: var(--foreground);
  }

  .lead {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--muted-foreground);
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.15rem;
  }

  .link {
    border: 0;
    background: none;
    padding: 0;
    font-size: 0.78rem;
    color: var(--muted-foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .link:hover {
    color: var(--foreground);
  }

  @keyframes pop-in {
    from { opacity: 0; transform: translateY(4px) scale(0.99); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .popover { animation: none; }
  }
</style>
