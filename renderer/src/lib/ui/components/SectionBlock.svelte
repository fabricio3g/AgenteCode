<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
  const foldable = $derived(props.isFoldable !== false);
</script>

<div class="ui-stack">
  {#each items as item, index}
    {#if foldable}
      <details class="ui-panel" open={index === 0}>
        <summary class="ui-summary">{String(item?.props?.trigger || item?.trigger || `Section ${index + 1}`)}</summary>
        <div class="ui-stack" style="margin-top:0.8rem;"><RenderNode value={item?.props?.content || item?.content || []} /></div>
      </details>
    {:else}
      <section class="ui-panel ui-stack">
        <h4 class="ui-title-sm">{String(item?.props?.trigger || item?.trigger || `Section ${index + 1}`)}</h4>
        <RenderNode value={item?.props?.content || item?.content || []} />
      </section>
    {/if}
  {/each}
</div>
