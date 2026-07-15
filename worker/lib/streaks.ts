const DAY_MS = 86_400_000;

function toUtcDay(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function formatUtcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function calculateStreaks(
  localDates: string[],
  today: string,
): { current: number; longest: number } {
  const uniqueDays = [...new Set(localDates)].sort();

  if (uniqueDays.length === 0) {
    return { current: 0, longest: 0 };
  }

  let longest = 1;
  let run = 1;

  for (let index = 1; index < uniqueDays.length; index += 1) {
    const previous = toUtcDay(uniqueDays[index - 1]);
    const current = toUtcDay(uniqueDays[index]);

    if (current - previous === DAY_MS) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  const days = new Set(uniqueDays);
  const todayTimestamp = toUtcDay(today);
  const start = days.has(today)
    ? todayTimestamp
    : todayTimestamp - DAY_MS;

  let current = 0;
  let cursor = start;

  while (days.has(formatUtcDay(cursor))) {
    current += 1;
    cursor -= DAY_MS;
  }

  return { current, longest };
}
