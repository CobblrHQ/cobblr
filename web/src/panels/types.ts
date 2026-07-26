// Host-context contracts for contributed panels (manifest `contributes.panels`
// — see machines-digifab-unification.md §5). A host page renders whatever
// enabled modules contribute for its surface, passing ONLY this generic
// context — it never names a contributor, and a contributor never reaches
// into the host page. Keep these shapes small and module-agnostic: a new
// field here must make sense for EVERY host, not just the one you're wiring.

/** Context for `surface: "module-page-tab"` — a tab on the target module's
 *  list page (e.g. the Fleet tab on 3D Printers). */
export interface ModulePageTabCtx {
  slug: string;
  /** The collection's item noun ("3D printer"), for scoped copy. */
  itemNoun: string;
  /** The ids of the entities the host page currently owns (its rows) —
   *  contributors scope themselves to these, never to the whole module. */
  entityIds: Set<string>;
}

/** Context for `surface: "entity-detail-panel"` — a panel inside the target
 *  kind's detail modal (e.g. the Print manager on a machine). Defined in
 *  platform-web (module-owned detail pages host these too) and re-exported
 *  here so both halves of the seam read the same shape. */
export type { EntityDetailPanelCtx } from "@cobblr/platform-web";
