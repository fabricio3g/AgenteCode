<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
</script>

<label class="ui-artifact-field">
  {#if props.label}<span class="ui-field-label">{String(props.label)}</span>{/if}
  <div><RenderNode value={props.control} /></div>
</label>
