/**
 * Clean markdown and non-speakable content from text before sending to TTS.
 * Kokoro's phonemizer struggles with markdown syntax, code blocks, emojis, etc.
 */
export function cleanTextForTTS(text: string): string {
  if (!text) return '';

  let result = text;

  // 1. Remove fenced code blocks (```...```)
  result = result.replace(/```[\s\S]*?```/g, '');

  // 2. Remove inline code (`...`)
  result = result.replace(/`[^`]*`/g, '');

  // 3. Convert markdown links [text](url) → text
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 4. Remove images ![alt](src) → alt
  result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 5. Remove ATX headers (# Header → Header)
  result = result.replace(/^#{1,6}\s+/gm, '');

  // 6. Remove bold/italic markers (**text**, *text*, _text_) → text
  result = result.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');

  // 7. Remove blockquote markers (> )
  result = result.replace(/^>\s+/gm, '');

  // 8. Remove horizontal rules (---, ***, ___)
  result = result.replace(/^\s*[-*_]{3,}\s*$/gm, '');

  // 9. Remove list markers (- item, * item, 1. item, etc.)
  result = result.replace(/^\s*[-*+]\s+/gm, '');
  result = result.replace(/^\s*\d+\.\s+/gm, '');

  // 10. Remove tool call markers
  result = result.replace(/<think>[\s\S]*?<\/think>/g, '');

  // 11. Remove HTML-like tags
  result = result.replace(/<[^>]+>/g, '');

  // 12. Remove trailing pipe cursor artifacts from streaming (e.g. "Hello world|")
  result = result.replace(/\|\s*$/, '');

  // 13. Remove emojis (Unicode emoji presentation + pictographs + symbols)
  result = result.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu,
    ''
  );

  // 14. Collapse multiple whitespace into single space, trim
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}
