import { describe, expect, it } from 'vitest';
import type { RequestMessage } from './chat-api';
import { referenceImages } from './design-references';

describe('referenceImages', () => {
  it('accepts raw image base64 as well as data URLs', () => {
    expect(referenceImages({ role: 'user', content: '', attachments: [{ kind: 'image', name: 'image.png', base64: 'aGVsbG8=' }] } as unknown as RequestMessage)).toEqual([{ name: 'image.png', data: 'aGVsbG8=' }]);
  });
  it('takes only the image attachments, as a name and the base64 payload', () => {
    const message = {
      role: 'user',
      content: 'Like this one',
      attachments: [
        { kind: 'image', name: 'hero.png', base64: 'data:image/png;base64,AAAA' },
        { kind: 'document', name: 'brief.pdf', base64: 'data:application/pdf;base64,JVBERi0=' },
        { kind: 'image', name: 'broken', base64: 'not a data url' }
      ]
    } as unknown as RequestMessage;
    expect(referenceImages(message)).toEqual([{ name: 'hero.png', data: 'AAAA' }]);
  });

  it('is empty without a message or attachments', () => {
    expect(referenceImages(undefined)).toEqual([]);
    expect(referenceImages({ role: 'user', content: 'hi' })).toEqual([]);
  });
});
