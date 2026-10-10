<script lang="ts">
  import UiSurface from '$lib/components/ui/Surface.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  let { props = {}, typeName = 'Unknown' } = $props<{ props?: Record<string, any>; typeName?: string }>();
</script>

<UiSurface class={uiClass("ui-unknown")}>
  <div class="ui-muted">{typeName}</div>
  {#if props.children}
    <div class="ui-muted">Contains nested content</div>
  {/if}
</UiSurface>
