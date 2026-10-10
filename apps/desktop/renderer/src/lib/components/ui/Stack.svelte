<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { direction = 'column', gap = '0.75rem', wrap = false, align = 'stretch', justify = 'flex-start', class: className = '', style = '', children, ...rest }: HTMLAttributes<HTMLDivElement> & { direction?: 'row' | 'column'; gap?: string; wrap?: boolean; align?: string; justify?: string } = $props();
</script>
<div class={cn('ui-layout-stack', className)} style={`flex-direction:${direction};flex-wrap:${wrap ? 'wrap' : 'nowrap'};gap:${gap};align-items:${align};justify-content:${justify};${style}`} {...rest}>
  {@render children?.()}
</div>
<style>.ui-layout-stack { display:flex; min-width:0; }</style>
