<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {}, typeName = 'Unknown' } = $props<{ props?: Record<string, any>; typeName?: string }>();
</script>

<div class="ui-panel ui-unknown">
  <div class="ui-muted">{typeName}</div>
  {#if props.children}
    <div class="ui-stack"><RenderNode value={props.children} /></div>
  {/if}
</div>
