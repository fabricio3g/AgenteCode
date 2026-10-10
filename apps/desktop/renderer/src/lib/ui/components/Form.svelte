<script lang="ts">
  import UiStack from '$lib/components/ui/Stack.svelte';

  import { setContext, untrack } from 'svelte';
  import RenderNode from '../RenderNode.svelte';
  import Buttons from './Buttons.svelte';

  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const name = $derived(String(props?.name || 'form'));
  // Form identity is fixed for the component lifetime; avoid state_referenced_locally on setContext.
  setContext('ui-form-name', untrack(() => String(props?.name || 'form')));
</script>

<form class="ui-form" onsubmit={(event) => event.preventDefault()}>
  <UiStack >
    <RenderNode value={props.fields || []} />
  </UiStack>
  {#if props.buttons}
    <Buttons props={props.buttons as any} formName={name} />
  {/if}
</form>
