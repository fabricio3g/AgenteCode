<script lang="ts">
  let { props = {} } = $props<{ props?: Record<string, any> }>();
</script>

<figure class="ui-image-block">
  <img src={String(props.src || '')} alt={String(props.alt || props.caption || '')} loading="lazy" />
  {#if props.caption || props.alt}<figcaption class="ui-muted">{String(props.caption || props.alt)}</figcaption>{/if}
</figure>
