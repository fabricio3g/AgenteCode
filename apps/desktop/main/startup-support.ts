/** No renderer bundle or preload is needed to show a load failure. */
export function startupErrorPage(logPath: string): string {
  const escaped = logPath.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  return `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Agente startup</title><style>body{font:16px system-ui;margin:48px;line-height:1.6}code{overflow-wrap:anywhere;font-size:13px}</style><main data-startup-error><h2>Agente could not start</h2><p>Please restart the app. If the problem continues, share the startup log:</p><code>${escaped}</code></main>`;
}
