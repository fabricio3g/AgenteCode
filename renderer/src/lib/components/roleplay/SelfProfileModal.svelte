<svelte:options runes={true} />

<script lang="ts">
  import { X } from 'lucide-svelte';
  import type { RoleplaySelfProfile } from '$lib/types/roleplay';

  let {
    profile,
    onSave,
    onApplySpeaker,
    onLoadIntoCast,
    onReset,
    onClose
  }: {
    profile: RoleplaySelfProfile;
    onSave: (nextProfile: RoleplaySelfProfile) => void;
    onApplySpeaker: () => void;
    onLoadIntoCast: () => void;
    onReset: () => void;
    onClose: () => void;
  } = $props();

  let name = $state('User');
  let description = $state('');
  let avatarDataUrl = $state('');
  let tags = $state('');
  let notes = $state('');

  $effect(() => {
    name = profile.name || 'User';
    description = profile.description || '';
    avatarDataUrl = profile.avatarDataUrl || '';
    tags = (profile.tags || []).join(', ');
    notes = profile.notes || '';
  });

  function buildNextProfile(): RoleplaySelfProfile {
    return {
      name: name.trim() || 'User',
      description,
      avatarDataUrl: avatarDataUrl.trim() || undefined,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      notes
    };
  }

  function save() {
    onSave(buildNextProfile());
  }

  function applySpeaker() {
    onSave(buildNextProfile());
    onApplySpeaker();
  }

  function loadIntoCast() {
    onSave(buildNextProfile());
    onLoadIntoCast();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-[260] flex items-center justify-center bg-overlay p-4" role="dialog" aria-modal="true" tabindex="-1" onclick={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <section class="w-full max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl" onclick={(event) => event.stopPropagation()}>
    <header class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
      <div>
        <h2 class="text-sm font-semibold text-[var(--text)]">Self Profile</h2>
        <p class="text-xs text-[var(--text-muted)]">Roleplay speaker identity and optional cast profile data.</p>
      </div>
      <button class="icon-btn" aria-label="Close" onclick={onClose}>
        <X class="h-4 w-4" />
      </button>
    </header>

    <div class="grid gap-3 p-4">
      <label class="label">Name<input class="field" bind:value={name} /></label>
      <label class="label">Description<textarea class="field area" bind:value={description}></textarea></label>
      <label class="label">Avatar URL or data URL<input class="field" bind:value={avatarDataUrl} placeholder="https://... or data:image/..." /></label>
      <label class="label">Tags (comma separated)<input class="field" bind:value={tags} /></label>
      <label class="label">Notes<textarea class="field area" bind:value={notes}></textarea></label>
    </div>

    <footer class="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3">
      <button class="danger-btn px-3 py-2 text-sm" onclick={onReset}>Reset</button>
      <div class="flex flex-wrap items-center gap-2">
        <button class="action-btn px-3 py-2 text-sm" onclick={applySpeaker}>Apply to scene speaker</button>
        <button class="action-btn px-3 py-2 text-sm" onclick={loadIntoCast}>Load Self into cast</button>
        <button class="action-btn px-3 py-2 text-sm" onclick={save}>Save</button>
      </div>
    </footer>
  </section>
</div>

<style>
  .icon-btn, .action-btn, .danger-btn {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
  }
  .icon-btn {
    display: inline-flex;
    height: 32px;
    width: 32px;
    align-items: center;
    justify-content: center;
  }
  .action-btn:hover, .icon-btn:hover {
    background: var(--surface-hover);
  }
  .danger-btn {
    color: var(--error);
  }
  .danger-btn:hover {
    background: var(--error-bg);
    border-color: var(--error-border);
  }
  .label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .field {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    padding: 0.5rem 0.65rem;
    font-size: 0.875rem;
    outline: none;
  }
  .field:focus {
    border-color: var(--border-active);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .area {
    min-height: 88px;
    resize: vertical;
  }
</style>
