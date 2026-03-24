<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
  let active = $state(0);
</script>

<div class="ui-tabs">
  <div class="ui-tab-list">
    {#each items as item, index}
      <button class:active={active === index} class="ui-tab-trigger" onclick={() => (active = index)}>{String(item?.props?.trigger || item?.trigger || `Tab ${index + 1}`)}</button>
    {/each}
  </div>
  {#if items[active]}
    <div class="ui-panel"><RenderNode value={items[active]?.props?.content || items[active]?.content || []} /></div>
  {/if}
</div>
