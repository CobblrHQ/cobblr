// ONE visual language for browsing the bundle catalog (new-user-flow.md F2).
// The dashboard's "More ways to start" surface and the /bundles marketplace
// used to render the same catalog as two different-looking grids, which is how
// "one catalog, four costumes" happened. Both now compose from here:
//
//   splitCatalog()       - the ready-made vs full-setup classifier
//   BundleSection        - a labelled tile-grid section ("// ready-made bundles")
//   BundleTile           - one bundle as a tile (glyph · name · badges · blurb)
//
// Click SEMANTICS stay per-surface (the panel selects-to-prime the hero; the
// marketplace opens the detail modal) - the surfaces share the LOOK and the
// grouping, not the behavior.

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { CatalogBundle } from "../lib/useBundleCatalog";

/** A SKIN (ready-made bundle) is one kind of thing with pre-shaped fields - it
 *  provisions an instance and spans at most one module. Anything wider is a
 *  full setup. The relatable front door leads in both surfaces. */
export function splitCatalog(catalog: CatalogBundle[]): { skins: CatalogBundle[]; setups: CatalogBundle[] } {
  const moduleSpan = (b: CatalogBundle) =>
    new Set([
      ...(b.manifest.requires ?? []).map((r) => r.module),
      ...(b.manifest.provides_instances ?? []).map((i) => i.module),
    ]).size;
  const isSkin = (b: CatalogBundle) =>
    moduleSpan(b) <= 1 && (b.manifest.provides_instances?.length ?? 0) >= 1;
  return { skins: catalog.filter(isSkin), setups: catalog.filter((b) => !isSkin(b)) };
}

/** One section of a browse surface - a labelled tile grid. The hint says what
 *  the section IS in the user's terms, so sections read as an ordered offer
 *  instead of unexplained lists. */
export function BundleSection({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-accent">{title}</span>
        <span className="text-[11px] text-faint dark:text-slate-500">{hint}</span>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{children}</ul>
    </div>
  );
}

export function BundleTile({
  b,
  onOpen,
  selected = false,
  badges,
  showId = false,
  onDetails,
}: {
  b: CatalogBundle;
  /** The surface's primary click: select-to-prime (panel) or open-modal (page). */
  onOpen: () => void;
  selected?: boolean;
  /** Status chips after the name (installed / update available / 3rd-party). */
  badges?: ReactNode;
  showId?: boolean;
  /** Renders a small "details →" that stops propagation (panel variant). */
  onDetails?: () => void;
}) {
  return (
    <li className="h-full">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        title={selected ? "Click again to deselect" : undefined}
        className={
          "h-full cursor-pointer text-left rounded-lg border p-2.5 flex items-start gap-2.5 transition group " +
          (selected ? "border-accent bg-accent/5" : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900 hover:border-cobble-300 dark:hover:border-cobble-700")
        }
      >
        <div className="text-xl shrink-0 leading-none mt-0.5">{b.glyph}</div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-content dark:text-mortar-100 text-sm flex items-center gap-2 flex-wrap">
            {b.manifest.name}
            {badges}
          </div>
          {showId && <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-0.5">{b.manifest.id}</div>}
          <div className="text-xs text-faint dark:text-slate-400 line-clamp-2">{b.blurb}</div>
          {onDetails && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDetails();
              }}
              className="mt-1 text-[11px] text-faint dark:text-slate-500 hover:text-accent transition"
            >
              details →
            </button>
          )}
        </div>
        <ArrowRight size={13} className={(selected ? "text-accent" : "text-faint dark:text-slate-600 group-hover:text-accent") + " transition mt-1 shrink-0"} />
      </div>
    </li>
  );
}
