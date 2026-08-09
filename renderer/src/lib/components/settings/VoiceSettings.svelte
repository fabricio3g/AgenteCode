<svelte:options runes={true} />

<script lang="ts">
  import { Cpu, LoaderCircle, MemoryStick, MonitorCheck, RefreshCw } from 'lucide-svelte';
  import { Badge, Button } from '$lib/components/ui';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
</script>

<section class="rounded-xl border border-border bg-card">
  <div class="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
    <div>
      <h4 class="text-sm font-semibold text-foreground">Hardware summary</h4>
      <p class="mt-1 text-xs text-muted-foreground">Resources available to local models.</p>
    </div>
    <Button
      variant="ghost"
      size="sm"
      loading={hardwareStore.loading}
      loadingLabel="Detecting…"
      onclick={() => void hardwareStore.refresh()}
    >
      <RefreshCw /> Refresh
    </Button>
  </div>

  {#if hardwareStore.loading && !hardwareStore.info}
    <div class="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
      <LoaderCircle class="size-4 animate-spin" /> Detecting hardware…
    </div>
  {:else if hardwareStore.error}
    <div class="border-error-border bg-error-bg px-4 py-3 text-sm text-error">{hardwareStore.error}</div>
  {:else if !hardwareStore.info}
    <div class="px-4 py-5 text-sm text-muted-foreground">Hardware information is unavailable in browser mode.</div>
  {:else}
    {@const hw = hardwareStore.info}
    <div class="grid gap-px bg-border sm:grid-cols-3">
      <div class="min-w-0 bg-card p-4">
        <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Cpu class="size-4" /> Processor
        </div>
        <p class="mt-2 truncate text-sm font-semibold text-foreground" title={hw.cpu_model || 'CPU'}>
          {hw.cpu_model || 'CPU'}
        </p>
        <p class="mt-1 text-xs text-muted-foreground">{hw.physical_cores} cores · {hw.cpu_threads} threads</p>
      </div>

      <div class="min-w-0 bg-card p-4">
        <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <MemoryStick class="size-4" /> Memory
        </div>
        <p class="mt-2 text-sm font-semibold text-foreground">
          {hardwareStore.ramUsedGb.toFixed(1)} / {hw.total_ram_gb.toFixed(0)} GB
        </p>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            class={`h-full rounded-full ${hardwareStore.ramUsedPercent > 85 ? 'bg-error' : hardwareStore.ramUsedPercent > 65 ? 'bg-warning' : 'bg-success'}`}
            style={`width:${Math.min(100, hardwareStore.ramUsedPercent)}%`}
          ></div>
        </div>
      </div>

      <div class="min-w-0 bg-card p-4">
        <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <MonitorCheck class="size-4" /> Accelerator
        </div>
        <p class="mt-2 truncate text-sm font-semibold text-foreground" title={hw.gpu_name || 'CPU only'}>
          {hw.gpu_name || 'CPU only'}
        </p>
        <div class="mt-1 flex items-center gap-2">
          <span class="text-xs text-muted-foreground">{hw.vram_gb > 0 ? `${hw.vram_gb.toFixed(1)} GB VRAM` : 'No dedicated VRAM'}</span>
          {#if hw.vram_gb > 0}<Badge tone="success">{hardwareStore.backendLabel}</Badge>{/if}
        </div>
      </div>
    </div>
  {/if}
</section>
