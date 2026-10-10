<script lang="ts">
  import Callout from '$lib/components/ui/Callout.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
</script>
<Callout title={props.title ? String(props.title) : undefined} text={String(props.content || props.text || '')} tone={props.tone === 'warning' ? 'warning' : props.tone === 'error' ? 'error' : 'neutral'} />
