<svelte:options runes={true} />

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Button, Dialog } from '$lib/components/ui';
  import { dirtyGuard } from '$lib/components/ui/dirty-guard';
  import { MessageSquareText } from 'lucide-svelte';
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

<Dialog
  size="lg"
  title={isLocal ? $t('promptSettings.localTitle') : $t('promptSettings.apiTitle')}
  description={isLocal ? $t('promptSettings.localDescription') : $t('promptSettings.apiDescription')}
  onclose={() => (appStore.promptConfigOpen = false)}
  beforeClose={guard.allowClose}
>
  <div class="space-y-4 px-4 py-4 sm:px-5">
    <label class="block space-y-1.5">
      <span class="text-[length:var(--text-xs)] font-medium text-muted-foreground">{isLocal ? $t('promptSettings.fallbackLabel') : $t('promptSettings.systemLabel')}</span>
      <textarea
        bind:value={systemPrompt}
        rows="6"
        class="ui-input resize-y text-[length:var(--text-sm)]"
        placeholder={APP_SYSTEM_PROMPT_DEFAULT}
      ></textarea>
    </label>

    {#if isLocal}
      <label class="block space-y-1.5">
        <span class="text-[length:var(--text-xs)] font-medium text-muted-foreground">{$t('promptSettings.localLabel')}</span>
        <textarea
          bind:value={localSystemPrompt}
          rows="6"
          class="ui-input resize-y text-[length:var(--text-sm)]"
          placeholder={$t('promptSettings.localPlaceholder')}
        ></textarea>
      </label>
    {:else}
      <label class="block space-y-1.5">
        <span class="flex items-center gap-1.5 text-[length:var(--text-xs)] font-medium text-muted-foreground">
          <MessageSquareText class="size-3.5" />
          {$t('promptSettings.userLabel')}
        </span>
        <textarea
          bind:value={userPrompt}
          rows="4"
          class="ui-input resize-y text-[length:var(--text-sm)]"
          placeholder={$t('promptSettings.userPlaceholder')}
        ></textarea>
      </label>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={() => requestClose()}>{$t('promptSettings.cancel')}</Button>
    <Button onclick={save} loading={saving} loadingLabel={$t('promptSettings.saving')}>{$t('promptSettings.save')}</Button>
  {/snippet}
</Dialog>
