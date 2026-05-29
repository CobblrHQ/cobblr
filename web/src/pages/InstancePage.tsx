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

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useConfirm, useToast } from "@cobblr/platform-web";
import { InventoryUI } from "@cobblr/inventory/ui";
import { ProjectsUI } from "@cobblr/projects/ui";
import { ApiError, api, getToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function InstancePage() {
  const { activeSlug } = useActiveOrg();
  const { name } = useParams<{ name: string }>();

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
    return <div className="text-sm text-slate-500 p-4">Loading…</div>;
  }
  const inst = (instancesQ.data?.items ?? []).find(
    (i) => i.instance_name === name,
  );
  if (!inst) {
    return (
      <div className="text-sm text-slate-500 dark:text-slate-400 italic p-4">
        No instance "{name}" in this workspace. It may have been deleted —
        check Configuration → "+ New thing".
      </div>
    );
  }

  const override = (overridesQ.data?.items ?? []).find(
    (o) => o.target_kind === "instance" && o.target_id === `${inst.module_name}:${inst.instance_name}`,
  );
  const displayName = override?.display_label ?? inst.display_name;

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
      />
    );
  }
  if (inst.module_name === "projects") {
    return (
      <div className="space-y-4">
        <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
          <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
            {displayName.toLowerCase()}
          </h1>
        </div>
        <ProjectsUI
          orgSlug={activeSlug}
          getToken={getToken}
          instance={inst.instance_name}
        />
      </div>
    );
  }
  // Host-page modules (machines, assets) don't expose a packaged UI to
  // parameterize, and their full pages assume their own /<module> route
  // (absolute detail navigation). Rather than risk that refactor, give
  // their instances a lightweight scoped list — see / add / delete,
  // isolated — using the instance-aware web client. Full detail-modal
  // parity is a follow-up (instances.md). Both kinds are name-based.
  if (inst.module_name === "machines" || inst.module_name === "assets") {
    return (
      <HostInstanceList
        slug={activeSlug}
        instance={inst.instance_name}
        moduleName={inst.module_name}
        displayName={displayName}
      />
    );
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          {displayName.toLowerCase()}
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          instance of {inst.module_name}
        </span>
      </div>
      <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-sm text-slate-600 dark:text-mortar-200">
        The dashboard view for <span className="font-mono">{inst.module_name}</span>{" "}
        instances isn't wired up yet — but this instance is fully usable
        through the API + CLI at{" "}
        <code className="font-mono text-xs">
          /orgs/{activeSlug}/instances/{inst.instance_name}/items
        </code>
        . Per-module dashboard views are landing one at a time.
      </div>
    </div>
  );
}

/** Lightweight scoped list for name-based host-page modules (machines,
 *  assets). Reads / creates / deletes through the instance-aware web
 *  client (api.list/create/deleteMachine|Asset with the instance arg),
 *  so rows are fully isolated to the instance. Detail/edit modals (the
 *  full host page) are a follow-up — tracked in instances.md. */
function HostInstanceList({
  slug,
  instance,
  moduleName,
  displayName,
}: {
  slug: string;
  instance: string;
  moduleName: "machines" | "assets";
  displayName: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [newName, setNewName] = useState("");

  const listFn = moduleName === "machines" ? api.listMachines : api.listAssets;
  const createFn = moduleName === "machines" ? api.createMachine : api.createAsset;
  const deleteFn = moduleName === "machines" ? api.deleteMachine : api.deleteAsset;
  const key = ["instance-items", slug, instance];

  const list = useQuery<{ items: Array<{ id: string; name: string }> }>({
    queryKey: key,
    queryFn: () =>
      listFn(slug, instance) as Promise<{
        items: Array<{ id: string; name: string }>;
      }>,
    enabled: !!slug,
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: key });

  const create = useMutation<void, unknown, string>({
    mutationFn: async (name: string) => {
      await createFn(slug, { name } as never, instance);
    },
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't add"),
  });
  const del = useMutation<void, unknown, string>({
    mutationFn: async (id: string) => {
      await deleteFn(slug, id, instance);
    },
    onSuccess: invalidate,
  });

  const items = (list.data?.items ?? []) as Array<{ id: string; name: string }>;

  return (
    <div className="space-y-4 max-w-2xl" data-testid="host-instance-list">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          {displayName.toLowerCase()}
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          {items.length} · instance of {moduleName}
        </span>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) create.mutate(newName.trim());
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={`New ${moduleName === "machines" ? "machine" : "asset"} name`}
          className="flex-1 px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900"
          data-testid="host-new-name"
        />
        <button
          type="submit"
          disabled={!newName.trim() || create.isPending}
          className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm"
        >
          <Plus size={14} /> Add
        </button>
      </form>

      {list.isLoading && <div className="text-sm text-slate-500">Loading…</div>}
      {!list.isLoading && items.length === 0 && (
        <div className="text-sm text-slate-500 dark:text-slate-400 italic">
          Nothing here yet — add the first one above.
        </div>
      )}
      <ul className="border border-slate-200 dark:border-slate-700 rounded divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((it) => (
          <li
            key={it.id}
            className="px-3 py-2 text-sm flex items-center gap-2"
            data-item-name={it.name}
          >
            <span className="flex-1 text-slate-700 dark:text-mortar-100">
              {it.name}
            </span>
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete?",
                  message: `${it.name} — removed from this instance.`,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) del.mutate(it.id);
              }}
              className="text-slate-400 hover:text-ember-500 transition"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-slate-400">
        This is the lightweight view for {moduleName} instances — full
        detail / edit is on the default {moduleName} page for now.
      </p>
    </div>
  );
}
