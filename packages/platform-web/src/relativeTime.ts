// Shared relative-time formatter ("just now" / "5m ago" / "3h ago" / "4d ago" /
// "2mo ago" / a date). Extracted so read-only date surfaces (server-managed
// stamps like `away_since`, activity rows, chips) agree on one voice — the
// page-local copies in Dashboard/ScanPage can migrate here over time.

export function relativeTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const t = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return new Date(t).toLocaleDateString();
}
