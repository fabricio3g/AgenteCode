<svelte:options runes={true} />

<script lang="ts">
  import { Cpu, MemoryStick, MonitorCheck, RefreshCw, LoaderCircle } from 'lucide-svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
</script>

<div class="space-y-4">
  <section class="rounded-lg bg-[var(--surface)] p-4 text-[var(--text-secondary)]">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1">
        <h4 class="text-base font-medium text-[var(--text)]">Hardware</h4>
        <p class="text-xs leading-normal text-[var(--text-tertiary)]">Detected system hardware and memory usage.</p>
      </div>
      <button
        class="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-[var(--text-tertiary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        onclick={() => void hardwareStore.refresh()}
      >
        <RefreshCw class={`h-3.5 w-3.5 ${hardwareStore.loading ? 'animate-spin' : ''}`} />Refresh
      </button>
    </div>
  </section>

  {#if hardwareStore.loading && !hardwareStore.info}
    <section class="flex items-center gap-2 rounded-lg bg-[var(--surface)] p-4 text-sm text-[var(--text-muted)]">
      <LoaderCircle class="h-4 w-4 animate-spin" />Detecting hardware…
    </section>
  {:else if hardwareStore.error}
    <section class="rounded-lg border border-[var(--border-hover)] bg-[var(--surface)] p-4 text-sm text-[var(--text)]">
      {hardwareStore.error}
    </section>
  {:else if !hardwareStore.info}
    <section class="rounded-lg bg-[var(--surface)] p-4 text-sm text-[var(--text-tertiary)]">Hardware info not available in browser mode.</section>
  {:else}
    {@const hw = hardwareStore.info}

    <section class="rounded-lg bg-[var(--surface)] p-4">
      <div class="mb-3 flex items-center gap-2">
        <Cpu class="h-4 w-4 text-[var(--text-muted)]" />
        <h4 class="text-base font-medium text-[var(--text)]">CPU</h4>
      </div>
      <div class="space-y-1.5 text-sm">
        {#if hw.cpu_model}
          <div class="flex justify-between gap-6 border-b border-[var(--border)] pb-2">
            <span class="text-[var(--text-muted)]">Model</span>
            <span class="max-w-[60%] truncate text-right font-medium text-[var(--text)]">{hw.cpu_model}</span>
          </div>
        {/if}
        <div class="flex justify-between gap-6 border-b border-[var(--border)] py-2">
          <span class="text-[var(--text-muted)]">Physical cores</span>
          <span class="font-medium text-[var(--text)]">{hw.physical_cores}</span>
        </div>
        <div class="flex justify-between gap-6 pt-2">
          <span class="text-[var(--text-muted)]">Threads</span>
          <span class="font-medium text-[var(--text)]">{hw.cpu_threads}</span>
        </div>
      </div>
    </section>

    <section class="rounded-lg bg-[var(--surface)] p-4">
      <div class="mb-3 flex items-center gap-2">
        <MemoryStick class="h-4 w-4 text-[var(--text-muted)]" />
        <h4 class="text-base font-medium text-[var(--text)]">RAM</h4>
        <span class="ml-auto text-sm font-medium tabular-nums text-[var(--text)]">
          {hardwareStore.ramUsedGb.toFixed(1)} / {hw.total_ram_gb.toFixed(0)} GB used
        </span>
      </div>
      <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--background)]">
        <div
          class={`h-full rounded-full transition-all ${hardwareStore.ramUsedPercent > 85 ? 'bg-error' : hardwareStore.ramUsedPercent > 65 ? 'bg-warning' : 'bg-success'}`}
          style="width:{Math.min(100, hardwareStore.ramUsedPercent)}%"
        ></div>
      </div>
      <div class="mt-1 flex justify-between text-xs text-[var(--text-muted)]">
        <span>{hardwareStore.ramUsedPercent}% used</span>
        <span>{hw.free_ram_gb.toFixed(1)} GB free</span>
      </div>
    </section>

    <section class="rounded-lg bg-[var(--surface)] p-4">
      <div class="mb-3 flex items-center gap-2">
        <MonitorCheck class="h-4 w-4 text-[var(--text-muted)]" />
        <h4 class="text-base font-medium text-[var(--text)]">GPU / Accelerator</h4>
      </div>
      {#if hw.vram_gb > 0}
        <div class="space-y-1.5 text-sm">
          {#if hw.gpu_name}
            <div class="flex justify-between gap-6 border-b border-[var(--border)] pb-2">
              <span class="text-[var(--text-muted)]">Model</span>
              <span class="max-w-[60%] truncate text-right font-medium text-[var(--text)]">{hw.gpu_name}</span>
            </div>
          {/if}
          <div class="flex justify-between gap-6 border-b border-[var(--border)] py-2">
            <span class="text-[var(--text-muted)]">VRAM</span>
            <span class="font-medium text-[var(--text)]">{hw.vram_gb.toFixed(1)} GB</span>
          </div>
          <div class="flex justify-between gap-6 pt-2">
            <span class="text-[var(--text-muted)]">Backend</span>
            <span class="inline-flex items-center rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">{hardwareStore.backendLabel}</span>
          </div>
        </div>
      {:else}
        <p class="text-sm text-[var(--text-muted)]">No GPU detected - models will run on CPU only.</p>
      {/if}
    </section>

    <section class="rounded-lg bg-[var(--surface)] p-4">
      <h4 class="mb-3 text-base font-medium text-[var(--text)]">Model compatibility guide</h4>
      <div class="space-y-2 text-sm">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">VRAM</span>
          <span class="text-[var(--text-tertiary)]">Model fits entirely in GPU VRAM - fastest inference</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center rounded-full bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning">Partial</span>
          <span class="text-[var(--text-tertiary)]">Partial GPU offload - some layers on CPU RAM</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center rounded-full bg-error-bg px-2 py-0.5 text-xs font-semibold text-error">RAM only</span>
          <span class="text-[var(--text-tertiary)]">No GPU offload - CPU only, slower inference</span>
        </div>
      </div>
    </section>
  {/if}
</div>
