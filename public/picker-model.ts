// Calendar-only arithmetic avoids timezone and DST shifts for due dates.
export function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  const next = date.toISOString().slice(0, 10);
  return validCalendarDate(next) ? next : value;
}
export function shiftMonth(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00Z`), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + amount);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return value;
  const last = new Date(date); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  date.setUTCDate(Math.min(day, last.getUTCDate()));
  return date.toISOString().slice(0, 10);
}
export function monthDays(value: string): (string | null)[] {
  const first = value.slice(0, 7) + '-01';
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const date = new Date(`${first}T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0);
  const days: (string | null)[] = Array(offset).fill(null);
  for (let n = 1; n <= date.getUTCDate(); n++) days.push(first.slice(0, 8) + String(n).padStart(2, '0'));
  while (days.length % 7) days.push(null);
  return days;
}
export function matchingOptions<T extends {label: string}>(options: T[], query: string): T[] {
  const normalized = query.trim().normalize('NFC').toLocaleLowerCase();
  return options.filter(option => option.label.normalize('NFC').toLocaleLowerCase().includes(normalized));
}
