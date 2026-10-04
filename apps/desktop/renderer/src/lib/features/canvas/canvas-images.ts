export async function bitmapSize(href: string): Promise<{ w: number; h: number }> {
  const image = new Image();
  image.src = href;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('The image has no visible content.');
  return { w: image.naturalWidth, h: image.naturalHeight };
}
