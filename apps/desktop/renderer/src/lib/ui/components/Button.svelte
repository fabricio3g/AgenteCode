<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import { useUI } from '../context';
  let { props = {}, formName } = $props<{ props?: Record<string, any>; formName?: string }>();
  const { triggerAction } = useUI();
</script>
<Button variant={props.variant === 'secondary' ? 'outline' : props.variant === 'tertiary' ? 'ghost' : 'default'} onclick={() => triggerAction(String(props.label || 'Continue'), formName, props.action as any)}>{String(props.label || 'Continue')}</Button>
