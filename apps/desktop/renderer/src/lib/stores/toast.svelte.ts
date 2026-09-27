export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
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

  dismiss(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const toastStore = new ToastStore();
