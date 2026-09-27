<script lang="ts">
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const { triggerAction } = useUI();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
</script>

<div class="ui-list-block">
  {#each items as item}
    <button class="ui-list-item" onclick={() => triggerAction(String(item?.props?.text || item?.text || 'Continue'))}>
      <span class="ui-list-label">{String(item?.props?.text || item?.text || '')}</span>
      {#if item?.props?.description || item?.description}<span class="ui-muted">{String(item?.props?.description || item?.description)}</span>{/if}
    </button>
  {/each}
</div>
