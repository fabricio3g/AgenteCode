<script lang="ts">
  import { Disclosure, Stack } from '$lib/components/ui';
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
</script>
<Stack>
  {#each items as item, index}
    <Disclosure quiet open={index === 0} title={String(item?.props?.trigger || item?.trigger || `Section ${index + 1}`)}>
      <RenderNode value={item?.props?.content || item?.content || []} />
    </Disclosure>
  {/each}
</Stack>
