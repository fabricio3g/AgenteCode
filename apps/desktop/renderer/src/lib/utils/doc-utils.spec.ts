import { describe, expect, it } from 'vitest';
import { getFileIcon } from './doc-utils';
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
} from 'lucide-svelte';

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
