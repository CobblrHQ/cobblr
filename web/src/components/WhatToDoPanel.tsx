// "What do you want to do?" — the funnel-distillation onboarding homepage.
//
// The problem it solves: a brand-new user stares at an empty workspace and
// can't find the on-ramp. This panel gives ONE question and THREE converging
// ways to answer it, all driven by a single distilling search:
//
//   ┌ Ready-made setups ┐ ┌ Building blocks ┐ ┌ Build it yourself ┐
//   │ recipes (bundles)  │ │ capabilities     │ │ describe / scan / │
//   │                    │ │ (modules)        │ │ AI               │
//
// The search up top is the distillation: type "parts" and all three lanes
// narrow to it at once. The convergence of modules+bundles is explicit — pick a
// building block ("Inventory") and the recipes lane filters to ITS ready-made
// versions ("like what? → Home Inventory, Filament, Yarn…"), plus a "start
// blank" option. So the user walks down the funnel: track something → what kind
// → like what → set up.
//
// Reuses the data + actions proven in CaptureFirstPanel (bundle catalog, module
// list, enable/install/capture), restructured into the explicit 3-lane funnel.

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { Search, Camera, Sparkles, ArrowRight, Loader2, Boxes, Wand2, Plus, ChevronLeft, Package } from "lucide-react";
import { api, type OrgModuleListItem } from "../lib/api";
import { useBundleCatalog, type CatalogBundle } from "../lib/useBundleCatalog";
import { fuzzyMatch } from "../lib/fuzzy";
import { BundleDetailModal } from "./BundleDetailModal";

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

function LaneHeader({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">{kicker}</div>
      <div className="text-sm font-semibold text-content dark:text-mortar-100">{title}</div>
    </div>
  );
}

export function WhatToDoPanel({ slug }: { slug: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [drillModule, setDrillModule] = useState<string | null>(null); // a picked building block
  const [picked, setPicked] = useState<CatalogBundle | null>(null);

  const q = query.trim().toLowerCase();

  // ── data ────────────────────────────────────────────────────────────────
  const { registry, catalog } = useBundleCatalog();
  const modulesQ = useQuery({
    queryKey: ["org-modules", slug],
    queryFn: () => api.orgModules(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
  // After a user scans/captures things, the matchmaker clusters them and offers
  // a ready-made tracker ("these look like yarn — make a Yarn tracker (3)").
  // Keep that high-value nudge here so capturing-first still converges on a
  // setup right from the homepage.
  const quick = useQuery({
    queryKey: ["quickstart", slug],
    queryFn: () => api.quickstart(slug),
    enabled: !!slug,
    refetchInterval: 5000,
  });
  const suggestions = quick.data?.suggestions ?? [];

  // Building blocks = the workspace's not-yet-enabled DOMAIN modules (stock,
  // bare-named = a real nav noun). Filtered by the search.
  const domainModules = useMemo(
    () =>
      (modulesQ.data?.items ?? []).filter(
        (m) => !m.enabled && m.band === "stock" && !m.name.startsWith("core-"),
      ),
    [modulesQ.data],
  );
  const moduleMatches = useMemo(() => {
    if (!q) return domainModules;
    return domainModules.filter((m) => fuzzyMatch(`${m.displayName} ${m.description} ${m.name}`, q));
  }, [domainModules, q]);

  // Recipes = flagship bundles, simplest-first; a search spans the whole
  // catalog; a drilled building block narrows to ITS bundles.
  const recipes = useMemo(() => {
    const byReq = (b: CatalogBundle) =>
      !drillModule || (b.manifest.requires ?? []).some((r) => r.module === drillModule);
    const base = q
      ? catalog.filter((b) =>
          fuzzyMatch(`${b.manifest.name} ${b.blurb ?? ""} ${b.manifest.description ?? ""}`, q),
        )
      : catalog.filter((b) => b.manifest.id.includes(".flagship."));
    return base
      .filter(byReq)
      .sort(
        (a, b) =>
          (a.manifest.requires?.length ?? 0) - (b.manifest.requires?.length ?? 0) ||
          a.manifest.name.localeCompare(b.manifest.name),
      );
  }, [catalog, q, drillModule]);

  // ── actions ─────────────────────────────────────────────────────────────
  const enableModuleMut = useMutation({
    mutationFn: (name: string) => api.enableModule(slug, name),
    onSuccess: (_r, name) => {
      void qc.invalidateQueries();
      const m = (modulesQ.data?.items ?? []).find((x) => x.name === name);
      toast.success(`Added ${m?.displayName ?? name}.`);
      navigate(`/${name}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add that"),
  });
  const noteMut = useMutation({
    mutationFn: (t: string) => api.scanNote(slug, t),
    onSuccess: () => {
      setQuery("");
      void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] });
      toast.success("Added — finding the right tracker…");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add that"),
  });
  const materializeMut = useMutation({
    mutationFn: (bundleId: string) => api.materializeQuickstart(slug, bundleId),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(`Created your ${r.label ?? "tracker"} with ${r.created} item${r.created === 1 ? "" : "s"}.`);
      if (r.route) navigate(r.route);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't set that up"),
  });

  const drillModuleObj: OrgModuleListItem | undefined = drillModule
    ? (modulesQ.data?.items ?? []).find((m) => m.name === drillModule)
    : undefined;

  return (
    <section className="rounded-xl border-2 border-dashed border-cobble-300 dark:border-cobble-700 bg-cobble-50/30 dark:bg-cobble-900/10 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-accent" />
        <h2 className="font-semibold text-content dark:text-mortar-100">What do you want to do?</h2>
      </div>

      {/* The distilling search — narrows all three lanes at once. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="I want to track… e.g. parts, yarn, a 3D printer, the pantry"
            aria-label="What do you want to track"
            className="input !pl-9"
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) noteMut.mutate(query.trim());
            }}
          />
        </div>
        <Link
          to="/scan/camera"
          title="Scan a barcode or snap a photo"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 px-3 py-2 text-sm font-medium text-content dark:text-mortar-100 hover:border-cobble-400 transition"
        >
          <Camera size={16} /> Scan
        </Link>
      </div>

      {/* Captured-things nudge: "these look like yarn — make a Yarn tracker (3)". */}
      {suggestions.length > 0 && (
        <div className="space-y-2">
          {suggestions.map((s) => (
            <button
              key={s.bundle_external_id}
              type="button"
              disabled={materializeMut.isPending}
              onClick={() => materializeMut.mutate(s.bundle_external_id)}
              className="w-full flex items-center gap-3 rounded-lg border border-accent/40 bg-accent/5 dark:bg-cobble-900/20 px-4 py-3 hover:bg-accent/10 transition group text-left disabled:opacity-60"
            >
              <span className="w-9 h-9 rounded-full bg-accent/15 text-accent flex items-center justify-center shrink-0">
                {materializeMut.isPending && materializeMut.variables === s.bundle_external_id ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Package size={18} />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-content dark:text-mortar-100">
                  These look like {s.noun} — make a {s.bundle_name} tracker
                  <span className="ml-1 text-faint">({s.count})</span>
                </div>
                <div className="text-xs text-faint dark:text-slate-400 truncate">
                  {s.sample_names.join(" · ") || "File your captures into a ready-made table"}
                </div>
              </div>
              <ArrowRight size={16} className="text-accent group-hover:translate-x-0.5 transition shrink-0" />
            </button>
          ))}
        </div>
      )}

      {/* Drill breadcrumb — "you picked Inventory; here are its ready-made versions". */}
      {drillModuleObj && (
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setDrillModule(null)}
            className="inline-flex items-center gap-1 text-faint dark:text-slate-400 hover:text-accent transition"
          >
            <ChevronLeft size={14} /> all
          </button>
          <span className="text-faint dark:text-slate-600">/</span>
          <span className="font-medium text-content dark:text-mortar-100">{drillModuleObj.displayName}</span>
          <span className="text-faint dark:text-slate-400">— pick a ready-made version, or</span>
          <button
            type="button"
            disabled={enableModuleMut.isPending}
            onClick={() => enableModuleMut.mutate(drillModuleObj.name)}
            className="inline-flex items-center gap-1 rounded bg-cobble-600 text-white text-xs font-medium px-2 py-1 hover:bg-cobble-700 transition disabled:opacity-50"
          >
            {enableModuleMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            start a blank {drillModuleObj.displayName}
          </button>
        </div>
      )}

      {/* The three converging lanes. */}
      <div className="grid gap-3 md:grid-cols-3">
        {/* Lane 1 — Ready-made setups (bundles) */}
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40 p-3">
          <LaneHeader kicker="// recipes" title={drillModuleObj ? `${drillModuleObj.displayName} setups` : "Ready-made setups"} />
          <p className="text-xs text-faint dark:text-slate-500 mb-2">Pick a recipe and you're set up in one click.</p>
          {registry.isLoading && recipes.length === 0 ? (
            <div className="text-xs text-faint dark:text-slate-500 py-2">Loading…</div>
          ) : recipes.length === 0 ? (
            <p className="text-xs text-faint dark:text-slate-500 py-1">
              {q ? `No ready-made setup for “${query.trim()}” — build it on the right →` : "Nothing here yet."}
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-80 overflow-y-auto">
              {recipes.map((b) => (
                <li key={b.manifest.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(b)}
                    className="w-full text-left rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2.5 flex items-start gap-2.5 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
                  >
                    <div className="text-xl shrink-0 leading-none mt-0.5">{b.glyph}</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-content dark:text-mortar-100 text-sm">{b.manifest.name}</div>
                      <div className="text-xs text-faint dark:text-slate-400 line-clamp-2">{b.blurb}</div>
                    </div>
                    <ArrowRight size={13} className="text-faint dark:text-slate-600 group-hover:text-accent transition mt-1 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Lane 2 — Building blocks (modules) */}
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40 p-3">
          <LaneHeader kicker="// building blocks" title="Start from a capability" />
          <p className="text-xs text-faint dark:text-slate-500 mb-2">Pick the kind of thing, then narrow it down.</p>
          {moduleMatches.length === 0 ? (
            <p className="text-xs text-faint dark:text-slate-500 py-1">
              {q ? `No capability matches “${query.trim()}”.` : "All set — every capability is on."}
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-80 overflow-y-auto">
              {moduleMatches.map((m) => (
                <li key={m.name}>
                  <button
                    type="button"
                    onClick={() => setDrillModule(m.name)}
                    className={
                      "w-full text-left rounded-lg border p-2.5 flex items-start gap-2.5 transition group " +
                      (drillModule === m.name
                        ? "border-accent bg-accent/5"
                        : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900 hover:border-cobble-300 dark:hover:border-cobble-700")
                    }
                  >
                    <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
                      <Boxes size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-content dark:text-mortar-100 text-sm">{m.displayName}</div>
                      <div className="text-xs text-faint dark:text-slate-400 line-clamp-2">{firstSentence(m.description)}</div>
                    </div>
                    <ArrowRight size={13} className="text-faint dark:text-slate-600 group-hover:text-accent transition mt-1 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Lane 3 — Build it yourself (describe / scan / AI) */}
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40 p-3">
          <LaneHeader kicker="// your own" title="Build it yourself" />
          <p className="text-xs text-faint dark:text-slate-500 mb-2">Don't see it? Describe what you have — Cobblr works out the structure.</p>
          <div className="space-y-1.5">
            {q && (
              <button
                type="button"
                disabled={noteMut.isPending}
                onClick={() => noteMut.mutate(query.trim())}
                className="w-full text-left rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50/50 dark:bg-cobble-900/20 p-2.5 flex items-center gap-2.5 hover:border-cobble-400 transition disabled:opacity-60"
              >
                <span className="w-8 h-8 rounded-full bg-cobble-600 text-white flex items-center justify-center shrink-0">
                  {noteMut.isPending ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                </span>
                <span className="text-sm text-content dark:text-mortar-100">
                  Add <span className="font-medium">“{query.trim()}”</span>
                  <span className="block text-xs text-faint dark:text-slate-400">I'll find or build the right tracker</span>
                </span>
              </button>
            )}
            <Link
              to="/build"
              className="w-full text-left rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2.5 flex items-center gap-2.5 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
            >
              <span className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
                <Wand2 size={16} />
              </span>
              <span className="text-sm text-content dark:text-mortar-100">
                Describe what you have
                <span className="block text-xs text-faint dark:text-slate-400">The AI builder compiles a custom setup</span>
              </span>
              <ArrowRight size={13} className="text-faint dark:text-slate-600 group-hover:text-accent transition ml-auto shrink-0" />
            </Link>
            <Link
              to="/scan/camera"
              className="w-full text-left rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2.5 flex items-center gap-2.5 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
            >
              <span className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
                <Camera size={16} />
              </span>
              <span className="text-sm text-content dark:text-mortar-100">
                Scan a barcode or photo
                <span className="block text-xs text-faint dark:text-slate-400">Point your camera; it lands ready to file</span>
              </span>
              <ArrowRight size={13} className="text-faint dark:text-slate-600 group-hover:text-accent transition ml-auto shrink-0" />
            </Link>
          </div>
        </div>
      </div>

      <Link to="/bundles" className="inline-block text-xs text-faint dark:text-slate-400 hover:text-accent transition">
        or browse the full marketplace →
      </Link>

      {picked && (
        <BundleDetailModal
          key={picked.manifest.id}
          open
          onClose={() => setPicked(null)}
          slug={slug}
          mode="featured"
          manifest={picked.manifest}
          glyph={picked.glyph}
          blurb={picked.blurb}
          nextSteps={picked.next_steps}
          autoLand
        />
      )}
    </section>
  );
}
