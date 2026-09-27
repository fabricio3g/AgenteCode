<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
</script>

<div class="ui-stack">
  {#each items as item, index}
    <details class="ui-panel" open={index === 0}>
      <summary class="ui-summary">{String(item?.props?.trigger || item?.trigger || `Section ${index + 1}`)}</summary>
      <div class="ui-stack" style="margin-top:0.8rem;"><RenderNode value={item?.props?.content || item?.content || []} /></div>
    </details>
  {/each}
</div>
