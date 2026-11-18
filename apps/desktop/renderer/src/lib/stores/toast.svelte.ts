type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  /** One action beside the message, e.g. Undo. */
  action?: { label: string; run: () => void };
}

class ToastStore {
  toasts = $state<Toast[]>([]);

  private add(type: ToastType, message: string, duration = 3500) {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.toasts = [...this.toasts, { id, type, message, duration }];
    setTimeout(() => this.dismiss(id), duration);
  }

  success(message: string, duration?: number) {
    this.add('success', message, duration);
  }

  error(message: string, duration?: number) {
    this.add('error', message, duration);
  }

  info(message: string, duration?: number) {
    this.add('info', message, duration);
  }

  warning(message: string, duration?: number) {
    this.add('warning', message, duration);
  }

  /**
   * A done action that can still be taken back: the toast offers Undo for a
   * few seconds. `onundo` runs at most once, and never after the toast closes.
   */
  undoable(message: string, onundo: () => void, { label = 'Undo', duration = 6000 }: { label?: string; duration?: number } = {}) {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const run = () => {
      if (!this.toasts.some((t) => t.id === id)) return;
      this.dismiss(id);
      onundo();
    };
    this.toasts = [...this.toasts, { id, type: 'info', message, duration, action: { label, run } }];
    setTimeout(() => this.dismiss(id), duration);
  }

  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const toastStore = new ToastStore();
