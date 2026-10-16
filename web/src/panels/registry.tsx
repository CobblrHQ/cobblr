// The panel registry — the web half of the `contributes.panels` seam
// (machines-digifab-unification.md §5). A module's manifest declares WHERE
// it contributes UI (gated on `operatesOn` at manifest validation); this
// registry says WHICH component renders for each declared panel id. Host
// pages query enabled modules' `panels` (from /orgs/:slug/modules), then
// render through ContributedPageTab / ContributedDetailPanels — no host ever
// imports a contributor's page, and lint-page-imports keeps it that way.
//
// DETAIL panels now live in platform-web's registry (registerDetailPanel), so
// a MODULE-owned detail page can host them too: inventory's part modal shows
// purchases' price history through exactly this seam, without inventory ever
// naming purchases. Page tabs remain a web-page concern and stay local.
//
// Adding a panel: declare it in the module manifest (contributes.panels),
// put the component in web/src/features/<module>/, and map its id here.
// An id declared in a manifest but missing here renders nothing (a typo is
// invisible, not a crash).

import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { ContributedDetailPanels, ContributedTagToolbar, registerViewToolbar, registerTagToolbar, hasDetailPanel } from "@cobblr/platform-web";
// Detail panels register in their own small module, imported at boot by
// main.tsx; re-imported here so a page that names this file still has them.
import "./detail-panels";
import type { ConfigSectionCtx, ModulePageTabCtx } from "./types";

const PAGE_TABS: Record<string, LazyExoticComponent<ComponentType<{ ctx: ModulePageTabCtx }>>> = {
  "digifab:fleet-tab": lazy(() => import("../features/digifab/fleet").then((m) => ({ default: m.FleetPageTab }))),
};

registerViewToolbar(
  "inventory:stocktake-view",
  lazy(() => import("../features/inventory/stocktakeView").then((m) => ({ default: m.StocktakeViewControl }))),
);

registerTagToolbar(
  "inventory:recount-tag",
  lazy(() => import("../features/inventory/recountTag").then((m) => ({ default: m.RecountTagControl }))),
);

// Sections on a kernel Configuration page (surface "configuration-section"):
// a module's own setting shown where its people look for it, without the
// page importing the module (lint:kernel-config-pages-name-no-module).
const CONFIG_SECTIONS: Record<string, LazyExoticComponent<ComponentType<{ ctx: ConfigSectionCtx }>>> = {
  "core-maintenance:reminder-default": lazy(() => import("../features/core-maintenance/reminderDefault").then((m) => ({ default: m.ReminderDefaultSection }))),
};

export const hasPageTab = (id: string): boolean => !!PAGE_TABS[id];
export const hasConfigSection = (id: string): boolean => !!CONFIG_SECTIONS[id];

/** Every section enabled modules contribute to this Configuration page, each
 *  in the page's own card. Nothing when none does. */
export function ContributedConfigSections({ target, panels, ctx }: { target: string; panels: ReadonlyArray<{ id: string; surface: string; target: string; title: string }>; ctx: ConfigSectionCtx }) {
  const mine = panels.filter((p) => p.surface === "configuration-section" && p.target === target && hasConfigSection(p.id));
  return (
    <>
      {mine.map((p) => {
        const Section = CONFIG_SECTIONS[p.id]!;
        return (
          <section key={p.id} data-config-section={p.id} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
            <h2 className="text-sm font-semibold text-content dark:text-mortar-100">{p.title}</h2>
            <Suspense fallback={<p className="text-sm text-faint">Loading…</p>}>
              <Section ctx={ctx} />
            </Suspense>
          </section>
        );
      })}
    </>
  );
}
export { hasDetailPanel, ContributedDetailPanels, ContributedTagToolbar };

const spinner = (
  <div className="text-xs text-faint italic py-4" aria-busy="true">
    loading…
  </div>
);

export function ContributedPageTab({ id, ctx }: { id: string; ctx: ModulePageTabCtx }) {
  const C = PAGE_TABS[id];
  if (!C) return null;
  return (
    <Suspense fallback={spinner}>
      <C ctx={ctx} />
    </Suspense>
  );
}

