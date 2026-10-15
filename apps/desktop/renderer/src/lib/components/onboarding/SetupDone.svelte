<svelte:options runes={true} />

<!-- What setup left in place, and the way in: where to start, picked from
     the four spaces (keys 1–4), and one button that opens it. Anything
     skipped is one click away in Settings. -->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Check, Code2, Drama, House, Minus, PenTool } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import { copy } from '$lib/copy';
  import { cn } from '$lib/utils/cn';
  import type { ChatContextMode } from '$lib/types/chat';
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

  const spaces = $derived([
    { id: 'home' as const, icon: House, label: copy.spaces.home, desc: $t('onboarding.startIn.home') },
    { id: 'code' as const, icon: Code2, label: copy.spaces.code, desc: $t('onboarding.startIn.code') },
    { id: 'design' as const, icon: PenTool, label: copy.spaces.design, desc: $t('onboarding.startIn.design') },
    { id: 'roleplay' as const, icon: Drama, label: copy.spaces.roleplay, desc: $t('onboarding.startIn.roleplay') }
  ]);
  let space = $state<ChatContextMode>('home');
  const spaceLabel = $derived(spaces.find((item) => item.id === space)?.label ?? '');

  function open() {
    appStore.setActiveSpace(space);
    onfinish();
  }

  function onkeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (event.ctrlKey || event.metaKey || event.altKey || target?.closest('input, textarea, [contenteditable]')) return;
    const pick = spaces[Number(event.key) - 1];
    if (pick) {
      event.preventDefault();
      space = pick.id;
    }
  }

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

  <div class="flex flex-col gap-1.5">
    <p class="setup-section">{$t('onboarding.startIn.title')}</p>
    <div class="setup-card" role="radiogroup" aria-label={$t('onboarding.startIn.title')}>
      {#each spaces as item, i (item.id)}
        {@const Icon = item.icon}
        <Button variant="plain" type="button" class={cn('setup-row setup-pick', { 'is-current': space === item.id })} role="radio" aria-checked={space === item.id} onclick={() => (space = item.id)} ondblclick={open}>
          <span class="pick-mark" aria-hidden="true">{space === item.id ? '›' : ''}</span>
          <Icon class="size-4 text-muted-foreground" />
          <span class="pick-label">{item.label}<small>{item.desc}</small></span>
          <kbd class="pick-key">{i + 1}</kbd>
        </Button>
      {/each}
    </div>
  </div>
</div>

<svelte:window {onkeydown} />

<SetupFooter {onback} primaryLabel={$t('onboarding.startIn.open', { values: { space: spaceLabel } })} onprimary={open} hint={$t('onboarding.keys.pick')} />

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
