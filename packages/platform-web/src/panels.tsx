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
import { HoldsQuiet, useOnceQuiet } from "./OnceQuiet";
import { stillAsking } from "./still-asking";
import { useFaces } from "./faces";

/** Context for `surface: "entity-detail-panel"` — a panel inside the target
 *  kind's detail modal. Keep it small and host-agnostic: a field added here
 *  must make sense for EVERY host, not just the one you're wiring. */
export interface EntityDetailPanelCtx {
  slug: string;
  entityId: string;
  entityTitle: string;
  /** The kind being rendered, e.g. "inventory:part".
   *
   *  Filled in by ContributedDetailPanels from its own `target`, so a panel
   *  that declared `target: "*"` still knows what it is looking at. A panel
   *  targeting one kind already knows; a universal one cannot. */
  kind?: string;
  /** Free-form host hints (e.g. a machine's `printer_kind`) — interpretation
   *  is the contributor's business, presence is optional. */
  hints?: Record<string, string | undefined>;
}

/** A manifest-declared UI contribution, as the API reports it. */
export interface ContributedPanelSpec {
  id: string;
  surface: "module-page-tab" | "entity-detail-panel" | "configuration-section" | "view-toolbar";
  target: string;
  title: string;
  /** The panel's own predicate, when it declared one. Only `traits` is read
   *  here, against the trait values the collection wears (real and trial
   *  axes): a panel with traits shows where every listed one is worn. */
  appliesTo?: { traits?: string[] } | { any: true } | null;
  /** The collections it belongs on ("3d-printers"); see `presence`. */
  collections?: string[] | null;
  /** Shows on a record its module says has its data (panelPresence). */
  presence?: boolean | null;
  /** Disclosure: the face this panel belongs to. A face a person hid takes
   *  its panels off the record; eligibility above is untouched. */
  face?: string | null;
  placement?: "summary" | "details";
}

export { panelShows, collectionNameOf, type PanelRecordShape } from "./panel-shows";
import { panelShows, collectionNameOf, type PanelRecordShape } from "./panel-shows";
import { arrangePanels, panelLayoutKey } from "@cobblr/platform-contract/record-panel-layout";

export type DetailPanelComponent = ComponentType<{ ctx: EntityDetailPanelCtx }>;

/** Context for `surface: "view-toolbar"`: a control in a saved view's header,
 *  on every view whose records the contributing module owns. */
export interface ViewToolbarCtx {
  slug: string;
  /** The view's record kind, e.g. "groceries:item". */
  kind: string;
  /** The records the view is showing now, in its order. */
  ids: string[];
  /** The view's own name, for the control's words ("What's on hand"). */
  viewName: string;
}

export type ViewToolbarComponent = ComponentType<{ ctx: ViewToolbarCtx }>;

/** Context for `surface: "tag-toolbar"`: a control over one group of a tag's
 *  page, the records of one kind that carry the tag, on every tag page whose
 *  group the contributing module owns (#6819). */
export interface TagToolbarCtx {
  slug: string;
  /** The group's record kind, e.g. "inventory:part" or "spices:item". */
  kind: string;
  /** The named collection the kind is, or null for a module's own kind. */
  collection: string | null;
  /** The records in the group that carry the tag. */
  ids: string[];
  /** The tag's name, as a person reads it and as an action takes it. */
  tagName: string;
}

export type TagToolbarComponent = ComponentType<{ ctx: TagToolbarCtx }>;

/** A panel that belongs on EVERY entity detail view, whatever the kind. */
export const UNIVERSAL = "*";

/** Detail panels the kernel itself contributes. Links are pairings, which
 *  belong to no module, so no manifest can declare them; the host adds these
 *  to what the enabled modules declare. lint:panel-registry reads this list
 *  beside the manifests. */
export const KERNEL_PANELS: ContributedPanelSpec[] = [
  { id: "platform:links", surface: "entity-detail-panel", target: UNIVERSAL, title: "Links" },
  // A record's documents in the Vault, for the people who may open them; it
  // draws nothing for anyone else (#5242).
  { id: "platform:vault-documents", surface: "entity-detail-panel", target: UNIVERSAL, title: "In the Vault" },
];

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

/** Map a declared view-toolbar id to its component (the same id space as
 *  panels, so lint:panel-registry reads both). */
export function registerViewToolbar(id: string, component: ViewToolbarComponent): void {
  REGISTRY.set(id, component as unknown as DetailPanelComponent);
  notify();
}

/** Map a declared tag-toolbar id to its component (the same id space). */
export function registerTagToolbar(id: string, component: TagToolbarComponent): void {
  REGISTRY.set(id, component as unknown as DetailPanelComponent);
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
export function useContributedDetailPanels(
  target: string,
  /** Include panels that declared `target: "*"`.
   *
   *  Default true: a detail view of a real record should carry the universal
   *  side-cars. Pass false from a slot that is NOT a record's detail view —
   *  notably a row in a list of things that do not exist yet. */
  universal = true,
  baseTarget?: string,
): ContributedPanelSpec[] {
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
      // `*` means EVERY kind. Some side-cars are not about one module's
      // entities at all — a conversation, a tag — and enumerating every kind
      // that should have one is a list that is wrong the day a module ships.
      (p.target === target || p.target === baseTarget || (universal && p.target === UNIVERSAL)) &&
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
  universal = true,
  baseTarget,
  placement,
}: {
  target: string;
  ctx: EntityDetailPanelCtx;
  /** See useContributedDetailPanels. Set false where the slot is a row in a
   *  list rather than a record's own detail view. */
  universal?: boolean;
  baseTarget?: string;
  placement?: "summary" | "details";
}) {
  const all = useContributedDetailPanels(target, universal, baseTarget);
  const { api, orgSlug } = usePlatformWeb();
  const asksPresence = all.some((p) => p.presence) && !!ctx.entityId && !!api.panelPresence;
  const presence = useQuery({
    queryKey: ["panel-presence", orgSlug, ctx.kind ?? target, ctx.entityId, ctx.hints?.collection ?? null],
    queryFn: () => api.panelPresence!(orgSlug, ctx.kind ?? target, ctx.entityId, ctx.hints?.collection ?? null),
    enabled: asksPresence,
    staleTime: 60_000,
  });
  // What the record wears is its collection's, when the host names one: a
  // Licences & subscriptions record is an inventory part whose collection is
  // unique and kept, and reading the base kind's faces (fungible stock) kept
  // the Renewals panel off it (#5807).
  const collection = typeof ctx.hints?.collection === "string" && ctx.hints.collection ? ctx.hints.collection : null;
  const { worn, on } = useFaces(ctx.kind ?? collection ?? target);
  // A panel that belongs to traits the collection does not wear stays off
  // the record; "Price history" is `traits: ["fungible"]` and has nothing to
  // say on a catalog. Absent traits = the old rule, target alone. Every listed
  // trait must be worn, which is the matcher's cross-axis AND.
  // Then the person's choice: a hidden face hides its panels. A panel that
  // names its collections or its presence shows only there (#6337).
  const shape: PanelRecordShape = {
    collection: collectionNameOf(collection),
    worn,
    facesOn: on as ReadonlySet<string>,
    present: new Set(presence.data?.present ?? []),
  };
  // And the workspace's say over the ones that apply: hidden, and in what
  // order, per kind of record (its collection's when it has one, #6337).
  const layoutKey = panelLayoutKey(ctx.kind ?? target, collection);
  const arranged = useQuery({
    queryKey: ["record-panel-layout", orgSlug, layoutKey],
    queryFn: () => api.recordPanelLayout!(orgSlug, layoutKey),
    enabled: !!api.recordPanelLayout,
    staleTime: 60_000,
  });
  const quiet = useOnceQuiet();
  // Held until the arrangement is read, so a hidden panel never flashes up.
  if (api.recordPanelLayout && arranged.isLoading) return null;
  const panels = arrangePanels(all.filter((p) => panelShows(p, shape, placement)), arranged.data?.layout);
  if (panels.length === 0) return null;
  const drawn = (
    <>
      {panels.map((p) => {
        const C = REGISTRY.get(p.id);
        if (!C) return null;
        return (
          // A row in a list draws nothing while a panel's code arrives: a
          // "loading…" there pushed the row's buttons down and took them
          // back up again (#7789). A record's own page keeps its spinner.
          // Either way the page is not quiet until the code is in (OnceQuiet).
          <Suspense key={p.id} fallback={<><HoldsQuiet />{universal ? spinner : null}</>}>
            <C ctx={{ ...ctx, kind: ctx.kind ?? target }} />
          </Suspense>
        );
      })}
    </>
  );
  // On a record's own page the panels show once, and whole, after their last
  // answer (OnceQuiet): a history that came after Discuss and Tag pushed both
  // down under a finger on every page that draws them (#7870). A row in a
  // list draws them as they come; a held row would be a gap in the list. The
  // box takes its host's spacing, which hosts set differently: a flex or grid
  // host's gap, and between panels the margin a space-y host gives the box.
  if (!universal) return drawn;
  return (
    <div className={`flex flex-col gap-[inherit] [&>*+*]:mt-[inherit]${quiet ? "" : " invisible"}`} aria-hidden={quiet ? undefined : true} aria-busy={quiet ? undefined : true}>
      {drawn}
    </div>
  );
}

/** The controls enabled modules declare on `surface` for `module`, registered here. */
function useContributedControls(surface: "view-toolbar" | "tag-toolbar", module: string | null | undefined) {
  const { api, orgSlug } = usePlatformWeb();
  const registered = useRegisteredIds();
  const q = useQuery({
    queryKey: ["contributed-panels", orgSlug],
    queryFn: () => api.listContributedPanels!(orgSlug),
    enabled: !!api.listContributedPanels && !!module,
    staleTime: 5 * 60_000,
  });
  return {
    controls: (q.data ?? []).filter((p) => p.surface === surface && p.target === module && registered.includes(p.id)),
    pending: stillAsking(q),
  };
}

/** Whether the controls for a view of `module`'s records are still being
 *  asked for. A view draws its header once they are in, so a control that
 *  comes after never pushes the row along under a finger (#7790). */
export function useViewToolbarPending(module: string | null | undefined): boolean {
  return useContributedControls("view-toolbar", module).pending;
}

/** Render what enabled modules put in a saved view's header: the toolbar
 *  controls declared for the module that owns the view's records. The view
 *  names no contributor; `module` is the owner of its kind. */
export function ContributedViewToolbar({ module, ctx, holdsPage }: {
  module: string | null | undefined;
  ctx: ViewToolbarCtx;
  /** A control still loading its code suspends the page's own boundary, so
   *  the page is drawn with it rather than before it. */
  holdsPage?: boolean;
}) {
  const { controls } = useContributedControls("view-toolbar", module);
  if (!controls.length || !ctx.ids.length) return null;
  return (
    <>
      {controls.map((p) => {
        const C = REGISTRY.get(p.id) as unknown as ViewToolbarComponent | undefined;
        if (!C) return null;
        return holdsPage ? (
          <C key={p.id} ctx={ctx} />
        ) : (
          <Suspense key={p.id} fallback={<HoldsQuiet />}>
            <C ctx={ctx} />
          </Suspense>
        );
      })}
    </>
  );
}

/** Render what enabled modules put over one group of a tag's page: the
 *  controls declared for the module that owns the group's records (a recount
 *  of the tagged things, #6819). The tag page names no contributor. */
export function ContributedTagToolbar({ module, ctx }: { module: string | null | undefined; ctx: TagToolbarCtx }) {
  const { controls } = useContributedControls("tag-toolbar", module);
  if (!controls.length || !ctx.ids.length) return null;
  return (
    <>
      {controls.map((p) => {
        const C = REGISTRY.get(p.id) as unknown as TagToolbarComponent | undefined;
        if (!C) return null;
        return (
          <Suspense key={p.id} fallback={<HoldsQuiet />}>
            <C ctx={ctx} />
          </Suspense>
        );
      })}
    </>
  );
}
