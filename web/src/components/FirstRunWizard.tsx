// First-run wizard — the empty-workspace "what do you want to set up?" flow.
//
// A brand-new workspace has no domain modules on and nothing in it. The old
// empty-state dumped the user on a wall of generic cards + a "Browse the
// marketplace" button — which a real new user ("Grace") read as a roadblock,
// not a start. This replaces it: the answer to "what do you want to do?" IS a
// set of bundles as plain nouns (Yarn, Home Inventory, Plants…). Pick one →
// the bundle's guided install (feature questions + enable-the-module confirm)
// → land straight in it (autoLand), so nobody is left stranded.
//
// It reuses BundleDetailModal verbatim (so the feature questions, the
// needs_enable confirm, and the install path are exactly the marketplace's),
// and useBundleCatalog (so landings/next_steps survive the registry path).

import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { useBundleCatalog, type CatalogBundle } from "../lib/useBundleCatalog";
import { BundleDetailModal } from "./BundleDetailModal";

export function FirstRunWizard({
  slug,
  onSkip,
}: {
  slug: string;
  onSkip: () => void;
}) {
  const { registry, catalog } = useBundleCatalog();
  const [picked, setPicked] = useState<CatalogBundle | null>(null);

  // The wizard offers the curated flagship set as "plain nouns" — not the
  // whole marketplace (drivers/community/3rd-party belong on /bundles).
  // Order simplest-first: a bundle that needs one module ("Yarn") is a more
  // approachable first pick than a cross-module bridge ("grocery spend").
  // Data-driven (by requires-count, then name) — no hardcoded ordering.
  const options = catalog
    .filter((b) => b.manifest.id.includes(".flagship."))
    .sort(
      (a, b) =>
        (a.manifest.requires?.length ?? 0) - (b.manifest.requires?.length ?? 0) ||
        a.manifest.name.localeCompare(b.manifest.name),
    );

  return (
    <section className="rounded-xl border-2 border-dashed border-cobble-300 dark:border-cobble-700 bg-cobble-50/30 dark:bg-cobble-900/10 p-5 space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <h2 className="font-semibold text-content dark:text-mortar-100">
            What do you want to set up?
          </h2>
        </div>
        <p className="text-sm text-content dark:text-mortar-200">
          Pick what you'd like to track and Cobblr builds it for you — the right
          fields, views, and a place to add your first one. You can change or add
          more anytime.
        </p>
      </div>

      {registry.isLoading && options.length === 0 ? (
        <div className="text-xs text-faint dark:text-slate-500 py-4">Loading…</div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {options.map((b) => (
            <li key={b.manifest.id}>
              <button
                type="button"
                onClick={() => setPicked(b)}
                className="w-full h-full text-left rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
              >
                <div className="text-2xl shrink-0">{b.glyph}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-content dark:text-mortar-100 text-sm">
                    {b.manifest.name}
                  </div>
                  <div className="text-xs text-content dark:text-mortar-200 mt-1">
                    {b.blurb}
                  </div>
                </div>
                <ArrowRight
                  size={14}
                  className="text-faint dark:text-slate-600 group-hover:text-accent transition mt-1 shrink-0"
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-4 pt-1">
        <button
          type="button"
          onClick={onSkip}
          className="text-xs font-medium text-faint dark:text-slate-400 hover:text-content dark:hover:text-mortar-100 transition"
        >
          Skip for now
        </button>
        <Link
          to="/bundles"
          className="text-xs text-faint dark:text-slate-400 hover:text-accent transition"
        >
          or browse the full marketplace →
        </Link>
      </div>

      {picked && (
        <BundleDetailModal
          // Key by id so per-bundle state (feature checks) resets per pick.
          key={picked.manifest.id}
          open
          onClose={() => setPicked(null)}
          slug={slug}
          mode="featured"
          manifest={picked.manifest}
          glyph={picked.glyph}
          blurb={picked.blurb}
          nextSteps={picked.next_steps}
          autoLand
        />
      )}
    </section>
  );
}
