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

import { useParams, useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Camera, Plus, X } from "lucide-react";
import { InventoryUI } from "@cobblr/inventory/ui";
import { ProjectsUI } from "@cobblr/projects/ui";
import { MachinesPage } from "./MachinesPage";
import { AssetsPage } from "./AssetsPage";
import { RecordsPage } from "./RecordsPage";
import { BundleFeaturesStrip } from "../components/BundleFeaturesStrip";
import { api, getToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function InstancePage({ instanceName }: { instanceName?: string } = {}) {
  const { activeSlug } = useActiveOrg();
  // Reached two ways: the canonical `/instances/:name` (param) AND the clean
  // top-level alias `/<name>` registered in App.tsx (prop). The prop wins.
  const params = useParams<{ name: string }>();
  const name = instanceName ?? params.name;

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

  if (instancesQ.isLoading) {
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
  };

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
        displayName={displayName}
        itemNoun={cfg.item_noun}
        itemNounPlural={cfg.item_noun_plural}
        qtyUnit={cfg.qty_unit}
        parent={cfg.parent}
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

  return (
    <div className="space-y-3">
      <CreatedSuccessStrip />
      {/* "More you can turn on from <bundle>" — surfaces the instance's bundle's
          not-yet-enabled features (maintenance, connected-car…) + opens the
          bundle modal to enable them. Renders nothing when there's nothing more. */}
      <BundleFeaturesStrip slug={activeSlug} instance={inst.instance_name} />
      {body}
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
    <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2.5 flex items-center gap-2.5 text-sm">
      <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
      <div className="flex-1 min-w-0 text-content dark:text-mortar-100">
        <strong>{created}</strong> is set up{count > 0 ? <> — {count} item{count === 1 ? "" : "s"} filed from your capture{count === 1 ? "" : "s"}</> : null}. This is its home now.
      </div>
      <Link to="/scan/camera" onClick={clear} className="shrink-0 inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-700 px-2 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:border-emerald-400 transition">
        <Camera size={12} /> Scan more
      </Link>
      <Link to="/dashboard" onClick={clear} className="shrink-0 inline-flex items-center gap-1 rounded-md border border-emerald-300 dark:border-emerald-700 px-2 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:border-emerald-400 transition">
        <Plus size={12} /> Add more
      </Link>
      <button type="button" onClick={clear} aria-label="Dismiss" className="shrink-0 rounded p-1 text-faint hover:text-content transition">
        <X size={13} />
      </button>
    </div>
  );
}

