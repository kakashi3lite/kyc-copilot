import { formatInTimeZone } from "date-fns-tz";

export function nowIso(): string {
  return new Date().toISOString();
}

export function monthKey(date = new Date()): string {
  return formatInTimeZone(date, "UTC", "yyyy-MM");
}

/**
 * "yyyy-MM" key for the month N months before `from` (UTC). Used to build
 * rolling usage-history windows (e.g. the dashboard's 6-month chart).
 */
export function monthsAgoKey(n: number, from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function utcTimestamp(date = new Date()): string {
  return formatInTimeZone(date, "UTC", "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}
