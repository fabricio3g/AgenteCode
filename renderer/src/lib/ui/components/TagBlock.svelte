<script lang="ts">
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.tags) ? props.tags : Array.isArray(props.items) ? props.items : []);
</script>

<div class="ui-tags">
  {#each items as item}
    <span class="ui-tag">{typeof item === 'string' ? item : String(item?.props?.label || item?.label || '')}</span>
  {/each}
</div>
