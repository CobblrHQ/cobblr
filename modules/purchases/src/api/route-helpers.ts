/**
 * A pg `date` column comes back as a JS Date at LOCAL midnight (there is no
 * setTypeParser override in this repo), so `.toISOString().slice(0, 10)` moves
 * it a calendar day for any server east of Greenwich - a Berlin box turned
 * "arrives Aug 26" into an Aug 25 calendar event. Local getters read the same
 * day pg parsed.
 */
export function localDayOf(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
