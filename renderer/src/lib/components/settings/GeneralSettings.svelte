<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';

  let {
    showAssistantText = $bindable(),
    enableThinking = $bindable(),
    hfToken = $bindable(),
    onsaveHfToken,
  }: {
    showAssistantText: boolean;
    enableThinking: boolean;
    hfToken: string;
    onsaveHfToken: () => void;
  } = $props();

  let nameValue = $state(appStore.userName);
</script>

<div class="space-y-6">
  <div class="border-b border-[var(--border)] pb-6">
    <h3 class="mb-1 text-sm font-medium text-[var(--text)]">Your Name</h3>
    <p class="mb-3 text-xs text-[var(--text-tertiary)]">Shown on the welcome screen greeting.</p>
    <input
      type="text"
      bind:value={nameValue}
      oninput={() => appStore.setUserName(nameValue)}
      placeholder="Enter your name"
      class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border-strong)]"
    />
  </div>

  <div class="flex items-center justify-between py-2">
    <div>
      <div class="text-sm font-medium text-[var(--text-secondary)]">Show Assistant Text</div>
      <div class="text-xs text-[var(--text-tertiary)]">Display text responses from the assistant.</div>
    </div>
    <input type="checkbox" bind:checked={showAssistantText} />
  </div>

  <div class="flex items-center justify-between py-2">
    <div>
      <div class="text-sm font-medium text-[var(--text-secondary)]">Enable Thinking</div>
      <div class="text-xs text-[var(--text-tertiary)]">Reserve space for future reasoning display.</div>
    </div>
    <input type="checkbox" bind:checked={enableThinking} />
  </div>

  <div class="border-t border-[var(--border)] pt-6">
    <h3 class="mb-1 text-sm font-medium text-[var(--text)]">Hugging Face Access</h3>
    <p class="mb-4 text-xs text-[var(--text-tertiary)]">Needed only for gated or private model downloads.</p>
    <label class="mb-2 block text-sm text-[var(--text-secondary)]" for="hf-access-token">Access Token</label>
    <div class="flex gap-2">
      <input
        id="hf-access-token"
        type="password"
        bind:value={hfToken}
        placeholder="hf_..."
        class="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors focus:border-[var(--border-strong)]"
      />
      <button
        class="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-fg)] transition hover:opacity-90"
        onclick={onsaveHfToken}
      >
        Save
      </button>
    </div>
  </div>
</div>
