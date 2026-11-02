import { describe, expect, it } from 'vitest';
import { imageFilesOf, isReferencePath, normalizeSiteUrl, referenceLabel, referencePaths } from './design-references';

describe('reference paths', () => {
  it('accepts images directly inside references/', () => {
    expect(isReferencePath('references/hero.png')).toBe(true);
    expect(isReferencePath('references/Shot.JPEG')).toBe(true);
    expect(isReferencePath('references/sub/hero.png')).toBe(false);
    expect(isReferencePath('assets/hero.png')).toBe(false);
    expect(isReferencePath('references/notes.md')).toBe(false);
  });
  it('lists and labels them', () => {
    expect(referencePaths(['index.html', 'references/b.png', 'references/a.webp', 'tokens.css'])).toEqual(['references/a.webp', 'references/b.png']);
    expect(referenceLabel('references/stripe-com-1.png')).toBe('stripe-com-1');
  });
});

describe('normalizeSiteUrl', () => {
  it('adds https to a bare domain', () => {
    expect(normalizeSiteUrl(' stripe.com ')).toBe('https://stripe.com/');
    expect(normalizeSiteUrl('linear.app/features')).toBe('https://linear.app/features');
  });
  it('keeps http(s) and refuses other schemes and non-addresses', () => {
    expect(normalizeSiteUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizeSiteUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeSiteUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeSiteUrl('localhost')).toBeNull();
    expect(normalizeSiteUrl('two words.com')).toBeNull();
    expect(normalizeSiteUrl('')).toBeNull();
  });
});

describe('imageFilesOf', () => {
  it('accepts OS image drops without MIME types and leaves other files alone', () => {
    expect(imageFilesOf([{type:'',name:'reference.PNG'},{type:'',name:'brief.pdf'},{type:'text/plain',name:'fake.png'}]).map(file => file.name)).toEqual(['reference.PNG']);
  });
  it('keeps the image types main accepts', () => {
    const files = [{ type: 'image/png' }, { type: 'image/svg+xml' }, { type: 'text/plain' }, { type: 'image/webp' }, { type: '' }];
    expect(imageFilesOf(files).map((file) => file.type)).toEqual(['image/png', 'image/webp']);
    expect(imageFilesOf(null)).toEqual([]);
  });
});
