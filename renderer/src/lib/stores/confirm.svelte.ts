type ConfirmOptions = {
  title: string;
  message: string;
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
    this.options = opts;
    this.open = true;
  }

  confirm() {
    this.options?.onConfirm();
    this.close();
  }

  cancel() {
    this.options?.onCancel?.();
    this.close();
  }

  close() {
    this.open = false;
    this.options = null;
  }
}

export const confirmStore = new ConfirmStore();
