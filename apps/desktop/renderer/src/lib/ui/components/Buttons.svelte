<script lang="ts">
  import RenderNode from '../RenderNode.svelte';
  import Button from './Button.svelte';
  let { props = {}, formName } = $props<{ props?: Record<string, any>; formName?: string }>();
  const buttons = $derived(Array.isArray(props.items) ? props.items : []);
</script>

<div class="ui-buttons">
  {#each buttons as button}
    {#if button?.type === 'element'}
      <RenderNode value={button} />
    {:else}
      <Button props={button} {formName} />
    {/if}
  {/each}
</div>
