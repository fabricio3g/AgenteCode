<script lang="ts">
  import Callout from '$lib/components/ui/Callout.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
</script>
<Callout text={String(props.text || props.content || '')} />
