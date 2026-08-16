import { appStore } from '$lib/stores/app.svelte';
import {
  loadCodeProjectsFromDb,
  saveCodeProjectToDb,
  deleteCodeProjectFromDb
} from '$lib/utils/storage';
import { invoke } from '$lib/services/tauri';
import { createId } from '$lib/utils/id';
import type { ChatSession, CodeProject } from '$lib/types/chat';

/**
 * Agente Coding store.
 *
 * Owns everything specific to the Code tab's agent experience: the project
 * list, folder expansion, and which project a new conversation belongs to.
 * Chat storage stays in AppStore (chats ARE the persistence substrate), so
 * this store only reads `appStore.chats` and creates conversations through
 * `appStore.createChat` — no agent state leaks back into AppStore.
 */
class AgenteStore {
  projects = $state<CodeProject[]>([]);
  loading = $state(false);
  loaded = $state(false);
  /** Project folders expanded in the sidebar tree. */
  expandedProjects = $state<Record<string, boolean>>({});
  activeProjectId = $state<string | null>(null);

  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.projects = await loadCodeProjectsFromDb();
      this.loaded = true;
    } finally {
      this.loading = false;
    }
  }

  async addProject(): Promise<CodeProject | null> {
    const rootPath = (await invoke<string | null>('pick_workspace_folder')) || null;
    if (!rootPath) return null;
    const segments = rootPath.split(/[\\/]/).filter(Boolean);
    const project: CodeProject = {
      id: createId('proj'),
      rootPath,
      rootName: segments[segments.length - 1] || rootPath,
      icon: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await saveCodeProjectToDb(project);
    await this.load();
    this.activeProjectId = project.id;
    this.expandedProjects[project.id] = true;
    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    await deleteCodeProjectFromDb(projectId);
    await this.load();
    if (this.activeProjectId === projectId) this.activeProjectId = null;
  }

  toggleExpanded(projectId: string): void {
    this.expandedProjects[projectId] = !this.expandedProjects[projectId];
  }

  projectById(projectId: string | null): CodeProject | null {
    if (!projectId) return null;
    return this.projects.find((p) => p.id === projectId) ?? null;
  }

  /** Conversations linked to a project, newest activity first. */
  sessionsFor(projectId: string): ChatSession[] {
    return appStore.chats
      .filter((chat) => chat.projectId === projectId)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

  /** Every agente conversation, regardless of project. */
  get allSessions(): ChatSession[] {
    return appStore.chats
      .filter((chat) => !!chat.projectId)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  }

  /**
   * Create a fresh agente conversation inside a project. The chat is a normal
   * work-space session tagged with the project and the agente driver meta the
   * engine will attach to when it starts.
   */
  newConversation(project: CodeProject): ChatSession {
    const chat = appStore.createChat('work');
    chat.projectId = project.id;
    chat.codeAgent = {
      instanceId: 'agente',
      driverKind: 'agente',
      substrate: 'native',
      runtimeMode: 'supervised',
      updatedAt: Date.now()
    };
    this.activeProjectId = project.id;
    this.expandedProjects[project.id] = true;
    appStore.persist();
    return chat;
  }

  openConversation(chatId: string): void {
    const chat = appStore.chats.find((c) => c.id === chatId);
    if (chat?.projectId) this.activeProjectId = chat.projectId;
    appStore.selectChat(chatId);
  }
}

export const agenteStore = new AgenteStore();
