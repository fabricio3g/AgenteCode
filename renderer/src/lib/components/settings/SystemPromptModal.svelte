<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { Brain, Cpu, MessageSquareText, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { APP_SYSTEM_PROMPT_DEFAULT } from '$lib/app-meta';

  let systemPrompt = $state(appStore.config.llm?.system_prompt || '');
  let localSystemPrompt = $state(appStore.config.llm?.local?.system_prompt || appStore.config.llm?.system_prompt || '');
  let userPrompt = $state(appStore.config.llm?.user_prompt || '');
  let saving = $state(false);

  const isLocal = $derived(appStore.backendMode === 'local');

  async function save() {
    saving = true;
    try {
      await appStore.updatePromptSettings({
        system_prompt: isLocal ? systemPrompt : systemPrompt,
        user_prompt: isLocal ? undefined : userPrompt,
        local_system_prompt: localSystemPrompt
      });
      appStore.promptConfigOpen = false;
    } finally {
      saving = false;
    }
  }
</script>

<div   class="modal-backdrop fixed inset-0 z-[61] flex items-center justify-center bg-overlay px-4" role="dialog" aria-modal="true" transition:fade={{ duration: 150}}>
 <div class="modal-surface w-full max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl" transition:flyAndScale={{ y: -12, start: 0.96, duration: 200}}>
 <div class="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
 <div class="flex items-center gap-2">
 {#if isLocal}
 <Cpu class="h-4 w-4" />
 {:else}
 <Brain class="h-4 w-4" />
 {/if}
 <div>
 <div class="text-base font-semibold text-[var(--text)] font-serif tracking-tight">{isLocal ? 'Local system prompt' : 'API system prompt'}</div>
 <div class="text-xs text-[var(--text-tertiary)]">{isLocal ? 'Used for local runtime conversations.' : 'Used for API-provider conversations.'}</div>
 </div>
 </div>
 <button class="rounded-lg p-2 text-[var(--text-muted)] border border-transparent transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] hover:border-[var(--border)]" onclick={() => (appStore.promptConfigOpen = false)} aria-label="Close prompt settings">
 <X class="h-4 w-4" />
 </button>
 </div>

 <div class="space-y-4 p-5">
 <label class="block space-y-2 text-sm">
 <span class="font-medium text-[var(--text-secondary)]">{isLocal ? 'Fallback shared system prompt' : 'System prompt'}</span>
   <textarea bind:value={systemPrompt} rows="6" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" placeholder={APP_SYSTEM_PROMPT_DEFAULT}></textarea>
 </label>

 {#if isLocal}
 <label class="block space-y-2 text-sm">
 <span class="font-medium text-[var(--text-secondary)]">Local runtime prompt</span>
 <textarea bind:value={localSystemPrompt} rows="6" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" placeholder="Instructions specific to the local model."></textarea>
 </label>
 {:else}
 <label class="block space-y-2 text-sm">
 <span class="flex items-center gap-2 font-medium text-[var(--text-secondary)]">
 <MessageSquareText class="h-4 w-4" />
 User prompt prefix
 </span>
 <textarea bind:value={userPrompt} rows="4" class="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 outline-none transition text-[var(--text)] focus:border-[var(--border-hover)]" placeholder="Optional instruction prefix for API conversations."></textarea>
 </label>
 {/if}
 </div>

 <div class="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
 <button class="rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] hover:border-[var(--border-hover)]" onclick={() => (appStore.promptConfigOpen = false)}>
 Cancel
 </button>
 <button class="rounded-lg border border-[var(--border-hover)] bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-fg)] transition hover:opacity-88 active:scale-[0.98] disabled:opacity-50" onclick={save} disabled={saving}>
 {saving ? 'Saving…' : 'Save'}
 </button>
 </div>
 </div>
</div>
