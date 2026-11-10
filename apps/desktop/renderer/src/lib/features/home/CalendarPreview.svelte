<script lang="ts">
  import { locale } from 'svelte-i18n';
  import { dayKey, firstDayOfWeek, monthWeeks, weekdayLabels } from './calendar-model';
  import { useCalendar } from './calendar-state.svelte';

  const calendar = useCalendar();
  const current = $derived(calendar.current);
  const lang = $derived($locale || 'en');
  const weekStart = $derived(firstDayOfWeek(lang));
  const monthLabel = $derived(new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' }).format(current));
  const weekdays = $derived(weekdayLabels(lang, weekStart));
  const weeks = $derived(monthWeeks(current, weekStart));
</script>

<div class="preview" aria-hidden="true">
  <div class="month">{monthLabel}</div>
  <table>
    <thead><tr>{#each weekdays as weekday, index (index)}<th>{weekday}</th>{/each}</tr></thead>
    <tbody>{#each weeks as week, index (index)}
      <tr>{#each week as date (dayKey(date))}
        {@const items = calendar.entriesOn(date)}
        <td class:outside={date.getMonth() !== current.getMonth()}>
          <span class="day" class:current={dayKey(date) === dayKey(current)}>
            {date.getDate()}
            {#if items.length}
              <span class="markers">
                {#each items.slice(0, 2) as item (item.id)}
                  <span class="dot calendar-dot calendar-tone" data-tone={item.color}></span>
                {/each}
              </span>
            {/if}
          </span>
        </td>
      {/each}</tr>
    {/each}</tbody>
  </table>
</div>

<style>
  .preview { width:calc(13rem * var(--reading-scale, 1)); max-width:min(20rem, calc(100vw - 3rem)); }
  .month { padding:0.1rem 0.2rem 0.45rem; color:var(--foreground); font-size:var(--text-sm); font-weight:500; }
  table { width:100%; table-layout:fixed; border-collapse:collapse; text-align:center; }
  th { padding:0.15rem 0; overflow:hidden; color:var(--text-secondary); font-size:var(--text-xs); font-weight:400; text-overflow:ellipsis; }
  td { padding:1px; color:var(--foreground); font-size:var(--text-xs); }
  td.outside { color:var(--muted-foreground); }
  .day { position:relative; display:flex; width:calc(1.65rem * var(--reading-scale, 1)); height:calc(1.65rem * var(--reading-scale, 1)); max-width:100%; margin:auto; align-items:center; justify-content:center; border-radius:var(--radius-sm); }
  .day.current { background:var(--surface-hover); color:var(--foreground); font-weight:700; }
  .markers { position:absolute; bottom:2px; display:flex; gap:2px; }
  .dot { width:3px; height:3px; }
</style>
