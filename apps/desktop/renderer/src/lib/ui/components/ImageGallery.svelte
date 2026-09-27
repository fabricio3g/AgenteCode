<script lang="ts">
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.images) ? props.images : []);
</script>

<div class="ui-gallery">
  {#each items as item}
    <img class="ui-gallery-image" src={typeof item === 'string' ? item : String(item?.src || '')} alt={typeof item === 'string' ? '' : String(item?.alt || '')} loading="lazy" />
  {/each}
</div>
