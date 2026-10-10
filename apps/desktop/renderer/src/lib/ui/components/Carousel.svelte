<script lang="ts">
  import UiStack from '$lib/components/ui/Stack.svelte';
  import UiSurface from '$lib/components/ui/Surface.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const slides = $derived(Array.isArray(props.slides) ? props.slides : []);
  let active = $state(0);
</script>

<UiStack  style="gap:0.8rem;">
  {#if slides.length}
    <UiSurface ><RenderNode value={slides[active] || []} /></UiSurface>
    {#if slides.length > 1}
      <div class="ui-buttons">
        <UiButton variant="outline" class={uiClass(" ui-artifact-button-secondary")} onclick={() => (active = Math.max(0, active - 1))}>Previous</UiButton>
        <span class="ui-muted">{active + 1} / {slides.length}</span>
        <UiButton variant="outline" class={uiClass(" ui-artifact-button-secondary")} onclick={() => (active = Math.min(slides.length - 1, active + 1))}>Next</UiButton>
      </div>
    {/if}
  {/if}
</UiStack>
