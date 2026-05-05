export function normalizeStreamingContentDelta(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n');
}

export function normalizeStreamingReasoningDelta(text: string): string {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*\|\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

type StreamDispatcherOptions = {
  onContent?: (value: string) => void;
  onReasoning?: (value: string) => void;
  delayMs?: number;
};

export function createBufferedStreamDispatcher(options: StreamDispatcherOptions) {
  const delayMs = Math.max(16, Number(options.delayMs || 50));
  let contentBuffer = '';
  let reasoningBuffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    if (reasoningBuffer) {
      const next = reasoningBuffer;
      reasoningBuffer = '';
      options.onReasoning?.(next);
    }

    if (contentBuffer) {
      const next = contentBuffer;
      contentBuffer = '';
      options.onContent?.(next);
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, delayMs);
  };

  return {
    pushContent(value: string) {
      const normalized = normalizeStreamingContentDelta(value);
      if (!normalized) return;
      contentBuffer += normalized;
      schedule();
    },
    pushReasoning(value: string) {
      const normalized = normalizeStreamingReasoningDelta(value);
      if (!normalized) return;
      reasoningBuffer += normalized;
      schedule();
    },
    flush,
    dispose() {
      flush();
    }
  };
}
