<script lang="ts">
  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const options = $derived(Array.isArray(props.options) ? props.options : []);
  const value = $derived(getFieldValue(formName, String(props.name || '')) ?? '');
  const optionValue = (option: any) => String(option?.props?.value || option?.value || '');
  const optionLabel = (option: any) => String(option?.props?.label || option?.label || optionValue(option));
</script>

<select class="ui-input" value={String(value)} onchange={(event) => setFieldValue(formName, 'Select', String(props.name || ''), (event.currentTarget as HTMLSelectElement).value)}>
  <option value="">{String(props.placeholder || 'Select...')}</option>
  {#each options as option}
    <option value={optionValue(option)}>{optionLabel(option)}</option>
  {/each}
</select>
