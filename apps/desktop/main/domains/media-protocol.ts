import { protocol } from 'electron';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { domainService } from './desktop.ts';

export function registerDomainScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'agente-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}
export function registerDomainMediaProtocol(): void {
  protocol.handle('agente-media', async request => {
    try {
      const url = new URL(request.url); const id = decodeURIComponent(url.pathname.slice(1));
      if (url.hostname !== 'asset') return new Response('Invalid media reference', { status: 400 });
      const asset = await domainService().store.getAsset(id); const size = fs.statSync(asset.path).size;
      const range = request.headers.get('range'); let start = 0; let end = Math.max(0, size - 1);
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      const headers = new Headers({ 'Content-Type': asset.mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'private, max-age=31536000, immutable' });
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      const body = request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(asset.path, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch { return new Response('Local media was not found', { status: 404 }); }
  });
}
