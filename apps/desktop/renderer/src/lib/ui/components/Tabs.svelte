<script lang="ts">
  import { TabBar, Surface } from '$lib/components/ui';
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
  let active = $state('0');
</script>
<TabBar bind:value={active} label={String(props.label || 'Tabs')} options={items.map((item: any, index: number) => ({ value: String(index), label: String(item?.props?.trigger || item?.trigger || `Tab ${index + 1}`) }))} />
{#if items[Number(active)]}<Surface><RenderNode value={items[Number(active)]?.props?.content || items[Number(active)]?.content || []} /></Surface>{/if}
