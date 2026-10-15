<svelte:options runes={true} />

<!-- What setup left in place, and the way in. Anything skipped is one click
     away in Settings, which is where each line points. -->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Check, Minus } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { speechEngine } from '$lib/stores/speech-engine.svelte';
  import { providerLabel } from '$lib/utils/providers';
  import SetupFooter from './SetupFooter.svelte';

  let { onback, onfinish }: { onback: () => void; onfinish: () => void } = $props();

  const modelLine = $derived.by(() => {
    if (appStore.backendMode === 'local') {
      const name = appStore.config.llm?.local?.model;
      return name ? $t('onboarding.done.local', { values: { model: String(name) } }) : null;
    }
    const id = appStore.activeProviderName;
    const model = id ? appStore.config.llm?.providers?.[id]?.model : '';
    return id && model ? $t('onboarding.done.cloud', { values: { provider: providerLabel(id), model } }) : null;
  });

  const voiceLine = $derived(speechEngine.active ? $t('onboarding.done.voice', { values: { model: speechEngine.active.title } }) : null);

  const lines = $derived([
    { label: $t('onboarding.stage.models'), value: modelLine, missing: $t('onboarding.done.noModel') },
    { label: $t('onboarding.voice.readAloud'), value: voiceLine, missing: $t('onboarding.done.noVoice') }
  ]);
</script>

<div class="setup-step">
  <div>
    <h3 class="setup-title">{$t('onboarding.done.title')}</h3>
    <p class="setup-lead">{$t('onboarding.done.lead')}</p>
  </div>
  <div class="setup-card">
    {#each lines as line (line.label)}
      <div class="setup-row">
        <span class="done-mark" class:is-set={!!line.value}>
          {#if line.value}<Check class="size-3" />{:else}<Minus class="size-3" />{/if}
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[length:var(--text-sm)] font-medium text-foreground">{line.label}</p>
          <p class="text-xs text-muted-foreground">{line.value ?? line.missing}</p>
        </div>
      </div>
    {/each}
  </div>
</div>

<SetupFooter {onback} primaryLabel={$t('onboarding.start')} onprimary={onfinish} />

<style>
  .done-mark {
    display: flex;
    width: 1.25rem;
    height: 1.25rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--float-border);
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
  }

  .done-mark.is-set {
    border-color: var(--foreground);
    background: var(--foreground);
    color: var(--background);
  }
</style>
