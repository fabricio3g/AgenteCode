<svelte:options runes={true} />

<script lang="ts">
  import { Mic, Phone, Settings2 } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import ComposerGlyph from '$lib/features/shared/composer/ComposerGlyph.svelte';
  import MicBars from '$lib/features/shared/composer/MicBars.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy, say } from '$lib/copy';
  import type { Dictation } from './use-dictation.svelte';

  let { dictation, oncall, hidden = false }: { dictation: Dictation; oncall?: () => void; hidden?: boolean } = $props();
  const micTitle = $derived(!dictation.supported ? $t('chat.dictation.unavailable') : dictation.phase === 'transcribing' ? say.inProgress(copy.status.transcribing) : dictation.listening ? say.inProgress(copy.status.listening) : $t('chat.dictation.start'));
</script>

<div class="mic-control" class:is-hidden={hidden}>
  <IconButton label={dictation.listening ? $t('chat.dictation.stop') : copy.composer.dictate} size="sm"
    class={`mic-btn composer-icon-control${dictation.uiActive ? ' is-listening' : ''}${!dictation.supported ? ' unavailable' : ''}`}
    onclick={() => { if (oncall && appStore.voiceModeActive) oncall(); else dictation.toggle(false); }} disabled={!dictation.supported}>
    {#if dictation.listening}
      <MicBars />
    {:else}<ComposerGlyph name="mic" />{/if}
  </IconButton>
  <div class="mic-preview" role="group" aria-label={$t('voice.call.title')}>
    {#if oncall}
      <Tooltip label={appStore.voiceModeActive ? $t('voice.call.end') : $t('voice.call.start')} position="top">
        <IconButton label={appStore.voiceModeActive ? $t('voice.call.end') : $t('voice.call.start')} size="sm" class={appStore.voiceModeActive ? 'selected' : ''} onclick={oncall} disabled={!dictation.supported}><Phone /></IconButton>
      </Tooltip>
    {/if}
    <Tooltip label={micTitle} position="top">
      <IconButton label={copy.composer.dictate} size="sm" class={dictation.listening ? 'selected' : ''} onclick={() => { if (oncall && appStore.voiceModeActive) oncall(); dictation.toggle(false); }} disabled={!dictation.supported}><Mic /></IconButton>
    </Tooltip>
    <Tooltip label={$t('voice.call.settings')} position="top"><IconButton label={$t('voice.call.settings')} size="sm" onclick={() => appStore.openSettings('voice')}><Settings2 /></IconButton></Tooltip>
  </div>
</div>

<style>
  .mic-control { position:relative; flex:none; }
  /* The send slot owns the microphone while the field is empty; a second mic
     in the bar would say the same thing twice. */
  .mic-control.is-hidden { display:none; }
  .mic-preview { position:absolute; right:-0.25rem; bottom:calc(100% + 0.25rem); z-index:var(--z-float); padding:var(--float-pad); display:none; align-items:center; gap:0.2rem; background:var(--float-bg); color:var(--popover-foreground); border:1px solid var(--float-border); border-radius:var(--float-radius); box-shadow:var(--float-shadow); }
  .mic-preview::after { content:''; position:absolute; inset-inline:0; top:100%; height:0.5rem; }
  .mic-control:not(.is-hidden):hover .mic-preview, .mic-control:focus-within .mic-preview { display:flex; }
  .mic-preview :global(.selected) { background:var(--muted); color:var(--foreground); }
  :global(.mic-btn) { color:var(--text-secondary); }
  :global(.mic-btn.unavailable) { opacity:0.4; cursor:not-allowed; }
  :global(.mic-btn.is-listening) { background:var(--primary); color:var(--primary-foreground); }
</style>
