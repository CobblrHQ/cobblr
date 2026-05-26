// Render an entity-kind's 6-axis trait fingerprint inline.
//
// One source-of-truth for the display convention in
// docs/design-decisions/traits.md §"Display convention". Wherever
// traits appear in the UI (matched-kinds preview, entity-kind
// detail surfaces, etc.) they go through here so the format stays
// consistent.
//
// Special case: an axis assignment can be `{ trait, uncertain: true }`
// — the author flagged it as a judgment call. We render the trait
// word followed by a small "(?)" badge with a hover tooltip
// explaining the uncertainty. Without this badge, `uncertain` was
// schema-valid but invisible — the data carried a signal nothing
// surfaced.

import type { PlatformEntityKind } from "../lib/api";

const AXIS_ORDER = [
  "tangibility",
  "identity",
  "containment",
  "time",
  "lifecycle",
  "persistence",
] as const;

/** One axis cell. `null` = author skipped this axis (renders as
 *  `—`); `{ trait, uncertain }` = renders trait + "(?)" badge;
 *  plain string = renders trait. */
function AxisCell({
  axis,
  value,
}: {
  axis: string;
  value: string | null | { trait: string; uncertain: true };
}) {
  if (value === null || value === undefined) {
    return (
      <span
        className="text-slate-300 dark:text-slate-600"
        title={`${axis}: skipped`}
      >
        —
      </span>
    );
  }
  if (typeof value === "object" && "trait" in value) {
    return (
      <span className="inline-flex items-center gap-0.5" title={axis}>
        <span>{value.trait}</span>
        <span
          className="text-[9px] font-bold text-amber-600 dark:text-amber-400 cursor-help"
          title={`Uncertain — the module author flagged ${axis}='${value.trait}' as a judgment call rather than a definitive assignment. Cross-module actions still see this as ${value.trait}; the badge is a UI hint that the assignment might shift if the entity's semantics get sharpened.`}
        >
          (?)
        </span>
      </span>
    );
  }
  return (
    <span title={axis}>{value}</span>
  );
}

/** Inline "physical · unique · containable · timeless · indefinite · durable"
 *  rendering. Uncertain axes get a "(?)" badge inline next to the
 *  trait word. */
export function TraitFingerprint({
  traits,
  className = "",
}: {
  traits: PlatformEntityKind["traits"];
  className?: string;
}) {
  if (!traits) {
    return (
      <span className={`text-[10px] font-mono text-slate-400 ${className}`}>
        (no traits declared)
      </span>
    );
  }
  return (
    <span className={`text-[10px] font-mono text-slate-500 dark:text-slate-400 ${className}`}>
      {AXIS_ORDER.map((axis, i) => {
        const value = traits[axis];
        return (
          <span key={axis}>
            {i > 0 && <span className="mx-1 text-slate-300 dark:text-slate-600">·</span>}
            <AxisCell axis={axis} value={value ?? null} />
          </span>
        );
      })}
    </span>
  );
}

/** Profile chip + fingerprint subtitle, per traits.md §"Display
 *  convention" — render the preset name AND its expansion so the
 *  macro never hides what the author committed to. */
export function TraitProfileBadge({
  profile,
  traits,
}: {
  profile: string | null;
  traits: PlatformEntityKind["traits"];
}) {
  if (!profile) {
    return <TraitFingerprint traits={traits} />;
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0">
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-cobble-700 dark:text-cobble-300 border border-cobble-200 dark:border-cobble-800">
        {profile}
      </span>
      <TraitFingerprint traits={traits} />
    </span>
  );
}
