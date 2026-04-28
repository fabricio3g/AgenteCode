<svelte:options runes={true} />

<script lang="ts">
  import { Search, X } from 'lucide-svelte';

  interface Props {
    value: string;
    placeholder?: string;
    autofocus?: boolean;
    onchange?: (value: string) => void;
    onclear?: () => void;
  }

  let { value = $bindable(), placeholder = 'Search...', autofocus = false, onchange, onclear }: Props = $props();

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    value = target.value;
    onchange?.(value);
  }

  function handleClear() {
    value = '';
    onclear?.();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      handleClear();
    }
  }
</script>

<div class="relative w-full">
 <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
 <input
 type="text"
 {value}
 {placeholder}
 {autofocus}
 oninput={handleInput}
 onkeydown={handleKeydown}
 class="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-hover)] py-2.5 pl-10 pr-10 text-sm text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--border-hover)] focus:bg-[var(--surface)]"
 autocomplete="off"
 spellcheck="false"
 />
 {#if value}
 <button
 type="button"
 class="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
 onclick={handleClear}
 aria-label="Clear search"
 >
 <X class="h-3.5 w-3.5" />
 </button>
 {/if}
</div>
