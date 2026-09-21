// Setting up a bundle from a capture ("2 look like Groceries, create it & file
// all 2"), the one way, wherever the press happens.
//
// Two surfaces press this: the scanner queue at the top of the dashboard and
// the typed-capture column of the What-do-you-want-to-do panel. They used to
// carry two copies of the same plumbing (a mutation, a feature-picker modal,
// the landing rule), and two copies of a rule drift. One hook now: a bundle
// with optional capabilities opens the feature-picker first and files the
// captures after the install; one with nothing to choose (or not in the
// catalog) is the one-shot install-and-file. Either way the landing is
// materializeLanding's: the banner speaks when there is a page to land on.

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api } from "./api";
import { useBundleCatalog, type CatalogBundle } from "./useBundleCatalog";
import { materializeLanding, type MaterializeResult } from "./materializeLanding";
import { BundleDetailModal } from "../components/BundleDetailModal";

export function useMaterializeCapture(slug: string): {
  /** Press for a bundle id: opens the picker or runs the one-shot. */
  start: (bundleId: string) => void;
  /** True while THIS bundle id is being set up (the one-shot path). */
  busy: (bundleId: string) => boolean;
  /** The feature-picker, when open. Render it once, anywhere in the tree. */
  modal: ReactNode;
  /** The landing rule, for callers that materialize by another route. */
  land: (r: MaterializeResult) => void;
} {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { catalog } = useBundleCatalog();
  const [picking, setPicking] = useState<CatalogBundle | null>(null);

  const land = (r: MaterializeResult) => {
    void qc.invalidateQueries();
    const l = materializeLanding(r);
    if (l.toast) toast.success(l.toast);
    if (l.to) navigate(l.to);
  };
  const oneShot = useMutation({
    mutationFn: (bundleId: string) => api.materializeQuickstart(slug, bundleId),
    onSuccess: land,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't set that up"),
  });
  const start = (bundleId: string) => {
    const cb = catalog.find((b) => b.manifest.id === bundleId);
    if (cb?.manifest.features?.length) setPicking(cb);
    else oneShot.mutate(bundleId);
  };
  const busy = (bundleId: string) => oneShot.isPending && oneShot.variables === bundleId;
  const modal = picking ? (
    <BundleDetailModal
      key={`capture:${picking.manifest.id}`}
      open
      onClose={() => setPicking(null)}
      slug={slug}
      mode="featured"
      manifest={picking.manifest}
      glyph={picking.glyph}
      blurb={picking.blurb}
      nextSteps={picking.next_steps}
      // The modal installs with the chosen capabilities; then the captures that
      // matched this bundle are filed onto the tables it just created.
      onInstalled={async () => {
        const r = await api.materializeQuickstart(slug, picking.manifest.id, { skip_install: true });
        setPicking(null);
        land(r);
      }}
    />
  ) : null;
  return { start, busy, modal, land };
}
