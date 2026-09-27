export function buildCurrentDateTimeContext(now = new Date()): string {
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const localDate = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
  const localTime = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  }).format(date);

  return [
    `Current date/time: ${localDate}, ${localTime} local time.`,
    `Current ISO timestamp: ${date.toISOString()}.`,
    'Use this for today\'s date, the current day of week, calendar questions, and time calculations. For live facts beyond the clock/calendar, use web search instead of model memory.'
  ].join(' ');
}
