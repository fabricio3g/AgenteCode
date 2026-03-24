<script lang="ts">
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const columns = $derived(Array.isArray(props.columns) ? props.columns : []);
  const rows = $derived(Array.isArray(props.rows) ? props.rows : []);
  const colLabel = (column: any) => typeof column === 'string' ? column : String(column?.props?.label || column?.label || '');
</script>

<div class="ui-table-wrap">
  <table class="ui-table">
    <thead>
      <tr>
        {#each columns as column}
          <th>{colLabel(column)}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row}
        <tr>
          {#each Array.isArray(row) ? row : [] as cell}
            <td>{typeof cell === 'object' ? JSON.stringify(cell) : String(cell ?? '')}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
