import { formatInTimeZone } from "date-fns-tz";

export function nowIso(): string {
  return new Date().toISOString();
}

export function monthKey(date = new Date()): string {
  return formatInTimeZone(date, "UTC", "yyyy-MM");
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function utcTimestamp(date = new Date()): string {
  return formatInTimeZone(date, "UTC", "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}
