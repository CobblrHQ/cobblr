// Contributed detail panels — the host-agnostic half of the manifest's
// `contributes.panels` seam (machines-digifab-unification.md §5).
//
// Same inversion as the file-preview / dashboard-widget registries:
// platform-web owns the MECHANISM, the host app owns the components. A module
// declares WHERE it contributes (gated on `operatesOn` at manifest validation);
// the host registers WHICH component renders each declared id; a detail page
// renders `<ContributedDetailPanels target="<kind>" ctx={…} />` and never
// learns who contributed.
//
// It lives here rather than in web/src/panels so that MODULE-owned detail pages
// (inventory's part modal, and every future one) can host contributions too.
// Before this, only pages inside web/src could — which is why cross-module
// panels kept getting hardcoded into the host module's own UI instead.

import {
  Suspense,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";

/** Context for `surface: "entity-detail-panel"` — a panel inside the target
 *  kind's detail modal. Keep it small and host-agnostic: a field added here
 *  must make sense for EVERY host, not just the one you're wiring. */
export interface EntityDetailPanelCtx {
  slug: string;
  entityId: string;
  entityTitle: string;
  /** Free-form host hints (e.g. a machine's `printer_kind`) — interpretation
   *  is the contributor's business, presence is optional. */
  hints?: Record<string, string | undefined>;
}

/** A manifest-declared UI contribution, as the API reports it. */
export interface ContributedPanelSpec {
  id: string;
  surface: "module-page-tab" | "entity-detail-panel";
  target: string;
  title: string;
}

export type DetailPanelComponent = ComponentType<{ ctx: EntityDetailPanelCtx }>;

const REGISTRY = new Map<string, DetailPanelComponent>();
const listeners = new Set<() => void>();
let snapshot: string[] = [];

function notify(): void {
  // Refresh the cached snapshot HERE: registrations happen at import time,
  // often before any component has subscribed.
  snapshot = [...REGISTRY.keys()].sort();
  for (const l of listeners) l();
}

/** Map a declared panel id (`<module>:<panel>`) to its component. Called by the
 *  host app at load. Re-registering an id replaces it. */
export function registerDetailPanel(id: string, component: DetailPanelComponent): void {
  REGISTRY.set(id, component);
  notify();
}

export function unregisterDetailPanel(id: string): void {
  if (REGISTRY.delete(id)) notify();
}

export function hasDetailPanel(id: string): boolean {
  return REGISTRY.has(id);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function useRegisteredIds(): string[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** The panels ENABLED modules declare for this entity kind AND that the host
 *  has a component for. An id declared but never registered renders nothing —
 *  a typo is invisible, not a crash. */
export function useContributedDetailPanels(target: string): ContributedPanelSpec[] {
  const { api, orgSlug } = usePlatformWeb();
  const registered = useRegisteredIds();
  const q = useQuery({
    queryKey: ["contributed-panels", orgSlug],
    queryFn: () => api.listContributedPanels!(orgSlug),
    enabled: !!api.listContributedPanels,
    // Contributions change only when a module is enabled/disabled.
    staleTime: 5 * 60_000,
  });
  return (q.data ?? []).filter(
    (p) =>
      p.surface === "entity-detail-panel" &&
      p.target === target &&
      registered.includes(p.id),
  );
}

const spinner = (
  <div className="text-xs text-faint italic py-4" aria-busy="true">
    loading…
  </div>
);

/** Render every contributed panel for `target`. One line in a host page. */
export function ContributedDetailPanels({
  target,
  ctx,
}: {
  target: string;
  ctx: EntityDetailPanelCtx;
}) {
  const panels = useContributedDetailPanels(target);
  if (panels.length === 0) return null;
  return (
    <>
      {panels.map((p) => {
        const C = REGISTRY.get(p.id);
        if (!C) return null;
        return (
          <Suspense key={p.id} fallback={spinner}>
            <C ctx={ctx} />
          </Suspense>
        );
      })}
    </>
  );
}
