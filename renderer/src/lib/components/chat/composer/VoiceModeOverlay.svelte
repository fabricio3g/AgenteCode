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
    if (appStore.loading) return 'Thinking...';
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
    <!-- Liquid Gradient Orb -->
    <div class="orb-outer">
      {#if state === 'recording'}
        <div class="pulse-ring"></div>
        <div class="pulse-ring ring-2"></div>
      {/if}

      <div class="orb" class:recording={state === 'recording'} class:error={state === 'error'}>
        <!-- Liquid gradient blobs inside orb -->
        <div class="liquid-container">
          <div class="blob blob-1" style="transform: scale({0.7 + avgLevel * 0.3})"></div>
          <div class="blob blob-2" style="transform: scale({0.6 + avgLevel * 0.4})"></div>
          <div class="blob blob-3" style="transform: scale({0.8 + avgLevel * 0.2})"></div>
          <div class="blob blob-4"></div>
        </div>

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
    gap: 16px;
    padding: 16px 20px;
    margin-bottom: 12px;
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
    width: 72px;
    height: 72px;
    flex-shrink: 0;
  }

  /* Pulse rings for recording */
  .pulse-ring {
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 2px solid rgba(0, 0, 0, 0.08);
    animation: pulseOut 2s ease-out infinite;
  }

  .ring-2 {
    animation-delay: 0.7s;
  }

  @keyframes pulseOut {
    0% { transform: scale(0.95); opacity: 0.5; }
    100% { transform: scale(1.15); opacity: 0; }
  }

  /* Main orb with liquid effect */
  .orb {
    position: relative;
    width: 72px;
    height: 72px;
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
      0 0 0 4px rgba(0, 0, 0, 0.03),
      0 8px 32px rgba(0, 0, 0, 0.15);
  }

  .orb.error {
    background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%);
    box-shadow:
      inset 0 0 20px rgba(255, 255, 255, 0.5),
      0 4px 20px rgba(220, 38, 38, 0.2);
  }

  /* Liquid blobs container */
  .liquid-container {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    overflow: hidden;
    filter: blur(0px);
  }

  /* Gradient blobs - ChatGPT Voice style pastel aurora */
  .blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(12px);
    opacity: 0.7;
    transition: transform 0.2s ease-out;
  }

  .blob-1 {
    width: 60%;
    height: 60%;
    background: linear-gradient(135deg, rgba(253, 186, 116, 0.8) 0%, rgba(251, 146, 60, 0.6) 100%);
    top: 10%;
    left: 5%;
    animation: float1 6s ease-in-out infinite;
  }

  .blob-2 {
    width: 55%;
    height: 55%;
    background: linear-gradient(135deg, rgba(147, 197, 253, 0.8) 0%, rgba(96, 165, 250, 0.6) 100%);
    bottom: 15%;
    right: 10%;
    animation: float2 7s ease-in-out infinite;
  }

  .blob-3 {
    width: 50%;
    height: 50%;
    background: linear-gradient(135deg, rgba(167, 243, 208, 0.7) 0%, rgba(110, 231, 183, 0.5) 100%);
    top: 30%;
    left: 40%;
    animation: float3 8s ease-in-out infinite;
  }

  .blob-4 {
    width: 40%;
    height: 40%;
    background: linear-gradient(135deg, rgba(216, 180, 254, 0.6) 0%, rgba(192, 132, 252, 0.4) 100%);
    bottom: 25%;
    left: 15%;
    animation: float4 5s ease-in-out infinite;
  }

  @keyframes float1 {
    0%, 100% { transform: translate(0, 0) scale(0.8); }
    25% { transform: translate(10px, -8px) scale(0.9); }
    50% { transform: translate(5px, 5px) scale(0.85); }
    75% { transform: translate(-5px, 3px) scale(0.9); }
  }

  @keyframes float2 {
    0%, 100% { transform: translate(0, 0) scale(0.75); }
    33% { transform: translate(-8px, -5px) scale(0.85); }
    66% { transform: translate(5px, 8px) scale(0.8); }
  }

  @keyframes float3 {
    0%, 100% { transform: translate(0, 0) scale(0.7); }
    50% { transform: translate(8px, -3px) scale(0.8); }
  }

  @keyframes float4 {
    0%, 100% { transform: translate(0, 0) scale(0.65); }
    50% { transform: translate(-6px, 6px) scale(0.75); }
  }

  /* Waveform bars */
  .waveform {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 3px;
    height: 24px;
  }

  .wave-bar {
    width: 3px;
    background: rgba(0, 0, 0, 0.8);
    border-radius: 2px;
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
    width: 24px;
    height: 24px;
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
    gap: 3px;
    flex: 1;
    min-width: 0;
  }

  .status-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
  }

  .status-sub {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  /* End button */
  .end-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 12px;
    border-radius: var(--radius-m);
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
    background: var(--surface-highlight);
    border-color: var(--border-strong);
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
      0 0 0 4px rgba(255, 255, 255, 0.04),
      0 8px 32px rgba(0, 0, 0, 0.5);
  }

  :global(.dark) .blob-1 {
    background: linear-gradient(135deg, rgba(253, 186, 116, 0.6) 0%, rgba(251, 146, 60, 0.4) 100%);
  }

  :global(.dark) .blob-2 {
    background: linear-gradient(135deg, rgba(96, 165, 250, 0.6) 0%, rgba(59, 130, 246, 0.4) 100%);
  }

  :global(.dark) .blob-3 {
    background: linear-gradient(135deg, rgba(52, 211, 153, 0.5) 0%, rgba(16, 185, 129, 0.3) 100%);
  }

  :global(.dark) .blob-4 {
    background: linear-gradient(135deg, rgba(192, 132, 252, 0.5) 0%, rgba(168, 85, 247, 0.3) 100%);
  }

  :global(.dark) .wave-bar {
    background: rgba(255, 255, 255, 0.85);
  }

  :global(.dark) .icon-wrap {
    color: rgba(255, 255, 255, 0.85);
  }

  :global(.dark) .pulse-ring {
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