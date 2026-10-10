<script lang="ts">
  import { Surface, Stack } from '$lib/components/ui';
  import RenderNode from '../RenderNode.svelte';
  let { props = {}, chat = false } = $props<{ props?: Record<string, any>; chat?: boolean }>();
</script>
<Surface as="section" class={chat ? 'ui-chat-card' : ''}><Stack><RenderNode value={props.children || []} /></Stack></Surface>
