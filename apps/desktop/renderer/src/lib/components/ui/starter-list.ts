/**
 * One row of a starter list. The shape is shared so the Code space's first
 * conversation and the Design dock's empty screen cannot drift apart, and so
 * nothing has to re-derive a label from a prompt fragment.
 */
import type { ComponentType } from 'svelte';
import type { Icon as LucideIcon } from 'lucide-svelte';

export interface Starter {
  /** Stable key: the consumer gets it back from `onpick`. */
  id: string;
  /** Hue that identifies the kind (oklch degrees), never emphasis. */
  hue: number;
  icon: StarterIcon;
  /** The action, imperative and complete — never a fragment. */
  label: string;
  /** What you get back, one line. */
  hint?: string;
  /**
   * What the prompt still needs, for rows whose prompt is only the start of a
   * sentence. A phrase, not a fragment of one — every locale words it its own
   * way, which is why the blank is never punctuation inside `label`.
   */
  slot?: string;
  /** The key that picks this row, e.g. `⌘⌥2`. */
  key?: string;
}

/** Icons come from lucide-svelte, which still ships legacy class components,
 *  so this is a `ComponentType` rather than the runes-mode `Component`. */
export type StarterIcon = ComponentType<LucideIcon>;
