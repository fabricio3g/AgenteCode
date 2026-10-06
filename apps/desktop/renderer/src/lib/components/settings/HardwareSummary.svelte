<svelte:options runes={true} />

<script lang="ts">
  import { Cpu, LoaderCircle, MemoryStick, MonitorCheck, RefreshCw } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { Badge, Button, Tooltip } from '$lib/components/ui';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import SettingsSection from './SettingsSection.svelte';
</script>

<SettingsSection title={$t('runtime.hardware')} description={$t('runtime.hardwareHint')}>
  {#snippet actions()}
    <Tooltip label={$t('runtime.refresh')} position="bottom"><Button
      variant="ghost"
      size="icon-sm"
      loading={hardwareStore.loading}
      onclick={() => void hardwareStore.refresh()}
      aria-label={$t('runtime.refresh')}
     
    >
      <RefreshCw />
    </Button></Tooltip>
  {/snippet}

  {#if hardwareStore.loading && !hardwareStore.info}
    <div class="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
      <LoaderCircle class="size-4 animate-spin" /> {$t('runtime.detecting')}
    </div>
  {:else if hardwareStore.error}
    <p class="px-4 py-3 text-sm text-error">{hardwareStore.error}</p>
  {:else if !hardwareStore.info}
    <p class="px-4 py-4 text-sm text-muted-foreground">{$t('runtime.hardwareUnavailable')}</p>
  {:else}
    {@const hw = hardwareStore.info}
    <div class="hardware-grid">
      <div class="hardware-cell">
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><Cpu class="size-3.5" /> {$t('runtime.processor')}</div>
        <p class="mt-1.5 truncate text-sm font-medium text-foreground" title={hw.cpu_model || 'CPU'}>{hw.cpu_model || 'CPU'}</p>
        <p class="text-xs text-muted-foreground">{$t('runtime.cores', { values: { cores: hw.physical_cores, threads: hw.cpu_threads } })}</p>
      </div>

      <div class="hardware-cell">
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><MemoryStick class="size-3.5" /> {$t('runtime.memory')}</div>
        <p class="mt-1.5 text-sm font-medium tabular-nums text-foreground">
          {$t('runtime.memoryUsed', { values: { used: hardwareStore.ramUsedGb.toFixed(1), total: hw.total_ram_gb.toFixed(0) } })}
        </p>
        <div class="mt-2 h-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
          <div
            class={`h-full rounded-full ${hardwareStore.ramUsedPercent > 90 ? 'bg-error' : hardwareStore.ramUsedPercent > 75 ? 'bg-warning' : 'bg-[var(--muted-foreground)]'}`}
            style={`width:${Math.min(100, hardwareStore.ramUsedPercent)}%`}
          ></div>
        </div>
      </div>

      <div class="hardware-cell">
        <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><MonitorCheck class="size-3.5" /> {$t('runtime.accelerator')}</div>
        <p class="mt-1.5 truncate text-sm font-medium text-foreground" title={hw.gpu_name || ''}>{hw.gpu_name || $t('runtime.noGpu')}</p>
        <div class="flex items-center gap-2">
          <span class="truncate text-xs text-muted-foreground">
            {#if hw.vram_gb > 0}
              {typeof hw.vram_used_gb === 'number'
                ? $t('runtime.vramUsed', { values: { used: hw.vram_used_gb.toFixed(1), total: hw.vram_gb.toFixed(0) } })
                : $t(hw.vram_estimated ? 'runtime.vramShared' : 'runtime.vram', { values: { n: hw.vram_gb.toFixed(1) } })}
            {:else}{$t('runtime.noVram')}{/if}
          </span>
          {#if hw.vram_gb > 0}<Badge>{hardwareStore.backendLabel}</Badge>{/if}
        </div>
      </div>
    </div>
  {/if}
</SettingsSection>

<style>
  /* Three readings side by side in one card, split by hairlines — not three
     grey boxes inside a box. */
  .hardware-grid {
    display: grid;
  }

  .hardware-cell {
    min-width: 0;
    padding: 0.75rem 1rem;
  }

  .hardware-cell + .hardware-cell {
    border-top: 1px solid var(--border-subtle);
  }

  @media (min-width: 640px) {
    .hardware-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .hardware-cell + .hardware-cell {
      border-top: 0;
      border-left: 1px solid var(--border-subtle);
    }
  }
</style>
