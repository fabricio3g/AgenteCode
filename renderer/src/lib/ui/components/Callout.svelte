<script lang="ts">
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const tone = $derived(String(props.tone || 'info'));
</script>

<div class={`ui-callout ui-callout-${tone}`}>
  {#if props.title}<div class="ui-callout-title">{String(props.title)}</div>{/if}
  <div class="ui-copy">{String(props.content || props.text || '')}</div>
</div>
