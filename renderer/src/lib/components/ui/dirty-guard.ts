import { confirmStore } from '$lib/stores/confirm.svelte';
import { copy } from '$lib/copy';

/**
 * "Discard changes?" for editor dialogs.
 *
 * Snapshots the draft when the editor opens; closing asks only when the draft
 * differs from that snapshot, so an untouched editor still closes instantly.
 * Create it once at component init with a getter for the draft.
 */
export function dirtyGuard(snapshot: () => unknown) {
  const initial = JSON.stringify(snapshot());
  const isDirty = () => JSON.stringify(snapshot()) !== initial;
  const allowClose = async (): Promise<boolean> => {
    if (!isDirty()) return true;
    return confirmStore.ask({
      title: copy.confirm.discardChanges.title,
      message: copy.confirm.discardChanges.message,
      confirmLabel: copy.confirm.discardChanges.confirmLabel,
      danger: true
    });
  };
  return {
    isDirty,
    /** Resolves true when it is fine to close. */
    allowClose,
    /** Run `close` now, or after the user agrees to discard their edits. */
    close(close: () => void): void {
      void allowClose().then((ok) => {
        if (ok) close();
      });
    }
  };
}
