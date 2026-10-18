// What a food says it contains, as warning pills: "Contains: milk, nuts" and
// "May contain: peanuts". One component for the scan card and the record, so a
// food reads the same before and after it is filed. A food with nothing listed
// shows nothing at all: "none" would be a safety claim nobody made.

import { TriangleAlert } from "lucide-react";

/** The words a list holds, whether it arrives as a scan's array or a record's
 *  "milk, nuts" text. */
export function allergenWords(list: unknown): string[] {
  const parts = Array.isArray(list) ? list : typeof list === "string" ? list.split(",") : [];
  return parts.filter((w): w is string => typeof w === "string").map((w) => w.trim()).filter(Boolean);
}

export function AllergenPills({ contains, mayContain, className }: { contains?: unknown; mayContain?: unknown; className?: string }) {
  const lines = [
    { key: "contains", label: "Contains", words: allergenWords(contains) },
    { key: "may-contain", label: "May contain", words: allergenWords(mayContain) },
  ].filter((l) => l.words.length > 0);
  if (!lines.length) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      {lines.map((l) => (
        <span
          key={l.key}
          data-testid={`allergen-${l.key}`}
          className="inline-flex items-center gap-1 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
        >
          <TriangleAlert size={11} className="shrink-0" aria-hidden />
          <span>{l.label}: {l.words.join(", ")}</span>
        </span>
      ))}
    </span>
  );
}
