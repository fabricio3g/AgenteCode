<script lang="ts">
  import { setContext } from 'svelte';
  import RenderNode from '../RenderNode.svelte';
  import Buttons from './Buttons.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const name = $derived(String(props.name || 'form'));
  setContext('ui-form-name', name);
</script>

<form class="ui-form" onsubmit={(event) => event.preventDefault()}>
  <div class="ui-stack">
    <RenderNode value={props.fields || []} />
  </div>
  {#if props.buttons}
    <Buttons props={props.buttons as any} formName={name} />
  {/if}
</form>
