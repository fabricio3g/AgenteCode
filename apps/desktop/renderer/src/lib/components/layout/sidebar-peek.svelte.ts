// The collapsed sidebar's hover preview. Collapsed, the sidebar is gone;
// hovering its title-bar toggle shows it floating over the content (without
// moving anything), it stays while the pointer or keyboard is inside it, and
// closes a moment after they leave. Clicking the toggle pins it instead
// (AppShell), which moves the content over.

/** Hover this long on the toggle before the preview opens. */
export const PEEK_OPEN_MS = 120;
/** Leave for this long before it closes, so crossing a gap doesn't flicker. */
export const PEEK_CLOSE_MS = 180;
/** After a click on the toggle, ignore hover for this long. */
const TOGGLE_QUIET_MS = 250;

export class SidebarPeek {
  open = $state(false);
  /** The sidebar element (AppShell binds it). */
  panel: HTMLElement | undefined = undefined;

  #openTimer: ReturnType<typeof setTimeout> | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #pointerTarget: Node | null = null;
  #keyboard = false;
  #quietUntil = 0;

  constructor(
    /** Pinned open: no preview needed. */
    private readonly pinned: () => boolean,
    private readonly now: () => number = () => performance.now()
  ) {}

  clearTimers(): void {
    clearTimeout(this.#openTimer);
    clearTimeout(this.#closeTimer);
    this.#openTimer = this.#closeTimer = undefined;
  }

  close(): void {
    this.clearTimers();
    this.open = false;
  }

  /** The toggle was clicked: close the preview and ignore hover briefly. */
  toggled(): void {
    this.close();
    this.#quietUntil = this.now() + TOGGLE_QUIET_MS;
  }

  /** Inside the sidebar, on its toggle, or in a menu one of its buttons opened. */
  contains(target: Node | null): boolean {
    if (!target) return false;
    if (this.panel?.contains(target)) return true;
    if (target instanceof Element && target.closest('[data-sidebar-toggle]')) return true;
    // Menus are portalled: their trigger's aria-controls keeps the preview
    // alive while the pointer or keyboard moves into the floating panel.
    return [...(this.panel?.querySelectorAll('[aria-expanded="true"][aria-controls]') ?? [])].some((trigger) => {
      const controlled = document.getElementById(trigger.getAttribute('aria-controls')!);
      return !!controlled?.contains(target);
    });
  }

  keep(): void {
    clearTimeout(this.#closeTimer);
    this.#closeTimer = undefined;
  }

  /** Pointer on the toggle: open after a short hover. */
  show(): void {
    if (this.pinned() || this.now() < this.#quietUntil) return;
    this.keep();
    if (this.#openTimer || this.open) return;
    this.#openTimer = setTimeout(() => {
      this.#openTimer = undefined;
      this.open = true;
    }, PEEK_OPEN_MS);
  }

  scheduleClose(): void {
    clearTimeout(this.#openTimer);
    this.#openTimer = undefined;
    if (this.#closeTimer) return;
    this.#closeTimer = setTimeout(() => {
      this.#closeTimer = undefined;
      const focusInside = this.#keyboard && this.contains(document.activeElement);
      if (this.contains(this.#pointerTarget) || focusInside) return;
      this.open = false;
    }, PEEK_CLOSE_MS);
  }

  /** Pointer left the toggle. */
  leave(event: PointerEvent): void {
    this.#pointerTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (!this.contains(this.#pointerTarget)) this.scheduleClose();
  }

  /** While the preview is open, follow the pointer, clicks, focus and Escape. Returns the cleanup. */
  listen(onEscape: () => void): () => void {
    const move = (event: PointerEvent) => {
      this.#keyboard = false;
      this.#pointerTarget = event.target instanceof Node ? event.target : null;
      if (this.contains(this.#pointerTarget)) this.keep();
      else this.scheduleClose();
    };
    const press = (event: PointerEvent) => {
      this.#keyboard = false;
      if (!this.contains(event.target instanceof Node ? event.target : null)) this.close();
    };
    const key = (event: KeyboardEvent) => {
      this.#keyboard = true;
      if (event.key === 'Escape' && !document.querySelector('[role="menu"], [aria-modal="true"]')) {
        this.close();
        onEscape();
      }
    };
    const focus = (event: FocusEvent) => {
      if (this.contains(event.target instanceof Node ? event.target : null)) this.keep();
      else this.scheduleClose();
    };
    const blur = () => this.close();
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', focus);
      window.removeEventListener('blur', blur);
    };
  }
}
