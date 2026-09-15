/** Generated pages never inherit the app's origin, credentials or network access. */
export function artifactPreviewCsp(interactive = false): string {
  return [
    "default-src 'none'",
    `script-src ${interactive ? "'unsafe-inline' data:" : "'none'"}`,
    "style-src 'unsafe-inline' data:",
    'img-src data:',
    'font-src data:',
    'media-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');
}

export function protectedArtifactHtml(html: string, interactive = false): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${artifactPreviewCsp(interactive)}"><meta name="referrer" content="no-referrer">${html}`;
}
