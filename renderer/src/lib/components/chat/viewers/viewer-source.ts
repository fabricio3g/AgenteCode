/**
 * Shared source loading for the document viewers.
 *
 * Every viewer receives either a `data:` URL (attachments, which are held in
 * memory as base64) or a fetchable URL (files on disk served by the app). Each
 * viewer used to carry its own copy of this branch, differing only in the
 * wording of the two error messages.
 */

/** Read a viewer `src` into an ArrayBuffer, whether it is a data URL or a URL. */
export async function readArrayBuffer(source: string, label = 'document'): Promise<ArrayBuffer> {
  if (source.startsWith('data:')) {
    const commaIndex = source.indexOf(',');
    if (commaIndex < 0) throw new Error(`Invalid ${label} data URL`);

    const meta = source.slice(0, commaIndex);
    const payload = source.slice(commaIndex + 1);

    if (meta.includes(';base64')) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    return new TextEncoder().encode(decodeURIComponent(payload)).buffer;
  }

  const response = await fetch(source);
  if (!response.ok) throw new Error(`Unable to load ${label} (${response.status})`);
  return response.arrayBuffer();
}
