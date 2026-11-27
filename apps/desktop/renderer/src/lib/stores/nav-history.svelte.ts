// The window's Back / Forward, like a browser tab's. AppShell records where the
// window is after every change (`record`); the top bar's arrows, Alt+←/→
// (⌘[ / ⌘] on macOS) and the mouse's side buttons step through it. The rules
// live in `utils/nav-history.ts`; this file only reads and drives the app.

import { appStore } from './app.svelte';
import { EMPTY_NAV, canStep, settle, step, visit, type NavLocation, type NavState } from '$lib/utils/nav-history';

class NavHistoryStore {
  state = $state<NavState>(EMPTY_NAV);
  /** A Back/Forward is landing: the next record corrects its entry instead of adding one. */
  private restoring = false;

  get canBack(): boolean {
    return canStep(this.state, -1);
  }

  get canForward(): boolean {
    return canStep(this.state, 1);
  }

  /** Where the window is now. Reading it inside an effect subscribes to every part. */
  current(): NavLocation {
    return {
      space: appStore.activeSpace,
      chatId: appStore.currentChatId,
      view: appStore.homeView,
      artifactKey: appStore.homeView === 'artifacts' ? appStore.artifactScreenKey : null,
      settings: appStore.settingsScreenOpen
    };
  }

  record(location: NavLocation): void {
    if (this.restoring) {
      this.restoring = false;
      this.state = settle(this.state, location);
      return;
    }
    this.state = visit(this.state, location);
  }

  back(): void {
    this.go(-1);
  }

  forward(): void {
    this.go(1);
  }

  private go(delta: -1 | 1): void {
    if (!canStep(this.state, delta)) return;
    this.state = step(this.state, delta);
    this.restoring = true;
    apply(this.state.entries[this.state.index]);
    // Nothing changed (the place was already on screen): no record will come.
    setTimeout(() => (this.restoring = false), 0);
  }
}

/** Put the window back where an entry says: the place underneath first, then Settings over it. */
function apply(location: NavLocation): void {
  if (location.chatId && appStore.chats.some((chat) => chat.id === location.chatId)) appStore.selectChat(location.chatId);
  else appStore.setActiveSpace(location.space);

  if (location.view === 'files') appStore.showFileLibrary();
  else if (location.view === 'calendar') appStore.showCalendar();
  else if (location.view === 'complements') appStore.showComplements();
  else if (location.view === 'artifacts') {
    appStore.showArtifactLibrary();
    appStore.artifactScreenKey = location.artifactKey;
  }

  if (location.settings) appStore.openSettings();
  else appStore.closeSettings();
}

export const navHistory = new NavHistoryStore();
