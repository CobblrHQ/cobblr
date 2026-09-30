// The date arithmetic behind dragging on a calendar and a gantt (#4173), kept
// pure so the rules are tested without a browser.
//
// A day is a local calendar day ("2026-09-29"), the unit both views draw.
// A field that also carries a time keeps it: an entry at 14:00 dragged to
// Friday is at 14:00 on Friday, never at midnight.

const DAY = 86_400_000;

/** "YYYY-MM-DD" for a local day. */
export function dayKeyOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The local midnight of a stored value's day, or null. */
export function dayOf(v: unknown): number | null {
  if (v == null || v === "") return null;
  const t = new Date(`${String(v).slice(0, 10)}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The stored value moved to `dayKey`, keeping its time of day if it had one. */
export function onDay(original: unknown, dayKey: string): string {
  const s = original == null ? "" : String(original);
  return s.length > 10 && s[10] === "T" ? `${dayKey}${s.slice(10)}` : dayKey;
}

/** The stored value `days` days later (or earlier), keeping its time. */
export function shiftedBy(original: unknown, days: number): string | null {
  const t = dayOf(original);
  if (t == null) return null;
  // Noon, not midnight: across a clock change a day is 23 or 25 hours, and
  // midnight plus whole days would land on the evening before.
  return onDay(original, dayKeyOf(t + days * DAY + DAY / 2));
}

/** A bar dragged by `days`: moved, both ends go; resized, only the end, and
 *  never before the start (a bar shrunk past its start stops at one day). */
export function draggedBar(
  bar: { start: unknown; end: unknown },
  days: number,
  mode: "move" | "resize",
): { start: string | null; end: string | null } {
  if (mode === "move") return { start: shiftedBy(bar.start, days), end: bar.end == null || bar.end === "" ? null : shiftedBy(bar.end, days) };
  const start = dayOf(bar.start);
  const end = dayOf(bar.end) ?? start;
  if (start == null || end == null) return { start: bar.start == null ? null : String(bar.start), end: null };
  const next = Math.max(start, end + days * DAY);
  return { start: String(bar.start), end: onDay(bar.end ?? bar.start, dayKeyOf(next + DAY / 2)) };
}

/** How many whole days a horizontal drag of `dx` px is, on a track `width` px
 *  wide that shows `spanDays` days. */
export function pxToDays(dx: number, width: number, spanDays: number): number {
  if (width <= 0 || spanDays <= 0) return 0;
  return Math.round((dx / width) * spanDays);
}

/** The day a keyboard step lands on from `dayKey`: ←/→ a day, ↑/↓ a week. */
export function stepDay(dayKey: string, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): string {
  const t = dayOf(dayKey)!;
  const by = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "ArrowUp" ? -7 : 7;
  return dayKeyOf(t + by * DAY + DAY / 2);
}
