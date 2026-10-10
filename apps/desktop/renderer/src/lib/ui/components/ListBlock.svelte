<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const { triggerAction } = useUI();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
</script>

<div class="ui-list-block">
  {#each items as item}
    <UiButton variant="plain" class={uiClass("ui-list-item")} onclick={() => triggerAction(String(item?.props?.text || item?.text || 'Continue'))}>
      <span class="ui-list-label">{String(item?.props?.text || item?.text || '')}</span>
      {#if item?.props?.description || item?.description}<span class="ui-muted">{String(item?.props?.description || item?.description)}</span>{/if}
    </UiButton>
  {/each}
</div>
