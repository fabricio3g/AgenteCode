<svelte:options runes={true} />
<script lang="ts">
  let { edge, label, style, active = false, onpointerdown, onkeydown, onhover }: {
    edge: string; label: string; style: string; active?: boolean;
    onpointerdown: (event: PointerEvent) => void;
    onkeydown: (event: KeyboardEvent) => void;
    onhover?: (hovered: boolean) => void;
  } = $props();
</script>
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="window-resize edge-{edge}" class:active {style} role="separator" aria-orientation={edge === 'e' || edge === 'w' ? 'vertical' : 'horizontal'} aria-label={label} title={label} tabindex="0" {onpointerdown} {onkeydown} onpointerenter={() => onhover?.(true)} onpointerleave={() => onhover?.(false)}><span class="grip" aria-hidden="true"></span></div>
<style>
  .window-resize { position: absolute; touch-action: none; outline: none; }
  .window-resize::after { content: ''; position: absolute; border-radius: 6px; background: var(--muted-foreground); opacity: 0; transition: opacity var(--motion-fast) var(--motion-ease); pointer-events: none; }
  .window-resize:hover::after, .window-resize:focus-visible::after, .window-resize.active::after { opacity: .18; }
  .grip { position: absolute; pointer-events: none; opacity: 0; transition: opacity var(--motion-fast) var(--motion-ease), transform var(--motion-fast) var(--motion-ease); }
  .window-resize:hover .grip, .window-resize:focus-visible .grip, .window-resize.active .grip { opacity: .5; }
  .edge-n, .edge-s { cursor: ns-resize; }
  .edge-e, .edge-w { cursor: ew-resize; }
  .edge-n::after, .edge-s::after { height: 2px; left: 12px; right: 12px; top: calc(50% - 1px); }
  .edge-e::after, .edge-w::after { width: 2px; top: 12px; bottom: 12px; left: calc(50% - 1px); }
  .edge-n .grip, .edge-s .grip { width: 28px; height: 3px; top: calc(50% - 1.5px); left: calc(50% - 14px); border-radius: 3px; background: var(--muted-foreground); }
  .edge-e .grip, .edge-w .grip { height: 28px; width: 3px; left: calc(50% - 1.5px); top: calc(50% - 14px); border-radius: 3px; background: var(--muted-foreground); }
  .edge-ne, .edge-sw { cursor: nesw-resize; } .edge-nw, .edge-se { cursor: nwse-resize; }
  .edge-ne::after, .edge-nw::after, .edge-se::after, .edge-sw::after { inset: 3px; background: var(--foreground); }
  .edge-ne .grip, .edge-nw .grip, .edge-se .grip, .edge-sw .grip { width: 9px; height: 9px; left: calc(50% - 4.5px); top: calc(50% - 4.5px); border-right: 2px solid var(--muted-foreground); border-bottom: 2px solid var(--muted-foreground); border-radius: 0 0 2px 0; }
  .edge-ne .grip { transform: rotate(-90deg); } .edge-nw .grip { transform: rotate(180deg); } .edge-sw .grip { transform: rotate(90deg); }
  .window-resize:focus-visible { outline: 1px solid var(--muted-foreground); outline-offset: -2px; border-radius: 5px; }
  @media (prefers-reduced-motion: reduce) { .window-resize::after, .grip { transition: none; } }
  :global(.a11y-reduce-motion) .window-resize::after, :global(.a11y-reduce-motion) .grip { transition: none; }
</style>
