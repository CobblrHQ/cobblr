// /instances/:name — the per-instance page. Resolves the URL slug to a
// (module, instance) via the workspace's instances list, then renders
// that module's list UI scoped to the instance. The nav's synthetic
// "__instance__<name>" entries (useNavModules) link here.
//
// Module UIs are wired in one at a time: inventory renders its full
// list UI scoped to the instance today; the other multi-instance
// modules fall back to a clear placeholder until their UIs are
// parameterized (tracked in instances.md). The API path
// (/instances/:name/items) already works for every module.

import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { addressesInstanceItem } from "@cobblr/platform-contract/instance-detail";
import { nounOptions, type NounChoiceDecl } from "@cobblr/platform-contract/kind-label";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Camera, Plus, X } from "lucide-react";
import { InventoryUI, InventoryViewTabs } from "@cobblr/inventory/ui";
import { ProjectsUI } from "@cobblr/projects/ui";
import { MachinesPage } from "./MachinesPage";
import { AssetsPage } from "./AssetsPage";
import { RecordsPage } from "./RecordsPage";
import { WithBundleFeatures } from "../components/BundleFeaturesStrip";
import { RemoveEmptyList } from "../components/RemoveEmptyList";
import { api, getToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { navTargetFor, INSTANCE_PREFIX } from "../components/useNavModules";
import { initialViewId, rememberView, rememberedView } from "../lib/instance-view";
import { SavedViewPage } from "./SavedViewPage";
import { CollectionHeader, usePageWidth } from "@cobblr/platform-web";

export function InstancePage({ instanceName }: { instanceName?: string } = {}) {
  const { activeSlug, activeOrg } = useActiveOrg();
  // A collection is the same width whichever view it is on. The table asked
  // for the whole screen and the views beside it did not, so Table -> Cards
  // jumped from full width into the centred column and back on every tap.
  usePageWidth("wide");
  // Reached two ways: the canonical `/instances/:name` (param) AND the clean
  // top-level alias `/<name>` registered in App.tsx (prop). The prop wins.
  const params = useParams<{ name: string; "*": string }>();
  const name = instanceName ?? params.name;
  // What follows the instance in the url: "" for the collection, "items/<id>"
  // for one of its records, "settings" for a page of its own.
  const subPath = params["*"] ?? "";
  const location = useLocation();

  const instancesQ = useQuery({
    queryKey: ["instances", activeSlug],
    queryFn: () => api.listInstances(activeSlug),
    enabled: !!activeSlug,
  });
  const overridesQ = useQuery({
    queryKey: ["entity-kind-overrides", activeSlug],
    queryFn: () => api.listOverrides(activeSlug),
    enabled: !!activeSlug,
  });
  // A bundle can PIN a saved view to its instance (Groceries pins the "What's
  // on hand" board). Those used to be reachable only from /views, which a
  // locked app cannot open, so a grocery app had a board and no door to it.
  // Pinned views render HERE as tabs beside the table, and `?view=board`
  // (or a view's id) opens one directly: that is a managed app's home path.
  const [searchParams, setSearchParams] = useSearchParams();
  // With no `?view=` in the URL (the nav link, a reload after the nav link)
  // the collection opens on the view this device last picked, else the one
  // its bundle marked default (Groceries' "What's on hand", the Bookshelf's
  // cover wall), else the table. instance-view.ts, tested.
  const urlView = searchParams.get("view");
  // `?new=1` is the create door from a view's empty state: the module page
  // owns the create form, so it renders (its table underneath) until the
  // form closes and strips the param, and the picked view returns with the
  // first record in it. Nothing is remembered on the way.
  const creating = searchParams.get("new") === "1";
  const early = (instancesQ.data?.items ?? []).find((i) => i.instance_name === name);
  const kindId = early ? `${early.instance_name}:item` : null;
  const viewsQ = useQuery({
    queryKey: ["saved-views", activeSlug, kindId],
    queryFn: () => api.listSavedViews(activeSlug, kindId!),
    enabled: !!activeSlug && !!kindId,
    staleTime: 60_000,
  });
  const pinnedViews = (viewsQ.data?.items ?? []).filter((v) => v.pinned);
  const wantView = creating
    ? null
    : initialViewId({
        urlView,
        remembered: name ? rememberedView(activeSlug, name) : null,
        views: pinnedViews,
      });
  const activeView = wantView
    ? (pinnedViews.find((v) => v.id === wantView) ??
      (wantView === "board" ? (pinnedViews.find((v) => v.view_type !== "table") ?? pinnedViews[0] ?? null) : null))
    : null;

  // The pinned views decide what the page opens on and add their tabs above
  // it, so the page waits for them: drawn first, the table's controls dropped
  // 42 px when the tabs came, or the page swapped to a board (#7781).
  if (instancesQ.isLoading || (kindId && viewsQ.isLoading)) {
    return <div className="text-sm text-muted p-4">Loading…</div>;
  }
  const inst = (instancesQ.data?.items ?? []).find(
    (i) => i.instance_name === name,
  );
  if (!inst) {
    return (
      <div className="text-sm text-muted dark:text-slate-400 italic p-4">
        No instance "{name}" in this workspace. It may have been deleted -{" "}
        <Link to="/configuration/new-thing" className="text-accent hover:underline not-italic">
          create a new one
        </Link>
        .
      </div>
    );
  }

  const override = (overridesQ.data?.items ?? []).find(
    (o) => o.target_kind === "instance" && o.target_id === `${inst.module_name}:${inst.instance_name}`,
  );
  const displayName = override?.display_label ?? inst.display_name;
  // The bundle that created this instance seeds item_noun / qty_unit in the
  // override config ("yarn" → "New yarn", default unit "skein").
  const cfg = (override?.config ?? {}) as {
    item_noun?: string;
    item_noun_plural?: string;
    qty_unit?: string;
    parent?: { instance: string; label?: string; relationship_kind?: string };
    file_intake?: import("@cobblr/platform-contract").FileIntakeDecl | null;
    record_templates?: import("@cobblr/platform-contract/record-creation").RecordTemplate[];
    receipt_draft?: import("@cobblr/platform-contract/record-creation").ReceiptDraftConfig;
    connector_import?: import("@cobblr/platform-contract").ConnectorImportDecl | null;
    noun?: NounChoiceDecl | null;
    hint?: string | null;
    package_receiving?: { storage_tracking?: boolean };
    paste_tracking?: boolean;
  };
  // A type collection with a collection of its things (Filament Types →
  // Spools) opens as one page, titled with their shared nav group ("Filament").
  const familyChild = (instancesQ.data?.items ?? []).find((i) => {
    const o = (overridesQ.data?.items ?? []).find((x) => x.target_kind === "instance" && x.target_id === `${i.module_name}:${i.instance_name}`);
    return (o?.config as { parent?: { instance?: string } } | undefined)?.parent?.instance === inst.instance_name;
  });
  const appMode = !!activeOrg?.app_mode;
  const family = familyChild
    ? {
        childPath: navTargetFor(`${INSTANCE_PREFIX}${familyChild.instance_name}`, appMode),
        tablePath: `${navTargetFor(`${INSTANCE_PREFIX}${inst.instance_name}`, appMode)}?as=table`,
      }
    : undefined;
  const groupLabel = (cfg as { nav_group?: { label?: string } }).nav_group?.label;
  const pageTitle = family && groupLabel ? groupLabel : displayName;
  // A family page carries its own views (by material, by colour, low) and its
  // raw table behind ⋯, so the collection's saved-view strip does not show.
  const shownView = family ? null : activeView;
  // Every word the table offers for what it counts in, with its declared
  // plural, so "3 hanks" agrees on every row whichever word each record has.
  const countWords = cfg.noun?.of === "unit" ? nounOptions(cfg.noun) : [];

  // The whole dispatch is wrapped so the one-time "created from your capture"
  // success strip (redesign A3) renders above WHICHEVER module UI wins.
  const body = (() => {
  // Per-module UI dispatch. Inventory + projects render their packaged
  // list UIs scoped to the instance; host-page modules (machines /
  // assets / purchases) fall through to the placeholder for now.
  if (inst.module_name === "inventory") {
    return (
      <InventoryUI
        orgSlug={activeSlug}
        getToken={getToken}
        instance={inst.instance_name}
        displayName={pageTitle}
        itemNoun={cfg.item_noun}
        itemNounPlural={cfg.item_noun_plural}
        qtyUnit={cfg.qty_unit}
        countWords={countWords}
        parent={cfg.parent}
        storageTracking={cfg.package_receiving?.storage_tracking === true}
        pasteTracking={cfg.paste_tracking === true}
        family={family}
        recordTemplates={cfg.record_templates ?? undefined}
        receiptDraft={cfg.receipt_draft ?? undefined}
        connectorImport={cfg.connector_import ?? undefined}
        hint={cfg.hint}
      />
    );
  }
  if (inst.module_name === "projects") {
    // ProjectsUI owns its own heading from displayName (like InventoryUI) — no
    // outer wrapper heading, or the page reads "Outfits" then "Projects".
    return (
      <ProjectsUI
        orgSlug={activeSlug}
        getToken={getToken}
        instance={inst.instance_name}
        displayName={displayName}
        itemNoun={cfg.item_noun}
        itemNounPlural={cfg.item_noun_plural}
        fileIntake={cfg.file_intake ?? undefined}
        hint={cfg.hint}
      />
    );
  }
  // Machines renders its FULL page (fields, detail/edit, digifab linking)
  // scoped to the instance — a 3D printer on /3d-printers is a complete
  // machine, not a name-only stub. The detail modal opens via local state
  // (no /machines/:id route exists under the clean /<instance> URL).
  if (inst.module_name === "machines") {
    return (
      <MachinesPage
        instance={inst.instance_name}
        displayName={displayName}
        itemNoun={cfg.item_noun}
        itemNounPlural={cfg.item_noun_plural}
        hint={cfg.hint}
      />
    );
  }
  // Assets renders its FULL page (thumbnails, views, detail/edit) scoped to the
  // instance — a Vehicle on /vehicles is a complete asset, not a name-only stub.
  if (inst.module_name === "assets") {
    return (
      <AssetsPage
        instance={inst.instance_name}
        displayName={displayName}
        itemNoun={cfg.item_noun}
        itemNounPlural={cfg.item_noun_plural}
        hint={cfg.hint}
      />
    );
  }
  // Records renders its FULL page (thumbnails, detail/edit, custom fields)
  // scoped to the instance — a Bookshelf on /bookshelf is a complete record
  // collection, not a name-only stub.
  if (inst.module_name === "records") {
    return (
      <RecordsPage
        instance={inst.instance_name}
        displayName={displayName}
        itemNoun={cfg.item_noun}
        itemNounPlural={cfg.item_noun_plural}
        hint={cfg.hint}
      />
    );
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          {displayName}
        </h1>
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          instance of {inst.module_name}
        </span>
      </div>
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 text-sm text-content dark:text-mortar-200">
        The dashboard view for <span className="font-mono">{inst.module_name}</span>{" "}
        instances isn't wired up yet - but this instance is fully usable
        through the API + CLI at{" "}
        <code className="font-mono text-xs">
          /orgs/{activeSlug}/instances/{inst.instance_name}/items
        </code>
        . Per-module dashboard views are landing one at a time.
      </div>
    </div>
  );
  })();

  const pickView = (id: string | null) => {
    if (name) rememberView(activeSlug, name, id);
    const next = new URLSearchParams(searchParams);
    if (id) next.set("view", id);
    else next.delete("view");
    setSearchParams(next, { replace: true });
  };
  // A url for ONE item, or for a page of the collection's own, is the module's
  // to render under every view. A view draws the collection, never an item:
  // with the cover wall on, a link to a book (a Cobb chip, a tile, a pasted
  // url) used to land on the wall with nothing opened (#3583). Which urls are
  // items is read from the same templates the links are built from.
  const sub = subPath.replace(/^\/+|\/+$/g, "");
  const showsOneThing =
    addressesInstanceItem(inst.module_name, { subPath, search: location.search }) || (sub !== "" && sub !== "items");
  // Back to the view the collection was on: the collection's own url, where
  // the remembered (or default) view opens again. The preference is untouched.
  const collectionPath = sub ? location.pathname.slice(0, location.pathname.length - subPath.length).replace(/\/+$/, "") : location.pathname;
  const tabCls = (on: boolean) =>
    "rounded-full px-3 py-1 text-sm transition " +
    (on
      ? "bg-accent text-white"
      : "border border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:text-accent hover:border-accent");

  return (
    <div className="space-y-3">
      <CreatedSuccessStrip />
      {/* "More you can turn on from <bundle>" — surfaces the instance's bundle's
          not-yet-enabled features (maintenance, connected-car…) + opens the
          bundle modal to enable them. Renders nothing when there's nothing more;
          what is under it waits for it to know (#6881). */}
      <WithBundleFeatures slug={activeSlug} instance={inst.instance_name}>
      {/* An empty list made from a module can be taken away from here. */}
      {!showsOneThing && <RemoveEmptyList slug={activeSlug} inst={inst} />}
      {shownView && showsOneThing && (
        <Link
          to={collectionPath || "."}
          data-testid="back-to-view"
          className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
        >
          ← Back to {shownView.name}
        </Link>
      )}
      {pinnedViews.length > 0 && !family && !(shownView && showsOneThing) && (
        <div className="flex flex-wrap items-center gap-2" data-testid="instance-view-tabs">
          <button type="button" className={tabCls(!shownView)} onClick={() => pickView(null)}>
            Table
          </button>
          {pinnedViews.map((v) => (
            <button key={v.id} type="button" className={tabCls(shownView?.id === v.id)} onClick={() => pickView(v.id)}>
              {v.name}
            </button>
          ))}
        </div>
      )}
      {shownView && !showsOneThing ? (
        <div className="space-y-3">
          {/* The collection's own header on every tab, so what it offers (the
              floor plan's place mode for physical things, an inventory's Going
              off and Settings) is not only on the Table: Groceries opens on its
              cards, and the door was missing there (#4147). */}
          <CollectionHeader
            title={displayName}
            kind={shownView.entity_kind || undefined}
            selectionList={shownView.id}
            nav={
              inst.module_name === "inventory" ? (
                <InventoryViewTabs orgSlug={activeSlug} getToken={getToken} instance={inst.instance_name} itemNoun={cfg.item_noun} itemNounPlural={cfg.item_noun_plural} />
              ) : undefined
            }
          />
          <SavedViewPage viewId={shownView.id} embedded />
        </div>
      ) : (
        body
      )}
      </WithBundleFeatures>
    </div>
  );
}

/** One-time "here's what just happened" strip (redesign A3): shown when the
 *  funnel/materialize lands here with ?created=…&count=… — names the win and
 *  channels the momentum (scan more / keep adding) instead of dropping the
 *  user into a bare table. Dismiss = strip the params (no storage needed). */
function CreatedSuccessStrip() {
  const [params, setParams] = useSearchParams();
  const created = params.get("created");
  if (!created) return null;
  const count = Number(params.get("count") ?? "0");
  const clear = () => {
    const next = new URLSearchParams(params);
    next.delete("created");
    next.delete("count");
    setParams(next, { replace: true });
  };
  return (
    // On a phone the two actions wrap under the sentence: beside it they left
    // the sentence a 140px column, eight lines tall (#3222).
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2.5 flex flex-wrap items-center gap-2.5 text-sm">
      <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
      <div className="flex-1 min-w-0 basis-52 text-content dark:text-mortar-100">
        <strong>{created}</strong> is set up{count > 0 ? <>, {count} item{count === 1 ? "" : "s"} filed from your capture{count === 1 ? "" : "s"}</> : null}. This is its home now.
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <Link to="/scan/camera" onClick={clear} className="shrink-0 inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-700 px-2 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:border-emerald-400 transition">
          <Camera size={12} /> Scan more
        </Link>
        <Link to="/dashboard" onClick={clear} className="shrink-0 inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-700 px-2 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:border-emerald-400 transition">
          <Plus size={12} /> Add more
        </Link>
        <button title="Dismiss" type="button" onClick={clear} aria-label="Dismiss" className="shrink-0 rounded p-1 text-faint hover:text-content transition">
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

