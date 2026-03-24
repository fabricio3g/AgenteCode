<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
</script>

<ol class="ui-steps">
  {#each items as item, index}
    <li class="ui-step">
      <div class="ui-step-index">{index + 1}</div>
      <div class="ui-step-body">
        <div class="ui-step-title">{String(item?.props?.title || item?.title || `Step ${index + 1}`)}</div>
        <div class="ui-stack"><RenderNode value={item?.props?.content || item?.content || []} /></div>
      </div>
    </li>
  {/each}
</ol>
