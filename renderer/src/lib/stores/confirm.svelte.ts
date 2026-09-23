type ConfirmOptions = {
  title: string;
  message: string;
  /** Optional list shown under the message (files a restore touches, …). */
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
};

class ConfirmStore {
  open = $state(false);
  options = $state<ConfirmOptions | null>(null);

  show(opts: ConfirmOptions) {
    // A second request replaces the first; the first counts as cancelled.
    if (this.options) this.options.onCancel?.();
    this.options = opts;
    this.open = true;
  }

  /** Promise form for guards: resolves true on confirm, false otherwise. */
  ask(opts: Omit<ConfirmOptions, 'onConfirm' | 'onCancel'>): Promise<boolean> {
    return new Promise((resolve) => {
      this.show({ ...opts, onConfirm: () => resolve(true), onCancel: () => resolve(false) });
    });
  }

  confirm() {
    const options = this.options;
    this.close();
    options?.onConfirm();
  }

  cancel() {
    const options = this.options;
    this.close();
    options?.onCancel?.();
  }

  close() {
    this.open = false;
    this.options = null;
  }
}

export const confirmStore = new ConfirmStore();
