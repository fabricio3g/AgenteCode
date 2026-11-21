<svelte:options runes={true} />

<!--
  Five bars that dance while the microphone is open. They live here, not in
  the button, because two places show a listening microphone: the dictation
  button in the composer's bar and the send slot itself, which becomes the
  mic while the field is empty. One animation, both places.
-->

<div class="mic-lines" aria-hidden="true">
  {#each [0, 1, 2, 3, 4] as index (index)}<span class="mic-line" style={`animation-delay: ${index * 0.12}s;`}></span>{/each}
</div>

<style>
  .mic-lines { display:flex; height:14px; align-items:center; justify-content:center; gap:2px; }
  .mic-line { width:2px; height:6px; border-radius:1px; background:currentColor; animation:micLineBounce 0.8s ease-in-out infinite; }
  @keyframes micLineBounce { 0%, 100% { height:5px; opacity:0.5; } 50% { height:14px; opacity:1; } }
  @media (prefers-reduced-motion: reduce) { .mic-line { animation:none !important; } }
</style>