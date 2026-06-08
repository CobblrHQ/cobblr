// Small "bundle updates available" indicator for the nav, so the signal isn't
// buried in the marketplace (the author's #2). Renders nothing when everything's up to
// date. `dot` for a trigger corner, `count` for a labelled menu row.

import { useBundleUpdates } from "../lib/useBundleUpdates";

export function UpdateBadge({
  slug,
  variant = "count",
  className = "",
}: {
  slug: string;
  variant?: "dot" | "count";
  className?: string;
}) {
  const updates = useBundleUpdates(slug);
  if (updates.length === 0) return null;
  const label = `${updates.length} bundle update${updates.length === 1 ? "" : "s"} available`;
  if (variant === "dot") {
    return (
      <span
        className={`inline-block w-2 h-2 rounded-full bg-amber-500 ring-2 ring-surface dark:ring-slate-900 ${className}`}
        aria-label={label}
        title={label}
      />
    );
  }
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold ${className}`}
      aria-label={label}
      title={label}
    >
      {updates.length}
    </span>
  );
}
