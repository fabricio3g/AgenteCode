<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const slides = $derived(Array.isArray(props.slides) ? props.slides : []);
  let active = $state(0);
</script>

<div class="ui-stack" style="gap:0.8rem;">
  {#if slides.length}
    <div class="ui-panel"><RenderNode value={slides[active] || []} /></div>
    {#if slides.length > 1}
      <div class="ui-buttons">
        <button class="ui-button ui-artifact-button-secondary" onclick={() => (active = Math.max(0, active - 1))}>Previous</button>
        <span class="ui-muted">{active + 1} / {slides.length}</span>
        <button class="ui-button ui-artifact-button-secondary" onclick={() => (active = Math.min(slides.length - 1, active + 1))}>Next</button>
      </div>
    {/if}
  {/if}
</div>
