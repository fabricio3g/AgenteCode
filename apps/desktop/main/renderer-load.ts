/** A crashed Chromium network service can reject the first development load. */
export async function loadDevelopmentRenderer(
  load: () => Promise<unknown>,
  closed: () => boolean,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<void> {
  const delays = [500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    if (closed()) return;
    try { await load(); return; }
    catch (error) {
      if (closed()) return;
      const message = error instanceof Error ? error.message : String(error);
      const transient = /\bERR_(FAILED|CONNECTION_REFUSED|CONNECTION_RESET|NETWORK_CHANGED|NAME_NOT_RESOLVED)\b/.test(message);
      if (!transient || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}
