<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {}, chat = false } = $props<{ props?: Record<string, any>; chat?: boolean }>();
</script>

<section class:ui-chat-card={chat} class="ui-panel ui-stack">
  <RenderNode value={props.children || []} />
</section>
