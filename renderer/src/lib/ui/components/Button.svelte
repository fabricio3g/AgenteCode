<script lang="ts">
  import { useUI } from '../context';
  let { props = {}, formName } = $props<{ props?: Record<string, any>; formName?: string }>();
  const { triggerAction } = useUI();
</script>

<button class={`ui-button ui-button-${String(props.variant || 'primary')}`} onclick={() => triggerAction(String(props.label || 'Continue'), formName, props.action as any)}>
  {String(props.label || 'Continue')}
</button>
