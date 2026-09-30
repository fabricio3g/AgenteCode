<svelte:options runes={true} />

<!--
  A bot's animated, hand-drawn face (./face/engine.ts). Its look and
  temperament come from `faceKey` (the bot's handle) in the family of
  `tint`, so the same bot looks and moves the same everywhere. `mood` is its
  state; each new `cue` makes it react once (reading, searching, writing,
  running, an error, done). Faces share one frame loop that runs only while
  one is on screen; under reduced motion each face is a still drawing.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { mountFace, type Face, type FaceCue, type FaceState } from './face/engine';

  let {
    faceKey,
    tint = 'blue',
    size = 32,
    mood = 'idle',
    cue = null
  }: {
    faceKey: string;
    tint?: string;
    size?: number;
    mood?: FaceState;
    cue?: FaceCue | null;
  } = $props();

  let host = $state<HTMLSpanElement>();
  let face: Face | null = null;
  let lastCue = 0;

  // A new key, tint or size is a new drawing.
  $effect(() => {
    if (!host) return;
    const mounted = mountFace(host, { key: faceKey, tint, size });
    untrack(() => mounted.setState(mood, false));
    face = mounted;
    return () => {
      mounted.destroy();
      if (face === mounted) face = null;
    };
  });

  $effect(() => {
    const next = mood;
    untrack(() => face?.setState(next));
  });

  $effect(() => {
    const next = cue;
    if (!next || next.seq === lastCue) return;
    lastCue = next.seq;
    untrack(() => face?.react(next.event));
  });
</script>

<span bind:this={host} class="bot-face" style:width={`${size}px`} style:height={`${size}px`} aria-hidden="true"></span>

<style>
  .bot-face {
    --face-eye: #fdf9f1;
    --face-grain: #1b1622;
    display: inline-block;
    flex: none;
    line-height: 0;
    color: var(--foreground);
  }

  :global(.dark) .bot-face { --face-grain: #ffffff; }

  .bot-face :global(svg) { display: block; overflow: visible; isolation: isolate; }
  .bot-face :global(.grain) { color: var(--face-grain); mix-blend-mode: multiply; opacity: .55; }
  .bot-face :global(.ribbon) { fill: currentColor; fill-rule: evenodd; }
  .bot-face :global(.rim) { stroke: var(--face-eye); }
  .bot-face :global(.eye path) { fill: var(--face-eye); stroke: currentColor; }
  .bot-face :global(.eye .socket) { fill: currentColor; stroke: none; opacity: .18; }
  .bot-face :global(.eye.happy path) { fill: none; stroke-linecap: round; }
  .bot-face :global(.eye.happy .socket) { display: none; }
  .bot-face :global(.fx path) { fill: currentColor; stroke: none; }
  .bot-face :global(.acc path) { stroke: currentColor; }

  /* Dark: plum ink instead of white, a softer rim, grain lifted not darkened. */
  :global(.dark) .bot-face :global(.ink),
  :global(.dark) .bot-face :global(.ink2),
  :global(.dark) .bot-face :global(.eye path) { stroke: #493649; }
  :global(.dark) .bot-face :global(.ribbon) { fill: #493649; }
  :global(.dark) .bot-face :global(.rim) { opacity: .35; }
  :global(.dark) .bot-face :global(.grain) { mix-blend-mode: screen; opacity: .28; }
</style>
