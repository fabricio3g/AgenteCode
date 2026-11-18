import { appStore } from '$lib/stores/app.svelte';
import { invoke } from '$lib/services/bridge';
import { createId } from '$lib/utils/id';
import type { ChatFolder, ChatSession } from '$lib/types/chat';

const KEY = 'agente.sidebarOrder';
const SIDEBAR_DRAG = 'application/x-agente-sidebar';
export type SidebarItem = { kind: 'project' | 'folder' | 'chat'; id: string; projectId?: string };
export const itemKey = (item: SidebarItem) => `${item.kind}:${item.id}`;
function ordered<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index })).sort((a, b) => (rank.get(a.item.id) ?? ids.length + a.index) - (rank.get(b.item.id) ?? ids.length + b.index)).map(({ item }) => item);
}
function read(): Record<string, string[]> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(id => typeof id === 'string')));
  } catch { return {}; }
}
export class SidebarOrganization {
  orders = $state(read());
  expanded = $state<Record<string, boolean>>({});
  dragging = $state<SidebarItem | null>(null);
  hover = $state('');
  creatingIn = $state<string | null>(null);
  list<T extends { id: string }>(group: string, items: T[]): T[] { return ordered(items, this.orders[group] ?? []); }
  reorder(group: string, ids: string[], id: string, before: string | null) {
    if (!ids.includes(id) || id === before) return;
    const next = ids.filter(entry => entry !== id);
    const index = before ? next.indexOf(before) : next.length;
    next.splice(index < 0 ? next.length : index, 0, id);
    this.orders[group] = next;
    try { localStorage.setItem(KEY, JSON.stringify(this.orders)); } catch { /* Session-only. */ }
  }
  move(group: string, ids: string[], id: string, direction: -1 | 1) {
    const index = ids.indexOf(id), target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    this.reorder(group, ids, id, direction < 0 ? ids[target] : ids[target + 1] ?? null);
  }
  start(event: DragEvent, item: SidebarItem) {
    if (!event.dataTransfer) return;
    this.dragging = item; event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(SIDEBAR_DRAG, JSON.stringify(item));
  }
  end() { this.dragging = null; this.hover = ''; }
  over(event: DragEvent, target: SidebarItem): boolean {
    const source = this.dragging;
    if (!source || source.id === target.id) return false;
    if (source.kind === 'project' ? target.kind !== 'project' : target.kind === 'project' ? source.projectId !== target.id : source.projectId !== target.projectId) return false;
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.hover = itemKey(target); return true;
  }
  folders(projectId: string): ChatFolder[] { return this.list(`folders:${projectId}`, appStore.folders.filter(folder => folder.parentId === projectId)); }
  async createFolder(projectId: string, name: string) {
    if (!name.trim()) return;
    const folder: ChatFolder = { id: createId('folder'), name: name.trim(), parentId: projectId, createdAt: Date.now() };
    await invoke('chat_db_save_folder', { folder }); appStore.folders.push(folder); this.expanded[folder.id] = true; appStore.persist({ navigationOnly: true });
  }
  async renameFolder(folder: ChatFolder, name: string) {
    if (!name.trim()) return;
    const next = { ...folder, name: name.trim() }; await invoke('chat_db_save_folder', { folder: next });
    appStore.folders = appStore.folders.map(item => item.id === folder.id ? next : item); appStore.persist({ navigationOnly: true });
  }
  async removeFolder(folder: ChatFolder) {
    for (const chat of appStore.chats.filter(chat => chat.folderId === folder.id)) this.moveChat(chat, null);
    await invoke('chat_db_delete_folder', { folderId: folder.id }); appStore.folders = appStore.folders.filter(item => item.id !== folder.id); appStore.persist({ navigationOnly: true });
  }
  moveChat(chat: ChatSession, folderId: string | null): boolean {
    if (folderId && !this.folders(chat.projectId ?? '').some(folder => folder.id === folderId)) return false;
    chat.folderId = folderId; appStore.markChatDirty(chat.id); appStore.persist();
    if (folderId) this.expanded[folderId] = true;
    return true;
  }
}
export const sidebarOrganization = new SidebarOrganization();
