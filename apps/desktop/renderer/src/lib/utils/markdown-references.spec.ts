// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';
import { installReferenceIconFallback, referenceKind } from './markdown-references';
afterEach(()=>{document.body.innerHTML='';});
it('styles paths without styling commands, expressions, or ordinary words',()=>{
  expect(referenceKind('apps/desktop/')).toBe('folder');
  expect(referenceKind('src/App.svelte:12')).toBe('file');
  expect(referenceKind('settings.rs')).toBe('file');
  expect(referenceKind('height(x, z)')).toBeUndefined();
  expect(referenceKind('2/3')).toBeUndefined();
  expect(referenceKind('npm run build')).toBeUndefined();
  expect(renderMarkdown('Open `src/App.svelte` and `apps/desktop/`.')).toContain('class="inline-reference file-reference"');
});
it('decorates web links with their own favicon and preserves the original destination',()=>{
  const html=renderMarkdown('[Documentation](https://example.com/docs?q=one#part)',{cache:false});
  expect(html).toContain('href="https://example.com/docs?q=one#part"');
  expect(html).toContain('src="https://example.com/favicon.ico"');
  expect(html).toContain('referrerpolicy="no-referrer"');
  expect(html).not.toContain('google.com');
  expect(html).toContain('target="_blank"');
  expect(renderMarkdown('[Local page](http://localhost:5173)',{cache:false})).not.toContain('<img');
});
it('falls back to the page icon when a favicon fails, using one removable delegate',()=>{
  const remove=installReferenceIconFallback();
  document.body.innerHTML='<span class="link-site-icon"><img alt=""></span>';
  const image=document.querySelector('img')!;
  image.dispatchEvent(new Event('error'));
  expect(image.hidden).toBe(true);
  remove();
  image.hidden=false;
  image.dispatchEvent(new Event('error'));
  expect(image.hidden).toBe(false);
});
it('keeps script links and untrusted raw event handlers sanitized',()=>{
  const html=renderMarkdown('[Bad](javascript:alert(1)) <img src="x" onerror="alert(1)">',{cache:false});
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('onerror');
});
