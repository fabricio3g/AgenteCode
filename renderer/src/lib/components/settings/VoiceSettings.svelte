<svelte:options runes={true} />

<script lang="ts">
  import { Cpu, MemoryStick, MonitorCheck, RefreshCw, LoaderCircle } from 'lucide-svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
</script>

<div class="space-y-5">
  <!-- Refresh button -->
  <div class="flex items-center justify-between">
    <p class="text-sm text-[var(--text-tertiary)]">Detected system hardware and memory usage.</p>
    <button
      class="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]"
      onclick={() => void hardwareStore.refresh()}
    >
      <RefreshCw class={`h-3.5 w-3.5 ${hardwareStore.loading ? 'animate-spin' : ''}`} />Refresh
    </button>
  </div>

  {#if hardwareStore.loading && !hardwareStore.info}
    <div class="flex items-center gap-2 text-sm text-[var(--text-muted)]">
      <LoaderCircle class="h-4 w-4 animate-spin" />Detecting hardware…
    </div>
  {:else if hardwareStore.error}
    <div class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800/30 dark:bg-red-900/10 dark:text-red-400">
      {hardwareStore.error}
    </div>
  {:else if !hardwareStore.info}
    <div class="rounded-lg border border-[var(--border)] p-4 text-sm text-[var(--text-tertiary)]">Hardware info not available in browser mode.</div>
  {:else}
    {@const hw = hardwareStore.info}

    <!-- CPU Section -->
    <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
      <div class="mb-3 flex items-center gap-2">
        <Cpu class="h-4 w-4 text-[var(--text-muted)]" />
        <span class="text-sm font-semibold text-[var(--text-secondary)]">CPU</span>
      </div>
      <div class="space-y-1.5 text-[13px]">
        {#if hw.cpu_model}
          <div class="flex justify-between">
            <span class="text-[var(--text-muted)]">Model</span>
            <span class="max-w-[60%] truncate text-right font-medium text-[var(--text-secondary)]">{hw.cpu_model}</span>
          </div>
        {/if}
        <div class="flex justify-between">
          <span class="text-[var(--text-muted)]">Physical cores</span>
          <span class="font-medium text-[var(--text-secondary)]">{hw.physical_cores}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[var(--text-muted)]">Threads</span>
          <span class="font-medium text-[var(--text-secondary)]">{hw.cpu_threads}</span>
        </div>
      </div>
    </div>

    <!-- RAM Section -->
    <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
      <div class="mb-3 flex items-center gap-2">
        <MemoryStick class="h-4 w-4 text-[var(--text-muted)]" />
        <span class="text-sm font-semibold text-[var(--text-secondary)]">RAM</span>
        <span class="ml-auto text-[13px] font-medium tabular-nums text-[var(--text-secondary)]">
          {hardwareStore.ramUsedGb.toFixed(1)} / {hw.total_ram_gb.toFixed(0)} GB used
        </span>
      </div>
      <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-secondary)]">
        <div
          class={`h-full rounded-full transition-all ${hardwareStore.ramUsedPercent > 85 ? 'bg-red-500' : hardwareStore.ramUsedPercent > 65 ? 'bg-amber-500' : 'bg-emerald-500'}`}
          style="width:{Math.min(100, hardwareStore.ramUsedPercent)}%"
        ></div>
      </div>
      <div class="mt-1 flex justify-between text-[11px] text-[var(--text-muted)]">
        <span>{hardwareStore.ramUsedPercent}% used</span>
        <span>{hw.free_ram_gb.toFixed(1)} GB free</span>
      </div>
    </div>

    <!-- GPU Section -->
    <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
      <div class="mb-3 flex items-center gap-2">
        <MonitorCheck class="h-4 w-4 text-[var(--text-muted)]" />
        <span class="text-sm font-semibold text-[var(--text-secondary)]">GPU / Accelerator</span>
      </div>
      {#if hw.vram_gb > 0}
        <div class="space-y-1.5 text-[13px]">
          {#if hw.gpu_name}
            <div class="flex justify-between">
              <span class="text-[var(--text-muted)]">Model</span>
              <span class="max-w-[60%] truncate text-right font-medium text-[var(--text-secondary)]">{hw.gpu_name}</span>
            </div>
          {/if}
          <div class="flex justify-between">
            <span class="text-[var(--text-muted)]">VRAM</span>
            <span class="font-medium text-[var(--text-secondary)]">{hw.vram_gb.toFixed(1)} GB</span>
          </div>
          <div class="flex justify-between">
            <span class="text-[var(--text-muted)]">Backend</span>
            <span class="inline-flex items-center rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">{hardwareStore.backendLabel}</span>
          </div>
        </div>
      {:else}
        <p class="text-[13px] text-[var(--text-muted)]">No GPU detected — models will run on CPU only.</p>
      {/if}
    </div>

    <!-- Model compatibility legend -->
    <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
      <p class="mb-2 text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Model compatibility guide</p>
      <div class="space-y-2 text-[13px]">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">VRAM</span>
          <span class="text-[var(--text-tertiary)]">Model fits entirely in GPU VRAM — fastest inference</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">Partial</span>
          <span class="text-[var(--text-tertiary)]">Partial GPU offload — some layers on CPU RAM</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400">RAM only</span>
          <span class="text-[var(--text-tertiary)]">No GPU offload — CPU only, slower inference</span>
        </div>
      </div>
    </div>
  {/if}
</div>
