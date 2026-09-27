import { describe, expect, it } from 'vitest';
import { documentSource, pickDocumentViewer } from './document-viewer';

const XLSX = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBA==';
const DOCX = 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA==';

describe('pickDocumentViewer', () => {
  it('prefers the native viewer over the generated HTML fallback', () => {
    expect(pickDocumentViewer({ id: 'a', name: 'data.xlsx', dataUrl: XLSX, previewHtml: '<table></table>' })).toBe('xlsx');
    expect(pickDocumentViewer({ id: 'b', name: 'brief.docx', dataUrl: DOCX, previewHtml: '<p>x</p>' })).toBe('docx');
  });

  it('renders markdown and plain-text research files from their text', () => {
    expect(pickDocumentViewer({ id: 'c', name: 'report.md', content: '# Hi' })).toBe('markdown');
    expect(pickDocumentViewer({ id: 'd', name: 'refs.bib', content: '@article{x}' })).toBe('text');
    expect(pickDocumentViewer({ id: 'e', name: 'matrix.csv', content: 'a,b\n1,2' })).toBe('text');
  });

  it('draws a real pptx from its bytes, the saved outline only without them', () => {
    expect(pickDocumentViewer({ id: 'g', name: 'deck.pptx', dataUrl: 'data:x;base64,AA==', previewHtml: '<div></div>', kind: 'slides', slides: [{ title: 'One', content: [], layout: 'bullets' }] })).toBe('pptx');
    expect(pickDocumentViewer({ id: 'f', name: 'deck.pptx', kind: 'slides', slides: [{ title: 'One', content: [], layout: 'bullets' }] })).toBe('slides');
    expect(pickDocumentViewer({ id: 'h', name: 'deck.pptx', previewHtml: '<div></div>' })).toBe('html');
    expect(pickDocumentViewer({ id: 'i', name: 'deck.pptx' })).toBe('pptx-missing');
  });

  it('turns text content into a data URL', () => {
    expect(documentSource({ id: 'i', name: 'notes.txt', content: 'ñ' })).toBe('data:text/plain;charset=utf-8;base64,w7E=');
  });
});
