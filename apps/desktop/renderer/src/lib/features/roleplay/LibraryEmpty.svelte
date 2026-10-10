<script lang="ts">
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  let { title, hint = '', action = '', onaction }: { title: string; hint?: string; action?: string; onaction?: () => void } = $props();
</script>
<EmptyState {title} description={hint} {action} {onaction} />
