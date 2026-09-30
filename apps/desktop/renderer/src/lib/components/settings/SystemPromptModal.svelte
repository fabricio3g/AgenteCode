<svelte:options runes={true} />

<script lang="ts">
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { Brain, Cpu, MessageSquareText, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { APP_SYSTEM_PROMPT_DEFAULT } from '$lib/app-meta';

  let systemPrompt = $state(appStore.config.llm?.system_prompt || '');
  let localSystemPrompt = $state(appStore.config.llm?.local?.system_prompt || appStore.config.llm?.system_prompt || '');
  let userPrompt = $state(appStore.config.llm?.user_prompt || '');
  let saving = $state(false);
  const guard = dirtyGuard(() => [systemPrompt, localSystemPrompt, userPrompt]);
  const requestClose = () => guard.close(() => (appStore.promptConfigOpen = false));

  const isLocal = $derived(appStore.backendMode === 'local');

  async function save() {
    saving = true;
    try {
      await appStore.updatePromptSettings({
        system_prompt: systemPrompt,
        user_prompt: isLocal ? undefined : userPrompt,
        local_system_prompt: localSystemPrompt
      });
      appStore.promptConfigOpen = false;
    } finally {
      saving = false;
    }
  }
</script>

<div
  class="ui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: () => requestClose() }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) requestClose();
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="ui-modal-surface max-w-2xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="flex items-center gap-2.5 min-w-0">
        {#if isLocal}
          <Cpu class="size-4 shrink-0 text-muted-foreground" />
        {:else}
          <Brain class="size-4 shrink-0 text-muted-foreground" />
        {/if}
        <div class="min-w-0">
          <div class="ui-modal-title">{isLocal ? 'Local system prompt' : 'API system prompt'}</div>
          <div class="text-xs text-muted-foreground">
            {isLocal ? 'Used for local runtime conversations.' : 'Used for API-provider conversations.'}
          </div>
        </div>
      </div>
      <button
        type="button"
        class="ui-icon-button"
        onclick={() => requestClose()}
        aria-label="Close prompt settings"
      >
        <X class="size-4" />
      </button>
    </div>

    <div class="ui-modal-body space-y-4">
      <label class="block space-y-2 text-sm">
        <span class="font-medium text-muted-foreground">{isLocal ? 'Fallback shared system prompt' : 'System prompt'}</span>
        <textarea
          bind:value={systemPrompt}
          rows="6"
          class="ui-input resize-y"
          placeholder={APP_SYSTEM_PROMPT_DEFAULT}
        ></textarea>
      </label>

      {#if isLocal}
        <label class="block space-y-2 text-sm">
          <span class="font-medium text-muted-foreground">Local runtime prompt</span>
          <textarea
            bind:value={localSystemPrompt}
            rows="6"
            class="ui-input resize-y"
            placeholder="Instructions specific to the local model."
          ></textarea>
        </label>
      {:else}
        <label class="block space-y-2 text-sm">
          <span class="flex items-center gap-2 font-medium text-muted-foreground">
            <MessageSquareText class="size-4" />
            User prompt prefix
          </span>
          <textarea
            bind:value={userPrompt}
            rows="4"
            class="ui-input resize-y"
            placeholder="Optional instruction prefix for API conversations."
          ></textarea>
        </label>
      {/if}
    </div>

    <div class="ui-modal-footer">
      <button type="button" class="ui-btn ui-btn-ghost" onclick={() => requestClose()}>
        Cancel
      </button>
      <button type="button" class="ui-btn ui-btn-primary" onclick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>
</div>
