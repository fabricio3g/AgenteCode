<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import Section from '$lib/components/ui/Section.svelte';
  let props: ComponentProps<typeof Section> = $props();
</script>
<Section {...props} />
