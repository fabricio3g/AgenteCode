/**
 * A date as a card or file row shows it: relative within the week ("today",
 * "3 days ago"), then month and day ("Nov 4"). Zero means unknown and reads
 * as nothing.
 */
export function recentDay(ts: number, lang: string): string {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 7) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-days, 'day');
  return new Date(ts).toLocaleDateString(lang, { month: 'short', day: 'numeric' });
}
