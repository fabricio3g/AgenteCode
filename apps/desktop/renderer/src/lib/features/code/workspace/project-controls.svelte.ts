// Whether the session column (project, git, context, tasks, subagents,
// scripts) shows beside a Code conversation. One switch for every Code
// conversation, remembered across launches and open by default: it is a place
// you keep open or keep closed, not a menu you dip into. Mod+Alt+0 flips it;
// the listener lives here, once, so two split panes cannot each flip it and
// cancel out.

const KEY = 'agente.projectControls.open';

function read(): boolean {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}

class ProjectControlsState {
  open = $state(read());

  set(open: boolean) {
    this.open = open;
    try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* Session-only. */ }
  }

  toggle() {
    this.set(!this.open);
  }
}

export const projectControls = new ProjectControlsState();

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey || event.code !== 'Digit0') return;
    // Only where a Code conversation is on screen.
    if (!document.querySelector('[data-conversation-workspace]')) return;
    event.preventDefault();
    projectControls.toggle();
  });
}
