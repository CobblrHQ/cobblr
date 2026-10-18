// The conflict view of a bundle update: each thing the person customised that
// this version also changes, their value beside the update's, and one choice
// per item. Every update that can conflict comes here - the dashboard row, the
// catalog's Update, and an automatic update that stopped to ask - because the
// server's auto-apply skips a conflicting update and leaves its row pointing
// at this view.
//
// The choice is per ITEM, not per update: taking the update's options for one
// field must not also undo a rename on another.

import type { BundleConflictResolution, BundleUpgradeConflict } from "../lib/api";
import { rovingRadio } from "@cobblr/platform-web";

export type ConflictChoice = BundleConflictResolution["choice"];

export function conflictKey(c: Pick<BundleUpgradeConflict, "entity_kind" | "name" | "attr">): string {
  return `${c.entity_kind}\u0000${c.name}\u0000${c.attr}`;
}

/** What an item starts on. A list of options starts on "keep both", which
 *  loses nothing of either side; a name or a removed field starts on yours. */
export function defaultChoice(c: BundleUpgradeConflict): ConflictChoice {
  return c.attr === "choices" ? "both" : "mine";
}

export function resolutionsFor(
  conflicts: readonly BundleUpgradeConflict[],
  picked: Readonly<Record<string, ConflictChoice>>,
): BundleConflictResolution[] {
  return conflicts.map((c) => ({
    entity_kind: c.entity_kind,
    name: c.name,
    attr: c.attr,
    choice: picked[conflictKey(c)] ?? defaultChoice(c),
  }));
}

const asList = (v: string | string[] | null): string[] => (Array.isArray(v) ? v : v ? [v] : []);

function Value({ conflict, side }: { conflict: BundleUpgradeConflict; side: "yours" | "theirs" }) {
  const v = side === "yours" ? conflict.yours : conflict.theirs;
  if (conflict.attr === "removed") {
    return side === "yours" ? (
      <span>{typeof v === "string" && v ? `named "${v}"` : "your version of it"}</span>
    ) : (
      <span className="italic text-faint dark:text-slate-500">not in this version</span>
    );
  }
  if (conflict.attr === "label") {
    return <span>{typeof v === "string" && v ? `"${v}"` : <span className="italic text-faint dark:text-slate-500">no name</span>}</span>;
  }
  if (conflict.attr === "view") {
    return (
      <ul className="space-y-0.5 break-words">
        {asList(v).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    );
  }
  const mine = asList(conflict.yours);
  const other = side === "yours" ? asList(conflict.theirs) : mine;
  const items = asList(v);
  if (items.length === 0) return <span className="italic text-faint dark:text-slate-500">no options</span>;
  return (
    <ul className="flex flex-wrap gap-1">
      {items.map((o) => (
        <li
          key={o}
          className={
            "rounded border px-1.5 py-0.5 text-xs " +
            (other.includes(o)
              ? "border-line dark:border-slate-700 text-content dark:text-mortar-200"
              : "border-accent/60 bg-cobble-50 dark:bg-cobble-900/30 text-content dark:text-mortar-100 font-medium")
          }
          title={other.includes(o) ? undefined : side === "yours" ? "only in yours" : "new in this version"}
        >
          {o}
        </li>
      ))}
    </ul>
  );
}

const WHAT: Record<BundleUpgradeConflict["attr"], string> = {
  label: "You renamed it, and this version renames it too.",
  choices: "You changed its options, and this version changes them too.",
  removed: "You customised it, and this version no longer has it.",
  view: "You changed these settings of this view, and this version changes them too. Everything else you changed stays.",
};

export function BundleUpdateConflicts({
  conflicts,
  picked,
  onPick,
  tableName,
}: {
  conflicts: readonly BundleUpgradeConflict[];
  picked: Readonly<Record<string, ConflictChoice>>;
  onPick: (key: string, choice: ConflictChoice) => void;
  /** The table an item belongs to, for a person who has several. */
  tableName: (entityKind: string) => string | null;
}) {
  return (
    <section
      data-testid="update-conflicts"
      className="rounded-md border border-amber-400 dark:border-amber-600 bg-amber-50/60 dark:bg-amber-900/20 p-3 space-y-3"
    >
      <div>
        <div className="text-[10px] uppercase tracking-widest text-amber-700 dark:text-amber-400">
          {conflicts.length === 1 ? "1 thing to decide" : `${conflicts.length} things to decide`}
        </div>
        <p className="text-sm text-content dark:text-mortar-200 mt-0.5">
          You changed {conflicts.length === 1 ? "this" : "these"}, and so does the update. Pick what to keep for each.
        </p>
      </div>
      <ul className="space-y-2.5">
        {conflicts.map((c) => {
          const key = conflictKey(c);
          const choice = picked[key] ?? defaultChoice(c);
          const table = tableName(c.entity_kind);
          const options: Array<{ value: ConflictChoice; label: string }> = [
            { value: "mine", label: "Keep mine" },
            { value: "theirs", label: c.attr === "removed" ? "Remove it" : "Use the update's" },
            ...(c.attr === "choices" ? [{ value: "both" as const, label: "Keep both" }] : []),
          ];
          return (
            <li
              key={key}
              data-testid="update-conflict"
              className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 space-y-2"
            >
              <div>
                <div className="text-sm font-medium text-content dark:text-mortar-100">
                  {c.field_label}
                  {table && <span className="font-normal text-faint dark:text-slate-500"> in {table}</span>}
                </div>
                <div className="text-xs text-faint dark:text-slate-400">{WHAT[c.attr]}</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-0.5">yours</div>
                  <Value conflict={c} side="yours" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-0.5">the update's</div>
                  <Value conflict={c} side="theirs" />
                </div>
              </div>
              <div role="radiogroup" aria-label={`${c.field_label}: what to keep`} className="flex flex-wrap gap-1.5">
                {options.map((o, i) => (
                  <button
                    key={o.value}
                    type="button"
                    {...rovingRadio(i, options.findIndex((x) => x.value === choice))}
                    role="radio"
                    aria-checked={choice === o.value}
                    onClick={() => onPick(key, o.value)}
                    className={
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition " +
                      (choice === o.value
                        ? "border-accent bg-accent text-white"
                        : "border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:border-accent")
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
