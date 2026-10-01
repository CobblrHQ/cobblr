// "Works with <page>": a bundle that would connect this page to something the
// workspace already has, with what it would do here in its own words
// (lib/works-with.ts decides which, and what each says). One press installs
// it; the × puts it away for this person for good. Nothing at all when there
// is nothing to suggest.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changeWorkspaceShape, useToast } from "@cobblr/platform-web";
import { Link2, Plus, X } from "lucide-react";
import { api } from "../lib/api";
import { FEATURED_BUNDLES, type FeaturedBundle } from "../lib/featured-bundles";
import { worksWithSuggestions, worksWithTipId } from "../lib/works-with";
import { useTipState } from "../tips/useTipState";

export function WorksWith({ module, orgSlug }: { module: string; orgSlug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const tips = useTipState();

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
  const passed = useQuery({
    queryKey: ["bundles-passed", orgSlug],
    queryFn: () => api.passedBundles(orgSlug),
    enabled: !!orgSlug,
  });

  const install = useMutation({
    mutationFn: (b: FeaturedBundle) => changeWorkspaceShape(qc, orgSlug, () => api.installBundle(orgSlug, b.manifest)),
    onSuccess: (_r, b) => {
      toast.success(`${b.manifest.name} installed`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  // A suggestion waits for everything that could rule it out, so one is never
  // shown and then snatched away.
  if (!modules.data || !bundles.data || !passed.data || !tips.loaded) return null;
  const recs = worksWithSuggestions({
    module,
    featured: FEATURED_BUNDLES,
    enabled: new Set(modules.data.items.map((m) => m.name)),
    installed: new Set(bundles.data.items.map((b) => b.external_id)),
    passed: new Set(passed.data.items),
    dismissed: tips.state.dismissed ?? {},
  });
  if (recs.length === 0) return null;
  const page = modules.data.items.find((m) => m.name === module)?.displayName ?? module;

  return (
    <section className="mt-6 rounded-lg border border-dashed border-line dark:border-slate-700 p-3" data-testid="works-with" aria-label={`Works with ${page}`}>
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-content dark:text-mortar-100">
        <Link2 size={13} aria-hidden /> Works with {page}
      </h2>
      <ul className="mt-2 space-y-3">
        {recs.map(({ bundle: b, says }) => (
          <li key={b.manifest.id} className="flex items-start gap-3" data-testid="works-with-item" data-bundle={b.manifest.id}>
            <span className="text-lg leading-none mt-0.5" aria-hidden>{b.glyph}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-content dark:text-mortar-100">{b.manifest.name}</div>
              <p className="text-xs text-muted">{says.join(" ")}</p>
            </div>
            <button
              type="button"
              onClick={() => install.mutate(b)}
              disabled={install.isPending}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-cobble-600 text-white hover:bg-cobble-700 disabled:opacity-50 shrink-0"
            >
              <Plus size={13} aria-hidden /> Add
            </button>
            <button
              type="button"
              onClick={() => tips.onDismiss(worksWithTipId(b.manifest.id), "person")}
              className="p-1 text-faint hover:text-content shrink-0"
              aria-label={`Not interested in ${b.manifest.name}`}
              title="Not interested"
            >
              <X size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default WorksWith;
