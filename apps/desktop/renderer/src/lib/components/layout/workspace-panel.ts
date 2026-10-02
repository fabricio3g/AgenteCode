import type { Snippet } from 'svelte';
import type { Activity } from 'lucide-svelte';
import type { Rect, Region } from './workspace-layout';

export interface PanelRenderState { id: string; exposed: boolean; focused: boolean; rect: Rect }
export interface WorkspacePanel {
  id: string;
  title: string;
  icon: typeof Activity;
  content: Snippet<[PanelRenderState]>;
  region: Region;
  available: boolean;
  open: boolean;
  onhide: () => void;
  actions?: Array<{ label: string; run: () => void }>;
}
