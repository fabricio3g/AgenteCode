import { appStore } from '$lib/stores/app.svelte';

/**
 * Drag-and-drop plus OCR progress for the composer.
 *
 * Two separate concerns share one class because they share one lifecycle: the
 * document-level drag listeners and the `ocr-progress` window event are
 * installed and torn down together, and both exist only to describe the state of
 * files on their way into a message.
 */

type OcrPhase = 'rendering' | 'recognizing' | 'done' | 'error';

interface OcrProgress {
  phase: OcrPhase;
  page: number;
  total: number;
}

/** How long the "ready" state lingers before the line disappears. */
const DONE_LINGER_MS = 900;
/** Debounce for window dragleave, which fires between every child element. */
const DRAG_LEAVE_GRACE_MS = 100;

export class ComposerAttachments {
  /** A file is over the composer itself. */
  dragOver = $state(false);
  /** A file is being dragged anywhere in the window. */
  windowDragActive = $state(false);

  private ocr = $state<OcrProgress | null>(null);
  private ocrHideTimer: ReturnType<typeof setTimeout> | null = null;
  private dragLeaveTimer: ReturnType<typeof setTimeout> | null = null;
  private dragDepth = 0;

  private clearDrag(): void {
    if (this.dragLeaveTimer) clearTimeout(this.dragLeaveTimer);
    this.dragLeaveTimer = null;
    this.dragDepth = 0;
    this.dragOver = false;
    this.windowDragActive = false;
  }

  /** Empty string when there is nothing to report. */
  get ocrLabel(): string {
    if (!this.ocr) return '';
    if (this.ocr.phase === 'done') return 'Document ready';

    const page = Math.max(0, this.ocr.page || 0);
    const total = Math.max(0, this.ocr.total || 0);
    const progress = total > 0 ? `${Math.min(page, total)}/${total}` : '…';
    return `Reading document ${progress}`;
  }

  get ocrSettled(): boolean {
    return this.ocr?.phase === 'done';
  }

  clearOcr(): void {
    if (this.ocrHideTimer) {
      clearTimeout(this.ocrHideTimer);
      this.ocrHideTimer = null;
    }
    this.ocr = null;
  }

  // ── Composer-local drag target ────────────────────────────────────────────

  handleDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragOver = true;
  }

  handleDragLeave(event: DragEvent): void {
    // Ignore moves between children of the drop zone.
    const related = event.relatedTarget as Node | null;
    const zone = event.currentTarget as HTMLElement;
    const bounds = zone.getBoundingClientRect();
    if (!related && event.clientX > bounds.left && event.clientX < bounds.right && event.clientY > bounds.top && event.clientY < bounds.bottom) return;
    if (!related || !zone.contains(related)) this.dragOver = false;
  }

  handleDrop(event: DragEvent): void {
    if (event.defaultPrevented) return;
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    this.clearDrag();
    if (files.length) void appStore.addFiles(files);
  }

  handlePaste(event: ClipboardEvent): void {
    if (event.defaultPrevented) return;
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    void appStore.addFiles(files);
  }

  async handleFileInput(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    this.clearOcr();
    await appStore.addFiles(files);
    input.value = '';
  }

  /** Install window-level listeners. Returns a teardown function. */
  listen(): () => void {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      this.dragDepth++;
      if (this.dragLeaveTimer) {
        clearTimeout(this.dragLeaveTimer);
        this.dragLeaveTimer = null;
      }
      this.windowDragActive = true;
    };

    const onDragLeave = () => {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth) return;
      if (this.dragLeaveTimer) clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = setTimeout(() => {
        this.clearDrag();
      }, DRAG_LEAVE_GRACE_MS);
    };

    const onDrop = (event: DragEvent) => {
      if (!event.defaultPrevented) this.handleDrop(event);
      this.clearDrag();
    };

    const onOcrProgress = (event: Event) => {
      const detail = (event as CustomEvent<Partial<OcrProgress>>).detail;
      if (!detail) return;

      if (this.ocrHideTimer) {
        clearTimeout(this.ocrHideTimer);
        this.ocrHideTimer = null;
      }

      const phase = detail.phase || 'recognizing';
      if (phase === 'error') { this.clearOcr(); return; }
      this.ocr = {
        phase,
        page: Number.isFinite(detail.page) ? Number(detail.page) : 0,
        total: Number.isFinite(detail.total) ? Number(detail.total) : 0
      };

      if (phase !== 'done') return;
      this.ocrHideTimer = setTimeout(() => {
        this.ocr = null;
        this.ocrHideTimer = null;
      }, DONE_LINGER_MS);
    };

    document.addEventListener('dragenter', onDragEnter);
    const preventNavigation = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (this.dragLeaveTimer) clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
      this.windowDragActive = true;
    };
    // Cleanup even when the canvas or composer owns the drop and stops bubbling.
    const resetDrag = () => this.clearDrag();
    document.addEventListener('drop', resetDrag, true);
    document.addEventListener('dragend', resetDrag);
    window.addEventListener('blur', resetDrag);
    document.addEventListener('dragover', preventNavigation);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    window.addEventListener('ocr-progress', onOcrProgress as EventListener);

    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', preventNavigation);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('drop', resetDrag, true);
      document.removeEventListener('dragend', resetDrag);
      window.removeEventListener('blur', resetDrag);
      window.removeEventListener('ocr-progress', onOcrProgress as EventListener);
      this.clearDrag();
      this.clearOcr();
    };
  }
}
