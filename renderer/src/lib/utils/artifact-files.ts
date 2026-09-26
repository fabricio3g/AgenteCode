const DATA_URL_RE = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/s;

export function isHiddenArtifactFile(path: string): boolean {
  return path.startsWith('__');
}

export function isDataUrlFile(content: string): boolean {
  return DATA_URL_RE.test(content || '');
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const match = dataUrl.match(DATA_URL_RE);
  if (!match) return new TextEncoder().encode(dataUrl);
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function dataUrlMime(dataUrl: string): string {
  return dataUrl.match(DATA_URL_RE)?.[1] || 'application/octet-stream';
}

export function artifactFilePayload(content: string): string | Uint8Array {
  return isDataUrlFile(content) ? dataUrlToBytes(content) : content;
}

export function artifactFileBlob(content: string): Blob {
  if (isDataUrlFile(content)) {
    const bytes = dataUrlToBytes(content);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Blob([buffer], { type: dataUrlMime(content) });
  }
  return new Blob([content], { type: 'text/plain;charset=utf-8' });
}

export function viewerPathFor(path: string): string {
  return `__viewer__/${path}.html`;
}

/**
 * The structured input a generated binary was built from (deck, report,
 * workbook). Kept hidden next to the file so viewers and editors can work from
 * the spec instead of reverse-engineering the Office bytes.
 */
export function specPathFor(path: string): string {
  return `__spec__/${path}.json`;
}
