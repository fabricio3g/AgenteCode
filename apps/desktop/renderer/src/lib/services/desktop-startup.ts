import { invoke, isElectron } from './bridge';

/** Called after the shell mounts; a successful real IPC round trip is required. */
export async function notifyDesktopReady(): Promise<void> {
  if (!isElectron()) return;
  await invoke('get_config');
  let worker = false;
  if (new URLSearchParams(location.search).has('smoke')) {
    console.log('[smoke] Configuration IPC succeeded; checking editor worker');
    const monaco = await import('monaco-editor');
    const model = monaco.editor.createModel('const answer: number = 42;', 'typescript');
    try {
      // Creating a model activates the language asynchronously. Wait for that
      // registration; a worker/network failure still fails the smoke test.
      const deadline = Date.now() + 3000;
      const getWorker = await (async () => {
        for (;;) {
          try { return await monaco.typescript.getTypeScriptWorker(); }
          catch (error) {
            if (String(error) !== 'TypeScript not registered!' || Date.now() >= deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      })();
      const client = await getWorker(model.uri);
      await client.getSyntacticDiagnostics(model.uri.toString());
      worker = true;
      console.log('[smoke] Editor worker succeeded');
    } finally { model.dispose(); }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }
  await invoke('desktop_renderer_ready', { worker });
  document.documentElement.dataset.desktopReady = 'true';
}
