<script lang="ts">
  import { Section, Stack } from '$lib/components/ui';
  import Accordion from './Accordion.svelte';
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
</script>
{#if props.isFoldable !== false}<Accordion {props} />{:else}
  <Stack>{#each items as item, index}<Section title={String(item?.props?.trigger || item?.trigger || `Section ${index + 1}`)}><RenderNode value={item?.props?.content || item?.content || []} /></Section>{/each}</Stack>
{/if}
