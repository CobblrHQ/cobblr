// "What do you want to do?" — the funnel-distillation onboarding homepage (v2).
//
// One question, then three columns + a build-it CTA + a mini scan inbox:
//
//   [ ✨ Describe what you have → AI builds it ]      ← build-it CTA (above)
//
//   ┌ Building blocks ┐ ┌ Ready-made setups ┐ ┌ Add your first thing ┐
//   │ [type a kind…]   │ │ [find a recipe…]   │ │ [add a 3d printer…]  │
//   │ Inventory        │ │ 🏠 Home Inventory   │ │  + 📷 Scan            │
//   │ Machines         │ │ 🧵 Yarn             │ │                       │
//   └──────────────────┘ └─────────────────────┘ └───────────────────────┘
//
//   [ mini scan inbox — what you've captured shows here ]   ← below
//
// Every column takes free text and acts on it: type in Building blocks to
// drill into that kind's recipes ("machine → what kind?"); type in Ready-made
// to filter/open a recipe; type in "Add your first thing" to capture it and
// have Cobblr find/build the tracker. Pick a building block and the recipes
// column funnels to ITS ready-made versions — modules and bundles converge.
//
// Reuses CaptureFirstPanel's proven data + actions, restructured per the author's
// feedback (swap the first two columns; build-it-yourself is a CTA, not a lane;
// the 3rd column is the guided add + scan; a mini scan inbox lives below).

import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { Search, Camera, Sparkles, ArrowRight, Loader2, Boxes, Wand2, Plus, ChevronDown, ChevronUp, Package, X } from "lucide-react";
import { api } from "../lib/api";
import { useBundleCatalog, type CatalogBundle } from "../lib/useBundleCatalog";
import { fuzzyMatch } from "../lib/fuzzy";
import { BundleDetailModal } from "./BundleDetailModal";
import { PairPhoneButton } from "./PairPhoneButton";

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

function LaneHeader({ kicker, title, count }: { kicker: string; title: string; count?: number }) {
  return (
    <div className="mb-2 flex items-start justify-between gap-2">
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">{kicker}</div>
        <div className="text-sm font-semibold text-content dark:text-mortar-100">{title}</div>
      </div>
      {typeof count === "number" && count > 0 && (
        <span className="mt-0.5 shrink-0 rounded-full bg-subtle dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-muted dark:text-slate-400">
          {count}
        </span>
      )}
    </div>
  );
}

/** A scrollable card list that makes "there's more below" obvious: a bottom
 *  fade-out + a "↓ N more" hint when the list overflows its max height. Tall by
 *  default — the homepage has the vertical room, so show as many entries as fit
 *  before scrolling kicks in. */
function ScrollList({ count, visible = 9, children }: { count: number; visible?: number; children: ReactNode }) {
  const overflow = count > visible;
  return (
    <div className="relative">
      <ul className={"space-y-1.5 overflow-y-auto pr-1 " + (overflow ? "max-h-[40rem] pb-5" : "")}>{children}</ul>
      {overflow && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-cobble-50 via-cobble-50/90 dark:from-slate-900 dark:via-slate-900/90 to-transparent rounded-b" />
          <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center">
            <span className="rounded-full bg-surface dark:bg-slate-800 border border-line dark:border-slate-700 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-300 shadow-sm">
              ↓ {count - visible} more
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** Name a bare photo capture that couldn't be auto-identified — naming it
 *  triggers a server re-match so the heuristic routes it. */
function NameIt({ slug, itemId }: { slug: string; itemId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const mut = useMutation({
    mutationFn: () => api.updateScanItem(slug, itemId, { name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] });
      toast.success("Got it — finding the right tracker…");
    },
  });
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What is this? e.g. blue worsted yarn"
        className="input !py-1 !text-xs flex-1"
        onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) mut.mutate(); }}
      />
      <button
        type="button"
        disabled={!name.trim() || mut.isPending}
        onClick={() => mut.mutate()}
        className="shrink-0 rounded bg-cobble-600 text-white text-xs font-medium px-2.5 py-1 hover:bg-cobble-700 transition disabled:opacity-50"
      >
        Identify
      </button>
    </div>
  );
}

// Per-kind onboarding vocabulary — see docs/design-decisions/what-to-do-funnel.md.
// Multi-instance domains create a *category* (a named instance) first, then items
// inside it; the examples make the LEVEL concrete so col 3 never offers an item
// where a category belongs (the "a 3D printer under Assets" bug).
const KIND_VOCAB: Record<string, { categoryEg: string; itemEg: string }> = {
  assets: { categoryEg: "Cars, Cameras, Instruments", itemEg: "your first car" },
  inventory: { categoryEg: "Printer Parts, Pantry, Craft Supplies", itemEg: "a pulley, a can of beans" },
  machines: { categoryEg: "3D Printers, Laser Cutters, CNC", itemEg: "an Ender 3" },
  projects: { categoryEg: "Home Reno, Garage Build", itemEg: "your first task" },
  purchases: { categoryEg: "Amazon, Hardware Store", itemEg: "an order" },
};

// Option (a): capability modules that OPERATE ON a domain — their recipes surface
// under the capability too (Digital Fabrication fabricates *with* machines, so
// 3D Printers/CNC/Lasers show under it). Interim affinity until it's a declared
// module relationship — see the design doc.
const OPERATES_ON: Record<string, string[]> = {
  digifab: ["machines"],
};

const slugifyName = (s: string): string =>
  s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");

export function WhatToDoPanel({ slug, startCollapsed = false }: { slug: string; startCollapsed?: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // The panel persists once the workspace has content (startCollapsed) so you
  // can keep adding via the guided flow — collapsed by default, expandable, and
  // the choice is remembered per workspace. (showToggle / showBody are derived
  // below, AFTER captures load, so a pending scan inbox keeps the panel open.)
  const openKey = `cobblr.whatToDo.open:${slug}`;
  const [open, setOpen] = useState<boolean>(() => {
    if (!startCollapsed) return true;
    try { return localStorage.getItem(openKey) === "1"; } catch { return false; }
  });
  const setOpenPersist = (v: boolean) => {
    setOpen(v);
    try { localStorage.setItem(openKey, v ? "1" : "0"); } catch { /* ignore */ }
  };

  // One input per column ("at each of the 3 columns you can type something in").
  const [blockQ, setBlockQ] = useState("");
  const [recipeQ, setRecipeQ] = useState("");
  const [addText, setAddText] = useState("");
  const [categoryName, setCategoryName] = useState(""); // col 3: a new category (named instance)
  // A no-camera desktop scans by pairing a phone (QR → phone signs in to THIS
  // workspace → its camera scans land in the inbox below); touch devices use
  // their own camera. Decide once on mount.
  const [isTouch] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches);
  // The funnel selection: a kind (col 1) narrows the recipes (col 2); a recipe
  // (col 2) is the chosen setup that col 3 (the captive "add your first one"
  // step) acts on. They flow left→right and drive col 3.
  const [selectedModule, setSelectedModule] = useState<string | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<CatalogBundle | null>(null);
  const [picked, setPicked] = useState<CatalogBundle | null>(null); // "details" modal only

  // ── data ────────────────────────────────────────────────────────────────
  const { registry, catalog } = useBundleCatalog();
  const modulesQ = useQuery({
    queryKey: ["org-modules", slug],
    queryFn: () => api.orgModules(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
  const inbox = useQuery({
    queryKey: ["capture-inbox", slug],
    queryFn: () => api.listScanInbox(slug, { status: "pending" }),
    enabled: !!slug,
    refetchInterval: 4000,
  });
  const quick = useQuery({
    queryKey: ["quickstart", slug],
    queryFn: () => api.quickstart(slug),
    enabled: !!slug,
    refetchInterval: 5000,
  });

  const domainModules = useMemo(
    () =>
      (modulesQ.data?.items ?? []).filter(
        (m) => !m.enabled && m.band === "stock" && !m.name.startsWith("core-"),
      ),
    [modulesQ.data],
  );
  const blockMatches = useMemo(() => {
    const q = blockQ.trim().toLowerCase();
    if (!q) return domainModules;
    return domainModules.filter((m) => fuzzyMatch(`${m.displayName} ${m.description} ${m.name}`, q));
  }, [domainModules, blockQ]);

  const recipes = useMemo(() => {
    const q = recipeQ.trim().toLowerCase();
    // A recipe belongs to a kind if it REQUIRES it OR PROVISIONS an instance of
    // it. The machine specialisations (3D Printers / Laser Cutters / CNC) are
    // provides_instances of `machines`, so this surfaces them under Machines.
    const operatesOn = OPERATES_ON[selectedModule ?? ""] ?? [];
    const relatesTo = (b: CatalogBundle, mod: string) =>
      (b.manifest.requires ?? []).some((r) => r.module === mod) ||
      (b.manifest.provides_instances ?? []).some((i) => i.module === mod) ||
      // option (a): a capability's recipes = the recipes of the domains it operates on
      operatesOn.some((dom) => (b.manifest.requires ?? []).some((r) => r.module === dom) || (b.manifest.provides_instances ?? []).some((i) => i.module === dom));
    const byKind = (b: CatalogBundle) => !selectedModule || relatesTo(b, selectedModule);
    // Base set: a search OR a chosen kind spans the WHOLE catalog, so the
    // community specialisations (3D Printers, …) show — not just the curated
    // flagship default you see when nothing is picked.
    const base = q
      ? catalog.filter((b) => fuzzyMatch(`${b.manifest.name} ${b.blurb ?? ""} ${b.manifest.description ?? ""}`, q))
      : selectedModule
        ? catalog
        : catalog.filter((b) => b.manifest.id.includes(".flagship."));
    return base
      .filter(byKind)
      .sort(
        (a, b) =>
          (a.manifest.requires?.length ?? 0) - (b.manifest.requires?.length ?? 0) ||
          a.manifest.name.localeCompare(b.manifest.name),
      );
  }, [catalog, recipeQ, selectedModule]);

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
      setAddText("");
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
  const discardMut = useMutation({
    mutationFn: (id: string) => api.discardScanItem(slug, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] }),
  });
  // Col 3 for a multi-instance kind: create a new CATEGORY (a named instance) and
  // drop the user in to add items — the kind → category → item model.
  const createInstanceMut = useMutation({
    mutationFn: async ({ module_name, name }: { module_name: string; name: string }) => {
      // The kind must be enabled before it can host an instance. On a fresh
      // workspace it isn't yet — enable it first (idempotent), then create.
      if (!(modulesQ.data?.items ?? []).find((m) => m.name === module_name)?.enabled) {
        await api.enableModule(slug, module_name).catch(() => undefined);
      }
      return api.createInstance(slug, { module_name, instance_name: slugifyName(name), display_name: name.trim() });
    },
    onSuccess: (inst) => {
      void qc.invalidateQueries();
      setCategoryName("");
      toast.success(`Created ${inst.display_name}.`);
      navigate(`/instances/${inst.instance_name}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't create that category"),
  });
  // Captive setup: install the recipe and drop the user straight into it (no
  // modal) — that's the "and you're in" end of the funnel.
  const setupRecipeMut = useMutation({
    mutationFn: (b: CatalogBundle) => api.installBundle(slug, b.manifest, true),
    onSuccess: (_r, b) => {
      void qc.invalidateQueries();
      toast.success(`Set up ${b.manifest.name}.`);
      navigate(b.next_steps?.[0]?.path ?? "/dashboard");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't set that up"),
  });

  // Picking a kind narrows the recipes + resets the recipe choice; picking it
  // again clears back to everything. Picking a recipe also implies its kind.
  const pickModule = (name: string) =>
    setSelectedModule((cur) => {
      const next = cur === name ? null : name;
      setSelectedRecipe(null);
      return next;
    });
  const pickRecipe = (b: CatalogBundle) =>
    // Just select/deselect the recipe (drives col 3). Leave the chosen KIND
    // alone — picking a recipe shouldn't hijack the column you were browsing
    // (Maker Workshop depends on inventory, but you got there via Builds).
    setSelectedRecipe((cur) => (cur?.manifest.id === b.manifest.id ? null : b));

  const selectedModuleObj = selectedModule ? (modulesQ.data?.items ?? []).find((m) => m.name === selectedModule) : undefined;
  // A multi-instance kind has a CATEGORY level (create a named instance first);
  // single-instance kinds go straight in. Vocab keeps col 3's examples on the
  // right level (category vs item) per kind.
  const kindIsMulti = selectedModuleObj?.instanceability === "multi";
  const kindVocab = selectedModuleObj ? KIND_VOCAB[selectedModuleObj.name] : undefined;
  // A picked recipe's item example beats the kind's — a Gifts/Filament bundle
  // shouldn't suggest "a pulley". Use the bundle's shipped item_example, else
  // derive "your first <item_noun>" from its first provided instance.
  const recipeItemEg = selectedRecipe
    ? selectedRecipe.item_example ??
      (selectedRecipe.manifest.provides_instances?.[0]?.item_noun
        ? `your first ${selectedRecipe.manifest.provides_instances[0]!.item_noun}`
        : undefined)
    : undefined;
  const itemPlaceholder = recipeItemEg ?? kindVocab?.itemEg ?? "a 3D printer, a box of screws…";
  const items = inbox.data?.items ?? [];
  const suggestions = quick.data?.suggestions ?? [];
  // Collapse only when there's content AND nothing pending to act on — a pending
  // scan inbox / "make a tracker" suggestion forces the panel open so your
  // captures always show on the home page.
  const hasPending = items.length > 0 || suggestions.length > 0;
  const showToggle = startCollapsed && !hasPending;
  const showBody = showToggle ? open : true;

  return (
    <section className="rounded-xl border-2 border-dashed border-cobble-300 dark:border-cobble-700 bg-cobble-50/30 dark:bg-cobble-900/10 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-accent" />
        <h2 className="font-semibold text-content dark:text-mortar-100 flex-1">What do you want to do?</h2>
        {showToggle && (
          <button
            type="button"
            onClick={() => setOpenPersist(!open)}
            className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-content dark:text-mortar-200 hover:border-accent transition"
          >
            {open ? (<>Collapse <ChevronUp size={13} /></>) : (<>Add more <ChevronDown size={13} /></>)}
          </button>
        )}
      </div>

      {showBody && (<>
      {/* Build-it-yourself CTA — a button, not a column (per feedback). */}
      <Link
        to="/build"
        className="flex items-center gap-3 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 px-4 py-2.5 hover:border-cobble-400 transition group"
      >
        <span className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
          <Wand2 size={16} />
        </span>
        <span className="flex-1 text-sm text-content dark:text-mortar-100">
          <span className="font-medium">Describe what you have</span>
          <span className="text-faint dark:text-slate-400"> — the AI builder compiles a custom setup, fields and all.</span>
        </span>
        <ArrowRight size={15} className="text-faint group-hover:text-accent transition shrink-0" />
      </Link>

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
                {materializeMut.isPending && materializeMut.variables === s.bundle_external_id ? <Loader2 size={18} className="animate-spin" /> : <Package size={18} />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-content dark:text-mortar-100">
                  These look like {s.noun} — make a {s.bundle_name} tracker <span className="ml-1 text-faint">({s.count})</span>
                </div>
                <div className="text-xs text-faint dark:text-slate-400 truncate">{s.sample_names.join(" · ") || "File your captures into a ready-made table"}</div>
              </div>
              <ArrowRight size={16} className="text-accent group-hover:translate-x-0.5 transition shrink-0" />
            </button>
          ))}
        </div>
      )}

      {/* The three columns. Order: Building blocks · Ready-made · Add your first
          thing. The selection state lives IN the columns (highlights + col 3's
          reactive prompt) — no separate breadcrumb bar that pushes content down. */}
      <div className="grid gap-3 md:grid-cols-3">
        {/* Col 1 — Building blocks (modules) */}
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40 p-3">
          <LaneHeader kicker="// building blocks" title="Track a kind of thing" count={blockMatches.length} />
          <div className="relative mb-2">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
            <input
              value={blockQ}
              onChange={(e) => setBlockQ(e.target.value)}
              placeholder="e.g. machines, projects…"
              className="input !pl-8 !py-1.5 !text-sm"
              onKeyDown={(e) => { if (e.key === "Enter" && blockMatches[0]) pickModule(blockMatches[0].name); }}
            />
          </div>
          {blockMatches.length === 0 ? (
            <p className="text-xs text-faint dark:text-slate-500 py-1">{blockQ ? `No capability matches “${blockQ.trim()}”.` : "All set."}</p>
          ) : (
            <ScrollList count={blockMatches.length}>
              {blockMatches.map((m) => (
                <li key={m.name}>
                  <button
                    type="button"
                    // Click to narrow the recipes to this kind + prime col 3; click
                    // the SAME one again to deselect and go back to everything.
                    onClick={() => pickModule(m.name)}
                    title={selectedModule === m.name ? "Click again to see everything" : undefined}
                    className={
                      "w-full text-left rounded-lg border p-2.5 flex items-start gap-2.5 transition group " +
                      (selectedModule === m.name ? "border-accent bg-accent/5" : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900 hover:border-cobble-300 dark:hover:border-cobble-700")
                    }
                  >
                    <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0"><Boxes size={16} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-content dark:text-mortar-100 text-sm">{m.displayName}</div>
                      <div className="text-xs text-faint dark:text-slate-400 line-clamp-2">{firstSentence(m.description)}</div>
                    </div>
                    <ArrowRight size={13} className="text-faint dark:text-slate-600 group-hover:text-accent transition mt-1 shrink-0" />
                  </button>
                </li>
              ))}
            </ScrollList>
          )}
        </div>

        {/* Col 2 — Ready-made setups (bundles) */}
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40 p-3">
          <LaneHeader kicker="// recipes" title={selectedModuleObj ? `${selectedModuleObj.displayName} setups` : "Ready-made setups"} count={recipes.length} />
          <div className="relative mb-2">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
            <input
              value={recipeQ}
              onChange={(e) => setRecipeQ(e.target.value)}
              placeholder="e.g. yarn, filament…"
              className="input !pl-8 !py-1.5 !text-sm"
              onKeyDown={(e) => { if (e.key === "Enter" && recipes[0]) pickRecipe(recipes[0]); }}
            />
          </div>
          {registry.isLoading && recipes.length === 0 ? (
            <div className="text-xs text-faint dark:text-slate-500 py-2">Loading…</div>
          ) : recipes.length === 0 ? (
            <p className="text-xs text-faint dark:text-slate-500 py-1">{recipeQ ? `No ready-made setup for “${recipeQ.trim()}”.` : "Nothing here yet."}</p>
          ) : (
            <ScrollList count={recipes.length}>
              {recipes.map((b) => {
                const on = selectedRecipe?.manifest.id === b.manifest.id;
                return (
                <li key={b.manifest.id}>
                  {/* Click SELECTS the recipe (drives col 3) — no install-modal
                      dead-end. A small "details" link opens the full modal. */}
                  <button
                    type="button"
                    onClick={() => pickRecipe(b)}
                    title={on ? "Click again to deselect" : undefined}
                    className={
                      "w-full text-left rounded-lg border p-2.5 flex items-start gap-2.5 transition group " +
                      (on ? "border-accent bg-accent/5" : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900 hover:border-cobble-300 dark:hover:border-cobble-700")
                    }
                  >
                    <div className="text-xl shrink-0 leading-none mt-0.5">{b.glyph}</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-content dark:text-mortar-100 text-sm">{b.manifest.name}</div>
                      <div className="text-xs text-faint dark:text-slate-400 line-clamp-2">{b.blurb}</div>
                      <button type="button" onClick={(e) => { e.stopPropagation(); setPicked(b); }} className="mt-1 text-[11px] text-faint dark:text-slate-500 hover:text-accent transition">details →</button>
                    </div>
                    <ArrowRight size={13} className={(on ? "text-accent" : "text-faint dark:text-slate-600 group-hover:text-accent") + " transition mt-1 shrink-0"} />
                  </button>
                </li>
                );
              })}
            </ScrollList>
          )}
        </div>

        {/* Col 3 — the captive terminal step. Reacts to the funnel: a chosen
            recipe → "set it up & drop me in"; a chosen kind → "add a blank one";
            nothing → the freeform "type what you've got". */}
        <div className={
          "rounded-xl border p-3 transition " +
          (selectedRecipe || selectedModuleObj ? "border-accent/60 bg-accent/5 dark:bg-cobble-900/15" : "border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40")
        }>
          <LaneHeader
            kicker="// just add it"
            title={
              selectedRecipe ? `Set up ${selectedRecipe.manifest.name}`
              : selectedModuleObj ? (kindIsMulti ? `New ${selectedModuleObj.displayName} category` : `Add a ${selectedModuleObj.displayName}`)
              : "Add your first thing"
            }
          />
          <p className="text-xs text-faint dark:text-slate-500 mb-2">
            {selectedRecipe
              ? "We'll set it up and take you straight in to add your first one."
              : selectedModuleObj
                ? (kindIsMulti
                    ? `Name a category${kindVocab ? ` — like ${kindVocab.categoryEg}` : ""} — then add things inside it.`
                    : `Start a blank ${selectedModuleObj.displayName} and add your first one.`)
                : "Type what you've got — Cobblr finds or builds the right tracker and files it."}
          </p>

          {/* Mode D — a recipe: install the ready-made category + drop in. */}
          {selectedRecipe && (
            <button
              type="button"
              disabled={setupRecipeMut.isPending}
              onClick={() => setupRecipeMut.mutate(selectedRecipe)}
              className="w-full mb-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-cobble-600 text-white text-sm font-medium px-3 py-2 hover:bg-cobble-700 transition disabled:opacity-50"
            >
              {setupRecipeMut.isPending ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
              Set up {selectedRecipe.manifest.name} & add my first one
            </button>
          )}
          {/* Mode B — a multi-instance kind: name + create a new CATEGORY. */}
          {!selectedRecipe && selectedModuleObj && kindIsMulti && (
            <div className="mb-2">
              <div className="relative mb-2">
                <Plus size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
                <input
                  value={categoryName}
                  onChange={(e) => setCategoryName(e.target.value)}
                  placeholder={kindVocab ? `e.g. ${kindVocab.categoryEg.split(",")[0]?.trim() ?? kindVocab.categoryEg}` : "Name this category"}
                  className="input !pl-8 !py-1.5 !text-sm"
                  onKeyDown={(e) => { if (e.key === "Enter" && categoryName.trim()) createInstanceMut.mutate({ module_name: selectedModuleObj.name, name: categoryName.trim() }); }}
                />
              </div>
              <button
                type="button"
                disabled={!categoryName.trim() || createInstanceMut.isPending}
                onClick={() => createInstanceMut.mutate({ module_name: selectedModuleObj.name, name: categoryName.trim() })}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-cobble-600 text-white text-sm font-medium px-3 py-2 hover:bg-cobble-700 transition disabled:opacity-50"
              >
                {createInstanceMut.isPending ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                Create category & start
              </button>
            </div>
          )}
          {/* Mode C — a single-instance kind: enable + go (no category level). */}
          {!selectedRecipe && selectedModuleObj && !kindIsMulti && (
            <button
              type="button"
              disabled={enableModuleMut.isPending}
              onClick={() => enableModuleMut.mutate(selectedModuleObj.name)}
              className="w-full mb-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-cobble-600 text-white text-sm font-medium px-3 py-2 hover:bg-cobble-700 transition disabled:opacity-50"
            >
              {enableModuleMut.isPending ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
              Add a blank {selectedModuleObj.displayName} & start
            </button>
          )}

          {/* The always-available freeform item path (or just type anything). */}
          {(selectedRecipe || selectedModuleObj) && (
            <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">or just add an item</div>
          )}
          <div className="relative mb-2">
            <Plus size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
            <input
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              placeholder={`e.g. ${itemPlaceholder}`}
              className="input !pl-8 !py-1.5 !text-sm"
              onKeyDown={(e) => { if (e.key === "Enter" && addText.trim()) noteMut.mutate(addText.trim()); }}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!addText.trim() || noteMut.isPending}
              onClick={() => noteMut.mutate(addText.trim())}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 text-content dark:text-mortar-100 text-sm font-medium px-3 py-1.5 hover:border-cobble-400 transition disabled:opacity-50"
            >
              {noteMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add it
            </button>
            {isTouch ? (
              <Link to="/scan/camera" title="Scan a barcode or snap a photo" className="inline-flex items-center gap-1.5 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-content dark:text-mortar-100 hover:border-cobble-300 dark:hover:border-cobble-700 transition">
                <Camera size={15} /> Scan
              </Link>
            ) : (
              <PairPhoneButton className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-content dark:text-mortar-100 hover:border-cobble-300 dark:hover:border-cobble-700 transition" />
            )}
          </div>
          <p className="text-[11px] text-faint dark:text-slate-500 mt-2">
            {isTouch
              ? "Scan barcodes or snap photos with your camera — they file themselves."
              : "No camera here? Pair your phone — scan with it and the items land in this workspace."}
          </p>
        </div>
      </div>

      {/* Mini scan inbox — what you've captured so far, with its matches. */}
      {items.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">scan inbox ({items.length})</div>
          <ul className="space-y-1">
            {items.map((it) => {
              const top = it.suggested_candidates?.[0];
              const matched = !!top;
              const stale = Date.now() - new Date(it.created_at).getTime() > 45_000;
              const done = !!it.ai_suggested_at || stale;
              const needsName = done && !matched && !it.suggested_name && !!it.ai_suggested_at;
              const name = top?.name || it.suggested_name || (needsName ? "Photo — couldn’t identify it" : "Captured item");
              const removing = discardMut.isPending && discardMut.variables === it.id;
              return (
                <li key={it.id} className="rounded-md border border-line dark:border-slate-800 bg-surface dark:bg-slate-900 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-100">{name}</span>
                    {matched ? (
                      <span className="text-xs text-faint dark:text-slate-400 shrink-0">looks like <span className="text-accent">{top.label}</span></span>
                    ) : !done ? (
                      <span className="flex items-center gap-1 text-xs text-faint dark:text-slate-500 shrink-0"><Loader2 size={12} className="animate-spin" /> reading…</span>
                    ) : needsName ? null : (
                      <span className="text-xs text-faint dark:text-slate-500 shrink-0">captured</span>
                    )}
                    <button type="button" disabled={removing} onClick={() => discardMut.mutate(it.id)} title="Remove" className="shrink-0 rounded p-1 text-faint hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-50">
                      {removing ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                    </button>
                  </div>
                  {needsName && <NameIt slug={slug} itemId={it.id} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Link to="/bundles" className="inline-block text-xs text-faint dark:text-slate-400 hover:text-accent transition">
        or browse the full marketplace →
      </Link>

      {picked && (
        <BundleDetailModal key={picked.manifest.id} open onClose={() => setPicked(null)} slug={slug} mode="featured" manifest={picked.manifest} glyph={picked.glyph} blurb={picked.blurb} nextSteps={picked.next_steps} autoLand />
      )}
      </>)}
    </section>
  );
}
