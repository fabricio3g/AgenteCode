<script lang="ts">
  import UiStack from '$lib/components/ui/Stack.svelte';

  import UiCheckbox from '$lib/components/ui/Checkbox.svelte';

  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
  const selected = $derived(Array.isArray(getFieldValue(formName, String(props.name || ''))) ? getFieldValue(formName, String(props.name || '')) : []);
  function toggle(value: string, checked: boolean) {
    const next = checked ? [...selected, value] : selected.filter((item: string) => item !== value);
    setFieldValue(formName, 'CheckBoxGroup', String(props.name || ''), next);
  }
</script>

<UiStack  style="gap:0.45rem;">
  {#each items as item}
    {@const value = String(item?.props?.value || item?.value || '')}
    {@const label = String(item?.props?.label || item?.label || value)}
    <label class="ui-choice"><UiCheckbox   checked={selected.includes(value)} onchange={(event) => toggle(value, (event.currentTarget as HTMLInputElement).checked)} /> <span>{label}</span></label>
  {/each}
</UiStack>
