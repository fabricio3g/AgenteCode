<script lang="ts">
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const value = $derived(getFieldValue(formName, String(props.name || '')) ?? String(props.defaultValue || ''));
</script>

<UiTextarea value={String(value || '')}
  class={uiClass("ui-artifact-input ui-textarea")}
  name={String(props.name || '')}
  rows={Number(props.rows || 4)}
  placeholder={String(props.placeholder || '')}
  oninput={(event) => setFieldValue(formName, 'TextArea', String(props.name || ''), (event.currentTarget as HTMLTextAreaElement).value)}
></UiTextarea>
