<script lang="ts">
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const value = $derived(getFieldValue(formName, String(props.name || '')) ?? '');
</script>

<UiInput class={uiClass("ui-artifact-input")} type="date" value={String(value)} onchange={(event) => setFieldValue(formName, 'DatePicker', String(props.name || ''), (event.currentTarget as HTMLInputElement).value)} />
