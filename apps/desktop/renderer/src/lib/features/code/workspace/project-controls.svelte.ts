// Whether the floating project card is showing. One switch for every Code
// conversation, remembered across launches: it is a place you keep open or
// keep closed, not a menu you dip into.

const KEY = 'agente.projectControls.open';

function read(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
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
