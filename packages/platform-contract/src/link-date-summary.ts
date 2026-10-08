import { fieldDay } from "@cobblr/platform-contract/field-day";
export interface LinkDateSummary { label: string; field: string; format: "date" | "month-year" }
export function linkDateSummary(decl: LinkDateSummary, fields: Record<string, unknown>, locale?: string): string | null {
  const day = fieldDay(fields[decl.field] ?? (fields.metadata as Record<string, unknown> | undefined)?.[decl.field]);
  if (!day) return null;
  const date = new Date(day + "T12:00:00Z");
  if (!Number.isFinite(date.getTime())) return null;
  return `${decl.label} ${date.toLocaleDateString(locale, { timeZone: "UTC", month: "short", year: "numeric", ...(decl.format === "date" ? { day: "numeric" as const } : {}) })}`;
}
