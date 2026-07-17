// "Pairs well with" — recommend-by-SHAPE, not by name. Given a module, surface
// featured bundles whose `requires` includes that module AND whose other
// required modules are already enabled (so the bridge is installable right now).
// The module never names a bundle; we reverse-index the bundle's own `requires`.
// That keeps module isolation intact — a bundle is the only artifact allowed to
// know about two modules, and either module's page surfaces the same bundle.
//
// One tap installs the bundle (which draws the wires). Hidden entirely when
// there's nothing to recommend.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { Link2, Plus } from "lucide-react";
import { api } from "../lib/api";
import { FEATURED_BUNDLES, type FeaturedBundle } from "../lib/featured-bundles";

export function PairsWellWith({ module, orgSlug }: { module: string; orgSlug: string }) {
  const qc = useQueryClient();
  const toast = useToast();

  const modules = useQuery({
    queryKey: ["org-modules", orgSlug],
    queryFn: () => api.orgModules(orgSlug),
    enabled: !!orgSlug,
  });
  const bundles = useQuery({
    queryKey: ["bundles", orgSlug],
    queryFn: () => api.listBundles(orgSlug),
    enabled: !!orgSlug,
  });

  const install = useMutation({
    mutationFn: (b: FeaturedBundle) => api.installBundle(orgSlug, b.manifest),
    onSuccess: (_r, b) => {
      toast.success(`${b.manifest.name} installed`);
      void qc.invalidateQueries({ queryKey: ["bundles", orgSlug] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  if (!modules.data || !bundles.data) return null;
  const enabled = new Set(modules.data.items.map((m) => m.name));
  const installed = new Set(bundles.data.items.map((b) => b.external_id));

  const recs = FEATURED_BUNDLES.filter((b) => {
    // Only CORE bundles are PROACTIVELY recommended. This strip pushes a bundle
    // the user didn't ask for, so it's held to the same bar as the per-scan menu:
    // `extended` is installable from the marketplace but never pushed, `disabled`
    // is hidden entirely (see docs/design-decisions/bundle-catalog-tiers.md).
    if ((b.manifest.catalog ?? "core") !== "core") return false;
    const reqs = (b.manifest.requires ?? []).map((r) => r.module);
    if (!reqs.includes(module)) return false; // must reference THIS module
    if (installed.has(b.manifest.id)) return false; // not already installed
    // Recommend only when every required module is already enabled — i.e. the
    // user genuinely has both sides and just hasn't connected them yet.
    return reqs.every((m) => enabled.has(m));
  });
  if (recs.length === 0) return null;

  return (
    <div className="mt-6 rounded-lg border border-dashed border-line dark:border-slate-700 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted uppercase tracking-wide">
        <Link2 size={13} /> Pairs well with
      </div>
      <div className="mt-2 space-y-2">
        {recs.map((b) => (
          <div key={b.manifest.id} className="flex items-center gap-3">
            <span className="text-lg leading-none">{b.glyph}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-content dark:text-mortar-100">{b.manifest.name}</div>
              <div className="text-xs text-muted truncate">{b.blurb}</div>
            </div>
            <button
              type="button"
              onClick={() => install.mutate(b)}
              disabled={install.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50 shrink-0"
            >
              <Plus size={13} /> Add
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default PairsWellWith;
