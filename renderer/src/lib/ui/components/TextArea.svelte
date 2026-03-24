<script lang="ts">
  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const value = $derived(getFieldValue(formName, String(props.name || '')) ?? String(props.defaultValue || ''));
</script>

<textarea
  class="ui-input ui-textarea"
  name={String(props.name || '')}
  rows={Number(props.rows || 4)}
  placeholder={String(props.placeholder || '')}
  oninput={(event) => setFieldValue(formName, 'TextArea', String(props.name || ''), (event.currentTarget as HTMLTextAreaElement).value)}
>{String(value || '')}</textarea>
