<script lang="ts">
  let { props = {}, typeName = 'Unknown' } = $props<{ props?: Record<string, any>; typeName?: string }>();
</script>

<div class="ui-panel ui-unknown">
  <div class="ui-muted">{typeName}</div>
  {#if props.children}
    <div class="ui-muted">Contains nested content</div>
  {/if}
</div>
