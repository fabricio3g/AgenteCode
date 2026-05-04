<svelte:options runes={true} />

<script lang="ts">
  import { HeadphoneOff, Mic, AlertCircle, Loader2 } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';

  interface Props {
    isListening: boolean;
    interimTranscript: string;
    exitVoiceMode: () => void;
    audioLevels: number[];
  }

  let { isListening, interimTranscript, exitVoiceMode, audioLevels }: Props = $props();

  const state = $derived.by((): 'idle' | 'recording' | 'transcribing' | 'error' => {
    if (interimTranscript.includes('Transcribing')) return 'transcribing';
    if (interimTranscript.includes('Recording')) return 'recording';
    if (interimTranscript.includes('Error') || interimTranscript.includes('Failed')) return 'error';
    if (isListening) return 'recording';
    return 'idle';
  });

  const avgLevel = $derived.by(() => {
    if (!audioLevels?.length) return 0;
    return audioLevels.reduce((acc, v) => acc + Math.max(0, Math.min(1, v)), 0) / audioLevels.length;
  });

  const title = $derived.by(() => {
    if (state === 'transcribing') return 'Transcribing...';
    if (state === 'recording') return 'Listening';
    if (state === 'error') return 'Error';
    if (appStore.currentChatGenerating) return 'Thinking...';
    if (ttsStore.playing) return 'Speaking...';
    return 'Voice';
  });

  const caption = $derived(
    state === 'recording' ? 'Tap to stop' :
    state === 'transcribing' ? 'Processing...' :
    interimTranscript || ''
  );
</script>

{#if appStore.voiceModeActive || isListening || !!interimTranscript}
  <div class="voice-card">
    <!-- Pulse ring orb -->
    <div class="orb-outer">
      <div class="pulse-ring" class:active={state === 'recording'}></div>
      <div class="orb" class:recording={state === 'recording'} class:error={state === 'error'}>
        <!-- Waveform bars when recording -->
        {#if state === 'recording'}
          <div class="waveform">
            {#each Array(5) as _, i}
              {@const lvl = audioLevels[i * 3] ?? 0}
              <div class="wave-bar" style="height: {4 + lvl * 18}px; opacity: {0.4 + lvl * 0.6}"></div>
            {/each}
          </div>
        {:else}
          <!-- Center icon -->
          <div class="icon-wrap">
            {#if state === 'transcribing'}
              <Loader2 class="icon spin" />
            {:else if state === 'error'}
              <AlertCircle class="icon" />
            {:else}
              <Mic class="icon" />
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- Status -->
    <div class="status">
      <span class="status-title">{title}</span>
      {#if caption}
        <span class="status-sub">{caption}</span>
      {/if}
    </div>

    {#if appStore.voiceModeActive}
      <button class="end-btn" onclick={exitVoiceMode}>
        <HeadphoneOff class="h-3.5 w-3.5" />
        End
      </button>
    {/if}
  </div>
{/if}

<style>
  .voice-card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 16px;
    margin-bottom: 10px;
    border-radius: var(--radius-xl);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-xl);
    animation: appear 0.3s ease-out;
  }

  @keyframes appear {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Outer ring container */
  .orb-outer {
    position: relative;
    width: 64px;
    height: 64px;
    flex-shrink: 0;
  }

  /* Single subtle pulse ring */
  .pulse-ring {
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 2px solid transparent;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .pulse-ring.active {
    border-color: rgba(0, 0, 0, 0.08);
    animation: pulseOut 2s ease-out infinite;
  }

  @keyframes pulseOut {
    0% { transform: scale(0.95); opacity: 0.5; }
    100% { transform: scale(1.15); opacity: 0; }
  }

  /* Main orb */
  .orb {
    position: relative;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    overflow: hidden;
    background: linear-gradient(135deg, #fdfbf7 0%, #f5f0e8 100%);
    box-shadow:
      inset 0 0 20px rgba(255, 255, 255, 0.5),
      0 4px 20px rgba(0, 0, 0, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .orb.recording {
    box-shadow:
      inset 0 0 20px rgba(255, 255, 255, 0.5),
      0 0 0 3px rgba(0, 0, 0, 0.03),
      0 6px 24px rgba(0, 0, 0, 0.12);
  }

  .orb.error {
    background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
    box-shadow:
      inset 0 0 20px rgba(255, 255, 255, 0.5),
      0 4px 20px rgba(220, 38, 38, 0.2);
  }

  /* Waveform bars — thinner, tighter */
  .waveform {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 2px;
    height: 20px;
  }

  .wave-bar {
    width: 2px;
    background: rgba(0, 0, 0, 0.8);
    border-radius: 1px;
    transition: height 0.08s ease-out, opacity 0.08s ease-out;
    min-height: 3px;
  }

  /* Icon wrapper */
  .icon-wrap {
    position: relative;
    z-index: 10;
    color: rgba(0, 0, 0, 0.8);
  }

  .icon {
    width: 22px;
    height: 22px;
  }

  .spin {
    animation: spinAnim 1s linear infinite;
  }

  @keyframes spinAnim {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* Status text */
  .status {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .status-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text);
  }

  .status-sub {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  /* End button — rounded-full, h-9 w-9 */
  .end-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 2.25rem;
    padding: 0 0.75rem;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .end-btn:hover {
    background: var(--surface-hover);
    border-color: var(--border-hover);
    color: var(--text);
  }

  /* Dark mode */
  :global(.dark) .voice-card {
    background: var(--surface);
    border-color: var(--border);
  }

  :global(.dark) .orb {
    background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%);
    box-shadow:
      inset 0 0 20px rgba(255, 255, 255, 0.05),
      0 4px 20px rgba(0, 0, 0, 0.4);
  }

  :global(.dark) .orb.recording {
    box-shadow:
      inset 0 0 20px rgba(255, 255, 255, 0.05),
      0 0 0 3px rgba(255, 255, 255, 0.04),
      0 6px 24px rgba(0, 0, 0, 0.5);
  }

  :global(.dark) .wave-bar {
    background: rgba(255, 255, 255, 0.85);
  }

  :global(.dark) .icon-wrap {
    color: rgba(255, 255, 255, 0.85);
  }

  :global(.dark) .pulse-ring.active {
    border-color: rgba(255, 255, 255, 0.06);
  }

  :global(.dark) .end-btn {
    color: rgba(255, 255, 255, 0.6);
    border-color: var(--border);
  }

  :global(.dark) .end-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    color: white;
  }
</style>
