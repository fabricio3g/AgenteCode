<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const { triggerAction } = useUI();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
</script>

<div class="ui-buttons">
  {#each items as item}
    <UiButton variant="outline" class={uiClass(" ui-artifact-button-secondary")} onclick={() => triggerAction(String(item?.props?.text || item?.text || 'Continue'))}>{String(item?.props?.text || item?.text || '')}</UiButton>
  {/each}
</div>
