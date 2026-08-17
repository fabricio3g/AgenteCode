import type { ComponentType } from 'svelte';
import type { Icon } from 'lucide-svelte';

/**
 * Icons come from lucide-svelte, which still ships legacy class components, so
 * this is a `ComponentType` rather than the runes-mode `Component`.
 */
export type IconComponent = ComponentType<Icon>;

/**
 * One action on a message's hover bar.
 *
 * The bar used to be written twice — once in the user branch and once in the
 * assistant branch of the same component — with the copy button, the overflow
 * wrapper, and the delete confirmation duplicated between them. Describing
 * actions as data means the bar is rendered once and the two roles differ only
 * in which descriptors they hand it.
 */
export interface MessageAction {
  id: string;
  label: string;
  icon: IconComponent;
  run: () => void;
  /** Inline on the bar rather than inside the overflow menu. */
  primary?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** Show a check for ~2s after running. Used by copy. */
  confirms?: boolean;
  /** Swapped in while the action is active, e.g. Listen → Stop. */
  activeLabel?: string;
  activeIcon?: IconComponent;
  active?: boolean;
}

/** Drop actions that don't apply, so call sites can use plain conditionals. */
export function compactActions(
  actions: Array<MessageAction | false | null | undefined>
): MessageAction[] {
  return actions.filter((action): action is MessageAction => !!action);
}
