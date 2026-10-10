<script lang="ts">
  import DataTable from '$lib/components/ui/DataTable.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const columns = $derived((Array.isArray(props.columns) ? props.columns : []).map((column: any, index: number) => ({ key: String(column?.key ?? column?.props?.key ?? index), label: typeof column === 'string' ? column : String(column?.props?.label || column?.label || column?.header || '') })));
  const rows = $derived(Array.isArray(props.rows) ? props.rows : []);
</script>
<DataTable {columns} {rows} caption={props.caption ? String(props.caption) : undefined} />
