// A moment as a person reads it, in their own zone, to the second: "Oct 27,
// 2026, 7:43:28 AM". For a kept measurement or log line, where "5m ago" says
// too little and the server's ISO stamp ("2026-10-27T11:43:28.690Z") reads
// four hours wrong to someone in New York (#8652).
export function exactTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const t = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}
