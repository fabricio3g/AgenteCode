<script lang="ts">
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const value = $derived(getFieldValue(formName, String(props.name || '')) ?? String(props.defaultValue || ''));
</script>

<UiInput
  class={uiClass("ui-artifact-input")}
  type={String(props.inputType || props.type || 'text')}
  name={String(props.name || '')}
  placeholder={String(props.placeholder || '')}
  value={String(value || '')}
  oninput={(event) => setFieldValue(formName, 'Input', String(props.name || ''), (event.currentTarget as HTMLInputElement).value)}
/>
