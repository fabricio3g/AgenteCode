<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const direction = $derived(props.direction === 'row' ? 'row' : 'column');
  const wrap = $derived(!!props.wrap);
  const gapMap: Record<string, string> = { xs: '0.4rem', s: '0.65rem', m: '1rem', l: '1.4rem', xl: '1.9rem' };
  const gap = $derived(gapMap[String(props.gap || 'm')] || String(props.gap || '1rem'));
</script>

<div class="ui-stack" style={`flex-direction:${direction};flex-wrap:${wrap ? 'wrap' : 'nowrap'};gap:${gap};align-items:${props.align || 'stretch'};justify-content:${props.justify || 'flex-start'};`}>
  <RenderNode value={props.children || []} />
</div>
