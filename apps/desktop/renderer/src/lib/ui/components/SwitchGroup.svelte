<script lang="ts">
  import UiStack from '$lib/components/ui/Stack.svelte';

  import Switch from '$lib/components/ui/Switch.svelte';

  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
  const selected = $derived((getFieldValue(formName, String(props.name || '')) || {}) as Record<string, boolean>);
  function update(key: string, value: boolean) {
    setFieldValue(formName, 'SwitchGroup', String(props.name || ''), { ...selected, [key]: value });
  }
</script>

<UiStack  style="gap:0.45rem;">
  {#each items as item}
    {@const value = String(item?.props?.value || item?.value || item?.props?.name || '')}
    {@const label = String(item?.props?.label || item?.label || value)}
    <label class="ui-choice ui-switch"><span>{label}</span><Switch label={label} checked={!!selected[value]} onchange={checked => update(value, checked)} /></label>
  {/each}
</UiStack>
