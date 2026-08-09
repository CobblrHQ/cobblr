// Open a bundle's detail modal WHERE YOU ARE.
//
// House rule (reported 2026-08-01): a modal appears on the page it was invoked
// from. Six places used to answer "show me that bundle" by navigating to
// /bundles and opening the modal there, which is a different page behind a
// dialog, and — worse — throws away whatever the user was in the middle of.
// The reported case: the Build page's ready-made callout. You type an intent,
// click "View & install", land on Bundles, close the modal, go back, and your
// typing is gone.
//
// Two of those sites had already noticed and bolted a `returnTo` param onto the
// URL. BundlesPage never read it, so even the workaround was dead code.
//
// Usage — two lines at any call site:
//   const bundleDetail = useBundleDetail(slug);
//   <button onClick={() => bundleDetail.open(externalId)}>details</button>
//   {bundleDetail.element}
//
// Falls back to the old navigation ONLY when the id isn't in the catalog (a
// hand-installed or third-party bundle we can't render a manifest for), so
// nothing becomes unreachable.

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useBundleCatalog } from "../lib/useBundleCatalog";
import { BundleDetailModal } from "./BundleDetailModal";

export function useBundleDetail(slug: string): {
  /** Open the modal for a bundle's external id, in place. */
  open: (externalId: string) => void;
  /** Render this once in the caller's tree. */
  element: ReactNode;
} {
  const navigate = useNavigate();
  const { catalog } = useBundleCatalog();
  const [openId, setOpenId] = useState<string | null>(null);
  const installed = useQuery({
    queryKey: ["bundles", slug],
    queryFn: () => api.listBundles(slug),
    enabled: !!slug,
    staleTime: 30_000,
  });

  const bundle = openId ? catalog.find((b) => b.manifest.id === openId) : undefined;
  const row = openId ? installed.data?.items.find((b) => b.external_id === openId) : undefined;

  const open = (externalId: string) => {
    // Not in the catalog → we have no manifest to render; the marketplace page
    // is still the honest destination for it.
    if (!catalog.some((b) => b.manifest.id === externalId)) {
      navigate(`/bundles?open=${encodeURIComponent(externalId)}`);
      return;
    }
    setOpenId(externalId);
  };

  const element = bundle ? (
    <BundleDetailModal
      key={bundle.manifest.id}
      open
      onClose={() => setOpenId(null)}
      slug={slug}
      mode="featured"
      manifest={bundle.manifest}
      glyph={bundle.glyph}
      blurb={bundle.blurb}
      nextSteps={bundle.next_steps}
      alreadyInstalled={!!row}
      installedVersion={row?.version ?? null}
    />
  ) : null;

  return { open, element };
}
