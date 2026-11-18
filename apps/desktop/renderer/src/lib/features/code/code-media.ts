export function isMediaPath(text: string): boolean {
  return /\.(png|jpe?g|gif|webp|mp3|wav|m4a|ogg|oga|flac|mp4|webm|mov|mkv|pdf)["']?$/i.test(text.trim());
}

export async function mediaData(file: File): Promise<{ name: string; data: string }> {
  if (file.size > 50 * 1024 * 1024) throw new Error('Media attachments are limited to 50 MB.');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read attachment.'));
    reader.readAsDataURL(file);
  });
  return { name: file.name || 'clipboard.png', data };
}
