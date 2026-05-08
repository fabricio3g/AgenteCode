export type ToolRuntimeResult = {
  success: boolean;
  error?: string;
};

export function isRetryableToolFailure(error?: string): boolean {
  const message = String(error || '').toLowerCase();
  if (!message) return false;
  if (
    message.includes('missing ') ||
    message.includes('not found') ||
    message.includes('already exists') ||
    message.includes('invalid ') ||
    message.includes('unsupported')
  ) {
    return false;
  }
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('temporar') ||
    message.includes('unavailable') ||
    message.includes('rate')
  );
}

export async function executeWithTimeoutAndRetries<T extends ToolRuntimeResult>(params: {
  name: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs: number;
  maxRetries: number;
  debug: boolean;
  onDebug: (enabled: boolean, message: string) => void;
  runTool: () => Promise<T>;
  makeFailure: (message: string) => T;
  toErrorMessage: (err: unknown) => string;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => { if (timeoutId) clearTimeout(timeoutId); };

  const toolArgsStr = JSON.stringify(params.args).slice(0, 120);
  const startedAt = performance.now();

  for (let attempt = 1; attempt <= params.maxRetries + 1; attempt++) {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tool "${params.name}" timed out after ${params.timeoutMs / 1000}s`));
      }, params.timeoutMs);
    });

    params.signal?.addEventListener?.('abort', onAbort, { once: true });

    params.onDebug(params.debug, `[agent] tool START | name=${params.name} | args=${toolArgsStr} | attempt=${attempt}`);
    try {
      const result = await Promise.race([params.runTool(), timeoutPromise]);
      const duration = Math.round(performance.now() - startedAt);
      if (result.success) {
        params.onDebug(params.debug, `[agent] tool DONE | name=${params.name} | success=true | duration=${duration}ms`);
        return result;
      }
      if (!isRetryableToolFailure(result.error) || attempt > params.maxRetries) {
        params.onDebug(params.debug, `[agent] tool FAIL | name=${params.name} | attempt=${attempt} | error=${(result.error || '').slice(0, 100)}`);
        return result;
      }
      params.onDebug(params.debug, `[agent] tool RETRY | name=${params.name} | attempt=${attempt}/${params.maxRetries} | error=${(result.error || '').slice(0, 100)}`);
    } catch (err: unknown) {
      const msg = params.toErrorMessage(err);
      const duration = Math.round(performance.now() - startedAt);
      if (msg.includes('timed out')) {
        params.onDebug(params.debug, `[agent] tool TIMEOUT | name=${params.name} | duration=${duration}ms | attempt=${attempt}`);
      }
      if (!isRetryableToolFailure(msg) || attempt > params.maxRetries) return params.makeFailure(msg);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      params.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  return params.makeFailure('Tool execution failed after retries');
}
