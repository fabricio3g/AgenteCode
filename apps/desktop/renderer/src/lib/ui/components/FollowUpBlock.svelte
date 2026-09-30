<script lang="ts">
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const { triggerAction } = useUI();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
</script>

<div class="ui-buttons">
  {#each items as item}
    <button class="ui-button ui-artifact-button-secondary" onclick={() => triggerAction(String(item?.props?.text || item?.text || 'Continue'))}>{String(item?.props?.text || item?.text || '')}</button>
  {/each}
</div>
