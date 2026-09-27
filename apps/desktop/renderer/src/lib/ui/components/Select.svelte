<script lang="ts">
  import { getContext } from 'svelte';
  import { Select as ProductSelect } from '$lib/components/ui';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const options = $derived(Array.isArray(props.options) ? props.options : []);
  const value = $derived(getFieldValue(formName, String(props.name || '')) ?? '');
  const optionValue = (option: any) => String(option?.props?.value || option?.value || '');
  const optionLabel = (option: any) => String(option?.props?.label || option?.label || optionValue(option));
  const normalizedOptions = $derived([
    { value: '', label: String(props.placeholder || 'Select...') },
    ...options.map((option: any) => ({
      value: optionValue(option),
      label: optionLabel(option),
      disabled: Boolean(option?.props?.disabled ?? option?.disabled),
      description: String(option?.props?.description || option?.description || '') || undefined,
    })),
  ]);
</script>

<ProductSelect
  class="ui-input"
  value={String(value)}
  options={normalizedOptions}
  disabled={Boolean(props.disabled)}
  aria-label={String(props.label || props.name || 'Select')}
  onchange={(nextValue) => setFieldValue(formName, 'Select', String(props.name || ''), nextValue)}
/>
