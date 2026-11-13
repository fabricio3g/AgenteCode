import { describe, expect, it } from 'vitest';
import { fileAccent, getFileIcon } from './doc-utils';
import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileText,
  Presentation
} from '$lib/icons';

describe('getFileIcon', () => {
  it('maps office documents to their kind icon', () => {
    expect(getFileIcon('report.docx')).toBe(FileText);
    expect(getFileIcon('data.xlsx')).toBe(FileSpreadsheet);
    expect(getFileIcon('data.csv')).toBe(FileSpreadsheet);
    expect(getFileIcon('deck.pptx')).toBe(Presentation);
    expect(getFileIcon('paper.pdf')).toBe(FileText);
  });

  it('maps code, archives and media off the generic file', () => {
    expect(getFileIcon('app.ts')).toBe(FileCode);
    expect(getFileIcon('payload.json')).toBe(FileCode);
    expect(getFileIcon('backup.zip')).toBe(FileArchive);
    expect(getFileIcon('photo.png')).toBe(FileImage);
    expect(getFileIcon('track.mp3')).toBe(FileMusic);
    expect(getFileIcon('clip.mp4')).toBe(FilePlay);
  });

  it('falls back to the generic file for the unknown', () => {
    expect(getFileIcon('blob')).toBe(File);
    expect(getFileIcon('data.unknownext')).toBe(File);
    expect(getFileIcon('notes.txt')).toBe(FileText);
    expect(getFileIcon('')).toBe(File);
  });
});

describe('fileAccent', () => {
  it('groups accents like the artifact cards', () => {
    expect(fileAccent('report.docx')).toBe('var(--chart-1)');
    expect(fileAccent('paper.pdf')).toBe('var(--accent-red)');
    expect(fileAccent('data.xlsx')).toBe('var(--accent-green)');
    expect(fileAccent('deck.pptx')).toBe('var(--accent-amber)');
  });

  it('sends code, markup, media and archives to their hues', () => {
    expect(fileAccent('app.ts')).toBe('var(--accent-sky)');
    expect(fileAccent('page.html')).toBe('var(--accent-sky)');
    expect(fileAccent('photo.png')).toBe('var(--accent-violet)');
    expect(fileAccent('backup.zip')).toBe('var(--accent-violet)');
  });

  it('defaults to the document blue', () => {
    expect(fileAccent('notes.txt')).toBe('var(--chart-1)');
    expect(fileAccent('blob')).toBe('var(--chart-1)');
  });
});
