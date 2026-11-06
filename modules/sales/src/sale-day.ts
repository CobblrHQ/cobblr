// The days a sale can be on. A year typed as 0024 is a real day on the calendar, and
// it files the order where no month's figures will ever find it.

import { isRealDay } from "@cobblr/platform-contract/day";

export function isSaleDay(value: unknown): boolean {
  if (!isRealDay(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year <= 2100;
}

/** The day after `day`, for a payment dated in a zone a little ahead. */
export function dayAfter(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
