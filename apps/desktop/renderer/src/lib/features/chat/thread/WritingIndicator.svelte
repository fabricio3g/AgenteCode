<svelte:options runes={true} />

<script lang="ts">
  import TileMeter from '$lib/components/ui/TileMeter.svelte';
  import type { TileMeterMode } from '$lib/utils/activity-meter';
  let { mode = 'busy', label = 'Writing', color = '' }: { mode?: TileMeterMode; label?: string; color?: string } = $props();
</script>

<span class="inline-flex items-center text-muted-foreground" role="status" aria-label={label}>
  <TileMeter {mode} {color} />
</span>
