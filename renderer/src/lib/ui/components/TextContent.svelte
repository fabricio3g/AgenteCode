<script lang="ts">
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const tone = $derived(String(props.tone || props.variant || 'default'));
</script>

{#if tone === 'large-heavy'}
  <h3 class="ui-title">{String(props.text || '')}</h3>
{:else if tone === 'small' || tone === 'muted'}
  <p class="ui-muted">{String(props.text || '')}</p>
{:else}
  <p class="ui-copy">{String(props.text || '')}</p>
{/if}
