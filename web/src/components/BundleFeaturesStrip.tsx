// "More from <bundle>" strip for an instance page. When an instance was created
// by a bundle that has OPT-IN features you haven't enabled yet (a Vehicles
// instance from the Vehicles bundle, with maintenance / connected-car off), this
// surfaces them at the top of the page and opens the bundle's install modal to
// turn them on — the answer to "how do I enable more after the inbox CTA?".
//
// A component (not a page) so it can import BundleDetailModal without tripping
// the page→page lint. Renders nothing unless the instance's bundle has a
// not-yet-enabled feature.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { BundleDetailModal } from "./BundleDetailModal";

export function BundleFeaturesStrip({ slug, instance }: { slug: string; instance: string }) {
  const [open, setOpen] = useState(false);
  const bundlesQ = useQuery({
    queryKey: ["bundles", slug],
    queryFn: () => api.listBundles(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
  // The bundle that created THIS instance = the installed bundle whose manifest
  // declares it in provides_instances. (Owner/admin only ever see this act, but
  // the query is harmless for anyone; the modal enforces the role.)
  const bundle = (bundlesQ.data?.items ?? []).find((b) =>
    (b.manifest?.provides_instances ?? []).some((pi) => pi.instance_name === instance),
  );
  if (!bundle) return null;
  const enabled = new Set(bundle.enabled_features ?? []);
  const off = (bundle.manifest?.features ?? []).filter((f) => !enabled.has(f.key));
  if (off.length === 0) return null; // everything's already on

  return (
    <section className="rounded-lg border border-accent/40 bg-accent/[0.06] dark:bg-accent/10 px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Sparkles size={15} className="text-accent shrink-0" />
      <span className="text-sm text-content dark:text-mortar-100">
        More you can turn on from <strong>{bundle.name}</strong>:
      </span>
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
        {off.map((f) => (
          <span
            key={f.key}
            title={f.description ?? f.question ?? undefined}
            className="inline-flex items-center rounded-full border border-accent/30 bg-surface dark:bg-slate-900 px-2.5 py-0.5 text-xs text-muted dark:text-slate-300"
          >
            {f.name}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-xs font-medium transition shrink-0"
      >
        Enable features
      </button>
      {open && (
        // The installed-bundle modal has the feature checkboxes (pre-seeded from
        // enabled_features) + applies the change / offers an update.
        <BundleDetailModal open onClose={() => setOpen(false)} slug={slug} mode="installed" bundle={bundle} />
      )}
    </section>
  );
}
