// Render a saved view in the member portal — read-only by default.
// The same ResolvedEntity tile-grid the admin shell uses, minus all
// edit affordances.
//
// S1 from 2026-05-25-audit.md: when the user has a per-action
// capability grant matching the view's entity_kind, render a
// "+ New" button that opens the same create dialog the admin shell
// uses. Today proven for inventory:part (NewPartDialog from
// @cobblr/inventory/ui). Other entity kinds extend the same way —
// the entity-kind owner exports its create dialog, the portal lazy-
// loads it when the user has the capability.

import { Link, useOutletContext, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Search } from "lucide-react";
import { useState } from "react";
import { EntityThumb, usePageTitle } from "@cobblr/platform-web";
import { NewPartDialog, InventoryProvider } from "@cobblr/inventory/ui";
import { api, getToken } from "../lib/api";

interface PortalCtx {
  activeSlug: string | null;
}

/** Map an entity_kind to the capability that gates its create.
 *  Extend as other modules opt in. Returns null when no
 *  capability is known → no create button rendered. */
const CREATE_CAPABILITY_BY_KIND: Record<string, string> = {
  "inventory:part": "inventory:create-part",
};

export function PortalViewPage() {
  const { viewId } = useParams<{ viewId: string }>();
  const { activeSlug } = useOutletContext<PortalCtx>();
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const qc = useQueryClient();

  const data = useQuery({
    queryKey: ["portal-view-data", activeSlug, viewId, q],
    queryFn: () => api.viewData(activeSlug!, viewId!, { q: q || undefined, limit: 100 }),
    enabled: !!activeSlug && !!viewId,
  });
  usePageTitle(data.data?.view.entity_kind ?? "View");

  // User capabilities — drives whether to show the "+ New" button.
  const caps = useQuery({
    queryKey: ["my-capabilities", activeSlug],
    queryFn: () => api.getMyCapabilities(activeSlug!),
    enabled: !!activeSlug,
  });

  if (!viewId || !activeSlug) return null;

  const entityKind = data.data?.view.entity_kind;
  const createCap = entityKind ? CREATE_CAPABILITY_BY_KIND[entityKind] : undefined;
  const canCreate =
    createCap !== undefined &&
    (caps.data?.role === "owner" ||
      caps.data?.role === "admin" ||
      caps.data?.grants.includes(createCap));

  return (
    <div className="space-y-4">
      <Link
        to={`/portal/${activeSlug}`}
        className="inline-flex items-center gap-1.5 text-xs text-muted dark:text-slate-400 hover:text-accent"
      >
        <ArrowLeft size={12} /> back
      </Link>

      <div className="flex items-center justify-between gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100">
          {data.data?.view.entity_kind ?? "…"}
        </h1>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-1.5 transition"
            >
              <Plus size={14} /> New
            </button>
          )}
          <div className="flex items-center gap-2 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2">
            <Search size={14} className="text-faint" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search…"
              className="bg-transparent text-sm py-1.5 focus:outline-none text-content dark:text-mortar-100 placeholder:text-faint w-48"
            />
          </div>
        </div>
      </div>

      {data.isLoading && (
        <div className="text-xs text-faint italic">Loading…</div>
      )}
      {data.data && data.data.items.length === 0 && (
        <div className="text-xs text-faint italic py-8 text-center">
          No items match.
        </div>
      )}
      {data.data && data.data.items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.data.items.map((item) => (
            <div
              key={`${item.kind}:${item.id}`}
              className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 flex items-center gap-3"
            >
              <EntityThumb
                src={item.image_path ?? null}
                alt={item.title}
                size={56}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">
                  {item.title}
                </div>
                {item.subtitle && (
                  <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 truncate">
                    {item.subtitle}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog. Per-entity-kind branching as more kinds opt in. */}
      {createOpen && entityKind === "inventory:part" && (
        <InventoryProvider orgSlug={activeSlug} getToken={getToken}>
          <NewPartDialog
            onClose={() => setCreateOpen(false)}
            onCreated={() => {
              setCreateOpen(false);
              // Refresh the view so the new row appears in place;
              // stay on the portal (no navigate to admin shell).
              void qc.invalidateQueries({
                queryKey: ["portal-view-data", activeSlug, viewId],
              });
            }}
          />
        </InventoryProvider>
      )}
    </div>
  );
}
