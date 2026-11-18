<svelte:options runes={true} />

<script lang="ts">
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  let { label = 'Writing', color = '' }: { label?: string; color?: string } = $props();
</script>

<span class="inline-flex items-center text-muted-foreground" role="status" aria-label={label}>
  <TileMeter mode="busy" {color} />
</span>
