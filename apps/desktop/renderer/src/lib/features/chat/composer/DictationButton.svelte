<svelte:options runes={true} />

<script lang="ts">
  import { Mic, Phone, Settings2 } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import ComposerGlyph from '$lib/features/shared/composer/ComposerGlyph.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy, say } from '$lib/copy';
  import type { Dictation } from './use-dictation.svelte';

  let { dictation, oncall }: { dictation: Dictation; oncall?: () => void } = $props();
  const micTitle = $derived(!dictation.supported ? $t('chat.dictation.unavailable') : dictation.phase === 'transcribing' ? say.inProgress(copy.status.transcribing) : dictation.listening ? say.inProgress(copy.status.listening) : $t('chat.dictation.start'));
</script>

<div class="mic-control">
  <IconButton label={dictation.listening ? $t('chat.dictation.stop') : copy.composer.dictate} size="sm"
    class={`mic-btn composer-icon-control${dictation.uiActive ? ' is-listening' : ''}${!dictation.supported ? ' unavailable' : ''}`}
    onclick={() => { if (oncall && appStore.voiceModeActive) oncall(); else dictation.toggle(false); }} disabled={!dictation.supported}>
    {#if dictation.listening}
      <span class="mic-lines">{#each [0, 1, 2, 3, 4] as index (index)}<span class="mic-line" style={`animation-delay: ${index * 0.12}s;`}></span>{/each}</span>
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
  .mic-preview { position:absolute; right:-0.25rem; bottom:calc(100% + 0.25rem); z-index:var(--z-float); padding:var(--float-pad); display:none; align-items:center; gap:0.2rem; background:var(--float-bg); color:var(--popover-foreground); border:1px solid var(--float-border); border-radius:var(--float-radius); box-shadow:var(--float-shadow); }
  .mic-preview::after { content:''; position:absolute; inset-inline:0; top:100%; height:0.5rem; }
  .mic-control:hover .mic-preview, .mic-control:focus-within .mic-preview { display:flex; }
  .mic-preview :global(.selected) { background:var(--muted); color:var(--foreground); }
  :global(.mic-btn) { color:var(--text-secondary); }
  :global(.mic-btn.unavailable) { opacity:0.4; cursor:not-allowed; }
  :global(.mic-btn.is-listening) { background:var(--primary); color:var(--primary-foreground); }
  .mic-lines { display:flex; height:14px; align-items:center; justify-content:center; gap:2px; }
  .mic-line { width:2px; height:6px; border-radius:1px; background:currentColor; animation:micLineBounce 0.8s ease-in-out infinite; }
  @keyframes micLineBounce { 0%, 100% { height:5px; opacity:0.5; } 50% { height:14px; opacity:1; } }
  @media (prefers-reduced-motion: reduce) { .mic-line { animation:none !important; } }
</style>
