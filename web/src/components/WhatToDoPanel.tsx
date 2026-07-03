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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { Search, Camera, Sparkles, ArrowRight, Loader2, Boxes, Wand2, Plus, ChevronDown, ChevronUp, X } from "lucide-react";
import { api } from "../lib/api";
import { useBundleCatalog, type CatalogBundle } from "../lib/useBundleCatalog";
import { fuzzyMatch } from "../lib/fuzzy";
import { BundleDetailModal } from "./BundleDetailModal";
import { PairPhoneButton } from "./PairPhoneButton";
import { AiOffNotice, useAiStatus } from "./AiStatusNotice";

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

/** A scrollable card list that makes "there's more below" obvious — but
 *  HONESTLY: overflow + at-bottom come from real scroll metrics (the old
 *  static "N more" pill kept showing at the bottom of the scroll, and its
 *  count went stale as the column height changed). On md+ the list FILLS the
 *  column height (absolute-inset inside a flex-1 wrapper, so it doesn't
 *  contribute intrinsic height) — the row is driven by the tallest column
 *  (e.g. a busy col 3), with the old 40rem cap kept as the MINIMUM. */
function ScrollList({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLUListElement | null>(null);
  const [flags, setFlags] = useState({ overflow: false, atBottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setFlags({
        overflow: el.scrollHeight > el.clientHeight + 4,
        atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 4,
      });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const hint = flags.overflow && !flags.atBottom;
  return (
    <div className="relative md:flex-1 md:min-h-[40rem]">
      <ul
        ref={ref}
        className={"space-y-1.5 overflow-y-auto pr-1 max-h-[40rem] md:max-h-none md:absolute md:inset-0 " + (hint ? "pb-5" : "")}
      >
        {children}
      </ul>
      {hint && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-cobble-50 via-cobble-50/90 dark:from-slate-900 dark:via-slate-900/90 to-transparent rounded-b" />
          <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center">
            <span className="rounded-full bg-surface dark:bg-slate-800 border border-line dark:border-slate-700 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-300 shadow-sm">
              ↓ more
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

/** One scanned item as a small square tile — the photo IS the identifier for
 *  scans. LADDERS through candidate sources on failure (catalog file →
 *  catalog URL → own scan photo → initials) — the ScanPage lesson: a cached
 *  catalog file or hotlink-blocked URL must fall through, not go blank. */
function CaptureTile({ slug, it }: { slug: string; it: { catalog_image_file_id: string | null; catalog_image_url: string | null; image_file_id: string | null; suggested_name: string | null; suggested_candidates: Array<{ name: string }> } }) {
  const candidates = useMemo(
    () =>
      [
        it.catalog_image_file_id
          ? `/api/v1/orgs/${slug}/modules/core-files/files/${it.catalog_image_file_id}/raw?variant=thumb`
          : null,
        it.catalog_image_url,
        it.image_file_id ? `/api/v1/orgs/${slug}/modules/core-files/files/${it.image_file_id}/raw?variant=thumb` : null,
      ].filter((u): u is string => !!u),
    [slug, it.catalog_image_file_id, it.catalog_image_url, it.image_file_id],
  );
  const [idx, setIdx] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = candidates[idx];
    if (!url) { setSrc(null); return; }
    const internal = url.startsWith("/api/v1/");
    if (!internal) { setSrc(url); return; } // external → <img onError> advances
    let cancelled = false;
    let blobUrl: string | null = null;
    const token = localStorage.getItem("cobblr.token");
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((b) => { if (cancelled) return; blobUrl = URL.createObjectURL(b); setSrc(blobUrl); })
      .catch(() => { if (!cancelled) setIdx((i) => i + 1); });
    return () => { cancelled = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [candidates, idx]);
  const name = it.suggested_candidates?.[0]?.name || it.suggested_name || "item";
  return (
    <div
      title={name}
      className="flex-1 min-w-14 max-w-36 aspect-square rounded-md border border-line dark:border-slate-700 overflow-hidden bg-surface dark:bg-slate-900 grid place-items-center"
    >
      {src ? (
        <img src={src} alt={name} loading="lazy" className="max-w-full max-h-full object-contain" onError={() => { setSrc(null); setIdx((i) => i + 1); }} />
      ) : (
        <span className="text-[11px] font-medium text-faint dark:text-slate-500 uppercase">{name.slice(0, 2)}</span>
      )}
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

const slugifyName = (s: string): string =>
  s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");

// Col-1 curated order: the flagship "kinds people start with" first; plumbing-
// adjacent domains last. Unlisted names sort after, alphabetically. Operators
// (labels, digifab — manifest `operatesOn`) never appear here: they act ON
// things, they aren't a kind of thing you track. What-to-do-funnel.md option
// (c), chosen 2026-07-02 — the interim OPERATES_ON affinity map died with it
// (an operator that isn't a col-1 kind needs no recipe affinity).
const KIND_ORDER = ["inventory", "machines", "assets", "projects", "lists", "purchases", "tracking", "builds"];
const kindRank = (name: string): number => {
  const i = KIND_ORDER.indexOf(name);
  return i === -1 ? KIND_ORDER.length : i;
};

// Ranked filtering: name-prefix beats name-contains beats description-only, so
// the FIRST visible card is also what Enter selects ("mach" must rank Machines
// above Assets, whose description merely contains "…aren't machines").
function rankMatch(q: string, name: string, rest: string): number {
  const n = name.toLowerCase();
  if (!q) return 0;
  if (n.startsWith(q)) return 3;
  if (n.includes(q)) return 2;
  return fuzzyMatch(`${name} ${rest}`, q) ? 1 : 0;
}

// "Try one of these" starter chips — phrases the heuristic matcher genuinely
// routes (verified against the bundle menu), so the demo never dead-ends.
const STARTER_CHIPS = ["a spool of black PLA", "my passport", "blue worsted yarn", "a monstera plant"];

export function WhatToDoPanel({ slug, startCollapsed = false }: { slug: string; startCollapsed?: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const aiStatus = useAiStatus();

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
    // Poll fast only while something is pending resolution; idle panels tick
    // slowly instead of hammering the api every 4s forever.
    refetchInterval: (q) => ((q.state.data?.items?.length ?? 0) > 0 ? 4000 : 20000),
  });

  const domainModules = useMemo(
    () =>
      (modulesQ.data?.items ?? [])
        .filter(
          (m) =>
            !m.enabled &&
            m.band === "stock" &&
            !m.name.startsWith("core-") &&
            // Operators (labels, digifab) act ON things — not a kind you track.
            (m.operates_on?.length ?? 0) === 0,
        )
        .sort((a, b) => kindRank(a.name) - kindRank(b.name) || a.displayName.localeCompare(b.displayName)),
    [modulesQ.data],
  );
  // The operators, offered as a quiet "also add" strip under col 1 so they stay
  // discoverable without masquerading as trackable kinds.
  const capabilityModules = useMemo(
    () =>
      (modulesQ.data?.items ?? [])
        .filter(
          (m) =>
            !m.enabled &&
            m.band === "stock" &&
            !m.name.startsWith("core-") &&
            (m.operates_on?.length ?? 0) > 0,
        )
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [modulesQ.data],
  );
  const blockMatches = useMemo(() => {
    const q = blockQ.trim().toLowerCase();
    if (!q) return domainModules;
    return domainModules
      .map((m) => ({ m, r: rankMatch(q, m.displayName, `${m.description} ${m.name}`) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => b.r - a.r)
      .map((x) => x.m);
  }, [domainModules, blockQ]);

  // Skins vs setups (the author's baby-bundle model, inverted 2026-07-02): a SKIN is a
  // pre-shaped tracker of ONE kind (an instance + a few ready-made fields —
  // Fasteners, Filament, Yarn); a SETUP genuinely spans modules (Maker
  // Workshop). Skins are the relatable front door, so col 2 leads with them
  // ALWAYS — unscoped too — and the multi-module setups sit under a quieter
  // "Full setups" subheading instead of being the default face of the column.
  const { skins, setups } = useMemo(() => {
    const q = recipeQ.trim().toLowerCase();
    // A recipe belongs to a kind if it REQUIRES it OR PROVISIONS an instance of
    // it. The machine specialisations (3D Printers / Laser Cutters / CNC) are
    // provides_instances of `machines`, so this surfaces them under Machines.
    const relatesTo = (b: CatalogBundle, mod: string) =>
      (b.manifest.requires ?? []).some((r) => r.module === mod) ||
      (b.manifest.provides_instances ?? []).some((i) => i.module === mod);
    const byKind = (b: CatalogBundle) => !selectedModule || relatesTo(b, selectedModule);
    const moduleSpan = (b: CatalogBundle) =>
      new Set([
        ...(b.manifest.requires ?? []).map((r) => r.module),
        ...(b.manifest.provides_instances ?? []).map((i) => i.module),
      ]).size;
    const isSkin = (b: CatalogBundle) =>
      moduleSpan(b) <= 1 && (b.manifest.provides_instances?.length ?? 0) >= 1;

    let base = catalog.filter(byKind);
    if (q) {
      // Searching: rank name-prefix > name > blurb/description so the first
      // visible card is what Enter selects. Rank order is preserved within
      // each section.
      base = base
        .map((b) => ({ b, r: rankMatch(q, b.manifest.name, `${b.blurb ?? ""} ${b.manifest.description ?? ""}`) }))
        .filter((x) => x.r > 0)
        .sort((a, b) => b.r - a.r)
        .map((x) => x.b);
    } else {
      base = [...base].sort(
        (a, b) =>
          (a.manifest.requires?.length ?? 0) - (b.manifest.requires?.length ?? 0) ||
          a.manifest.name.localeCompare(b.manifest.name),
      );
    }
    return { skins: base.filter(isSkin), setups: base.filter((b) => !isSkin(b)) };
  }, [catalog, recipeQ, selectedModule]);
  const recipes = useMemo(() => [...skins, ...setups], [skins, setups]);

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
      // ?created powers the landing page's one-time success strip (A3).
      if (r.route) navigate(`${r.route}${r.route.includes("?") ? "&" : "?"}created=${encodeURIComponent(r.label ?? "Your tracker")}&count=${r.created}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't set that up"),
  });
  const discardMut = useMutation({
    mutationFn: (id: string) => api.discardScanItem(slug, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] }),
  });
  // File a captured item into a tracker — a matched existing instance, a matched
  // module's generic table, or (no body) the backend's generic default home.
  const confirmMut = useMutation({
    mutationFn: (v: { id: string; body: { target_module?: string; target_kind?: string; instance?: string } }) =>
      api.confirmScanItem(slug, v.id, v.body),
    onSuccess: (r, v) => {
      void qc.invalidateQueries();
      // ALWAYS say where it went — "Filed it." with no destination left users
      // hunting (Inventory silently appeared in the navbar).
      const dest = v.body.instance ?? r.item.target_module ?? v.body.target_module ?? "Inventory";
      const destLabel = dest.charAt(0).toUpperCase() + dest.slice(1);
      toast.success(`Saved to ${destLabel} — it's in your navbar.`);
      if (v.body.instance) navigate(`/instances/${v.body.instance}`);
      else if (v.body.target_module) navigate(`/${v.body.target_module}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't file that"),
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
      const inst = await api.createInstance(slug, { module_name, instance_name: slugifyName(name), display_name: name.trim() });
      // Same "sibling heading" rule as the + New thing modal (B3): if a navbar
      // menu already holds a category of this kind, the new one auto-joins it —
      // otherwise adding categories from the homepage silently sprawled the
      // navbar, regressing the one-dropdown flow. First category stays
      // standalone (matching the modal's default). Best-effort.
      try {
        const [instances, headings] = await Promise.all([api.listInstances(slug), api.listNavHeadings(slug)]);
        const siblings = instances.items.filter(
          (i) => i.module_name === module_name && !i.is_default && i.instance_name !== inst.instance_name,
        );
        const heading = headings.items.find((h) =>
          h.members.some((m) => m.target_kind === "instance" && siblings.some((i) => i.instance_name === m.target_id)),
        );
        if (heading) {
          await api.addNavHeadingMember(slug, heading.id, { target_kind: "instance", target_id: inst.instance_name });
        }
      } catch { /* nav grouping is a nicety — never fail the create over it */ }
      return inst;
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
      const dest = b.next_steps?.[0]?.path ?? "/dashboard";
      navigate(dest === "/dashboard" ? dest : `${dest}${dest.includes("?") ? "&" : "?"}created=${encodeURIComponent(b.manifest.name)}`);
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

  // One recipe card, used by both col-2 sections (trackers + full setups).
  // Click SELECTS the recipe (drives col 3) — no install-modal dead-end. A
  // small "details" button opens the full modal. The card is a
  // div[role=button] (NOT <button>) because it contains that inner button —
  // nested buttons are invalid HTML and break keyboard/screen-reader semantics.
  const recipeCard = (b: CatalogBundle) => {
    const on = selectedRecipe?.manifest.id === b.manifest.id;
    return (
      <li key={b.manifest.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => pickRecipe(b)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickRecipe(b); } }}
          title={on ? "Click again to deselect" : undefined}
          className={
            "w-full cursor-pointer text-left rounded-lg border p-2.5 flex items-start gap-2.5 transition group " +
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
        </div>
      </li>
    );
  };

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
  // Provenance split (the author): TYPED captures are part of the funnel conversation
  // and stay in col 3; SCANNED ones (barcode/photo/url/receipt) are a batch
  // stream and get their own queue section BELOW the whole panel.
  const typed = items.filter((i) => i.source_kind === "note");
  const scanned = items.filter((i) => i.source_kind !== "note");
  // Consolidate the scanner stream by its match (the author): "20 look like Filament
  // Stash → create it & file all 20" beats 20 cards. Sorted biggest-first;
  // unmatched/still-reading collapse to one review link at the end.
  const scanGroups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; bundleId?: string; target?: { module: string; kind: string; instance?: string }; items: typeof scanned }>();
    let residual = 0;
    for (const it of scanned) {
      const c = it.suggested_candidates?.[0];
      if (!c) { residual++; continue; }
      const key = c.bundle_external_id ? `b:${c.bundle_external_id}` : `i:${c.module}:${c.instance ?? ""}`;
      const g = map.get(key) ?? {
        key,
        label: c.label,
        ...(c.bundle_external_id
          ? { bundleId: c.bundle_external_id }
          : { target: { module: c.module, kind: c.kind, ...(c.instance ? { instance: c.instance } : {}) } }),
        items: [] as typeof scanned,
      };
      g.items.push(it);
      map.set(key, g);
    }
    return { groups: [...map.values()].sort((a, b) => b.items.length - a.items.length), residual };
  }, [scanned]);
  // "Add all N to <existing tracker>" — sequential confirms (small groups; no
  // bulk endpoint needed).
  const confirmGroupMut = useMutation({
    mutationFn: async (g: { label: string; target: { module: string; kind: string; instance?: string }; ids: string[] }) => {
      for (const id of g.ids) {
        await api.confirmScanItem(slug, id, { target_module: g.target.module, target_kind: g.target.kind, ...(g.target.instance ? { instance: g.target.instance } : {}) });
      }
      return g;
    },
    onSuccess: (g) => {
      void qc.invalidateQueries();
      toast.success(`Filed ${g.ids.length} into ${g.label}.`);
      if (g.target.instance) navigate(`/instances/${g.target.instance}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't file those"),
  });
  // Collapse only when there's content AND no TYPED capture pending — scans
  // live below the panel, so they don't force it open.
  const hasPending = typed.length > 0;
  const showToggle = startCollapsed && !hasPending;
  const showBody = showToggle ? open : true;

  // One capture card — shared by col 3 (typed) and the scanned queue below.
  const renderCapture = (it: (typeof items)[number]) => {
    const c = it.suggested_candidates?.[0];
                  const stale = Date.now() - new Date(it.created_at).getTime() > 45_000;
                  const done = !!it.ai_suggested_at || stale;
                  const needsName = done && !c && !it.suggested_name && !!it.ai_suggested_at;
                  const name = c?.name || it.suggested_name || (needsName ? "Couldn’t identify it" : "Captured item");
                  const removing = discardMut.isPending && discardMut.variables === it.id;
                  const filing = confirmMut.isPending && confirmMut.variables?.id === it.id;
                  const making = !!c?.bundle_external_id && materializeMut.isPending && materializeMut.variables === c.bundle_external_id;
                  const ctaCls = "shrink-0 inline-flex items-center gap-1 rounded-md text-xs font-medium px-2.5 py-1 transition disabled:opacity-50";
                  return (
                    <li key={it.id} className="rounded-lg border border-line dark:border-slate-800 bg-surface dark:bg-slate-900 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 min-w-0 truncate text-sm font-medium text-content dark:text-mortar-100">{name}</span>
                        <button type="button" disabled={removing} onClick={() => discardMut.mutate(it.id)} title="Remove" className="shrink-0 rounded p-1 text-faint hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-50">
                          {removing ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                        </button>
                      </div>
                      {needsName ? (
                        <NameIt slug={slug} itemId={it.id} />
                      ) : (
                        <div className="mt-1.5 flex items-center gap-2">
                          <span className="flex-1 min-w-0 truncate text-xs text-faint dark:text-slate-400">
                            {c ? <>looks like <span className="text-accent">{c.label}</span></>
                              : done ? "no match — save it as a general item"
                              : <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> finding a home…</span>}
                          </span>
                          {c?.bundle_external_id ? (
                            <button type="button" disabled={making} onClick={() => materializeMut.mutate(c.bundle_external_id!)} className={ctaCls + " bg-cobble-600 text-white hover:bg-cobble-700"}>
                              {making ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />} Create {c.label}
                            </button>
                          ) : c ? (
                            <button type="button" disabled={filing} onClick={() => confirmMut.mutate({ id: it.id, body: { target_module: c.module, target_kind: c.kind, ...(c.instance ? { instance: c.instance } : {}) } })} className={ctaCls + " bg-cobble-600 text-white hover:bg-cobble-700"}>
                              {filing ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />} Add to {c.label}
                            </button>
                          ) : done ? (
                            <button type="button" disabled={filing} onClick={() => confirmMut.mutate({ id: it.id, body: {} })} className={ctaCls + " border border-cobble-300 dark:border-cobble-700 text-content dark:text-mortar-100 hover:border-cobble-400"}>
                              {filing ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Save to Inventory
                            </button>
                          ) : null}
                        </div>
                      )}
                    </li>
    );
  };

  return (
    <>
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
        to="/build?mode=workspace"
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

      {/* One shared AI-honesty pattern (redesign A1): say basic-mode up front. */}
      <AiOffNotice status={aiStatus} compact>
        <strong>AI isn't connected — matching runs in basic mode.</strong>{" "}
        Common things still find a home by keywords; connect AI to identify anything (and to use the builder above).{" "}
      </AiOffNotice>

      {/* The three columns. Desktop order: Building blocks · Ready-made · Add
          your first thing (left→right funnel). MOBILE inverts: "just add it" is
          a phone user's most likely intent, so col 3 stacks FIRST — it was 2+
          screens down under two long lists. The selection state lives IN the
          columns (highlights + col 3's reactive prompt) — no breadcrumb bar. */}
      <div className="grid gap-3 md:grid-cols-3">
        {/* Col 1 — Building blocks (modules) */}
        <div className="order-2 md:order-none rounded-xl border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40 p-3 md:flex md:flex-col">
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
            <p className="text-xs text-faint dark:text-slate-500 py-1">{blockQ ? `No kind matches “${blockQ.trim()}”.` : "All set."}</p>
          ) : (
            <ScrollList>
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
          {/* Operators (labels, digifab) — capabilities that act ON your
              things, not kinds you track. A quiet strip keeps them one tap
              away without letting them masquerade as trackable kinds. */}
          {capabilityModules.length > 0 && !blockQ && (
            <div className="mt-2 pt-2 border-t border-line/60 dark:border-slate-700/60">
              <div className="text-[10px] uppercase tracking-wider text-faint dark:text-slate-500 mb-1.5">
                Add a capability
              </div>
              <div className="flex flex-wrap gap-1.5">
                {capabilityModules.map((m) => (
                  <button
                    key={m.name}
                    type="button"
                    disabled={enableModuleMut.isPending}
                    onClick={() => enableModuleMut.mutate(m.name)}
                    title={firstSentence(m.description)}
                    className="inline-flex items-center gap-1 rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-1 text-xs text-content dark:text-mortar-100 hover:border-accent hover:text-accent transition disabled:opacity-50"
                  >
                    <Plus size={11} />
                    {m.displayName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Col 2 — trackers (skins) first, full setups under a quiet subheading */}
        <div className="order-3 md:order-none rounded-xl border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40 p-3 md:flex md:flex-col">
          <LaneHeader kicker="// recipes" title={selectedModuleObj ? `${selectedModuleObj.displayName} trackers` : "Pre-shaped trackers"} count={recipes.length} />
          <div className="relative mb-2">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
            <input
              value={recipeQ}
              onChange={(e) => setRecipeQ(e.target.value)}
              placeholder="e.g. yarn, filament, fasteners…"
              className="input !pl-8 !py-1.5 !text-sm"
              onKeyDown={(e) => { if (e.key === "Enter" && recipes[0]) pickRecipe(recipes[0]); }}
            />
          </div>
          {registry.isLoading && recipes.length === 0 ? (
            <div className="text-xs text-faint dark:text-slate-500 py-2">Loading…</div>
          ) : recipes.length === 0 ? (
            <p className="text-xs text-faint dark:text-slate-500 py-1">{recipeQ ? `No ready-made tracker for “${recipeQ.trim()}”.` : "Nothing here yet."}</p>
          ) : (
            <ScrollList>
              {/* Skins lead: one-kind trackers with the fields pre-shaped —
                  the relatable front door. Multi-module setups follow under
                  their own quiet subheading instead of being the default face
                  of the column (the author, 2026-07-02). */}
              {skins.map((b) => recipeCard(b))}
              {setups.length > 0 && (
                <li aria-hidden className="pt-1.5 pb-0.5">
                  <div className="text-[10px] uppercase tracking-wider text-faint dark:text-slate-500">
                    Full setups — several parts working together
                  </div>
                </li>
              )}
              {setups.map((b) => recipeCard(b))}
            </ScrollList>
          )}
        </div>

        {/* Col 3 — the captive terminal step. Reacts to the funnel: a chosen
            recipe → "set it up & drop me in"; a chosen kind → "add a blank one";
            nothing → the freeform "type what you've got". */}
        <div className={
          "order-1 md:order-none rounded-xl border p-3 transition " +
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
                    : `Turn on ${selectedModuleObj.displayName} and add your first one.`)
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
              Set up {selectedModuleObj.displayName} & start
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

          {/* Starter chips — a fresh panel demos the magic in one tap. Only when
              there's nothing captured yet and no funnel selection. */}
          {items.length === 0 && !selectedRecipe && !selectedModuleObj && (
            <div className="mt-2 flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">try:</span>
              {STARTER_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={noteMut.isPending}
                  onClick={() => noteMut.mutate(c)}
                  className="rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-0.5 text-[11px] text-muted dark:text-slate-300 hover:border-accent hover:text-accent transition disabled:opacity-50"
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {/* What you've added — each capture, its match, and a one-tap CTA to
              give it a home. This is the funnel's payoff: col 3 fills in. */}
          {typed.length > 0 && (
            <div className="mt-3 border-t border-line dark:border-slate-800 pt-3 space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">what you've added ({typed.length})</div>
              <ul className="space-y-1.5">
                {typed.map(renderCapture)}
              </ul>
            </div>
          )}
        </div>
      </div>

      <Link to="/bundles" className="inline-block text-xs text-faint dark:text-slate-400 hover:text-accent transition">
        browse all setups & trackers →
      </Link>

      {picked && (
        <BundleDetailModal key={picked.manifest.id} open onClose={() => setPicked(null)} slug={slug} mode="featured" manifest={picked.manifest} glyph={picked.glyph} blurb={picked.blurb} nextSteps={picked.next_steps} autoLand />
      )}
      </>)}
    </section>

    {/* Scanned captures — the batch stream from your scanner/phone, OWN queue
        below the guided panel (typed things stay in col 3). Capped preview;
        heavy review lives on /scan (sessions, gallery, bulk tools). */}
    {scanned.length > 0 && (
      <section className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">// from your scanner — waiting to file ({scanned.length})</span>
          <div className="flex-1" />
          <Link to="/scan" className="text-xs text-accent hover:underline shrink-0">
            review all in the Scan Inbox →
          </Link>
        </div>
        <ul className="space-y-1.5">
          {scanGroups.groups.map((g) => {
            const busy = g.bundleId
              ? materializeMut.isPending && materializeMut.variables === g.bundleId
              : confirmGroupMut.isPending && confirmGroupMut.variables?.label === g.label;
            return (
              <li key={g.key} className="rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50/50 dark:bg-cobble-900/15 px-3 py-2.5 space-y-1.5">
                {/* Header row: count/label + a COMPACT inline CTA — the tile
                    strip below gets the full card width (the author). */}
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-0 text-sm text-content dark:text-mortar-100">
                    <strong>{g.items.length}</strong> look{g.items.length === 1 ? "s" : ""} like <span className="text-accent font-medium">{g.label}</span>
                  </div>
                  {g.bundleId ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => materializeMut.mutate(g.bundleId!)}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                      Create {g.label} & file all {g.items.length}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => confirmGroupMut.mutate({ label: g.label, target: g.target!, ids: g.items.map((i) => i.id) })}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-xs font-medium px-2.5 py-1 transition disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                      Add all {g.items.length} to {g.label}
                    </button>
                  )}
                </div>
                {/* Full-width tile strip. */}
                <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                  {g.items.slice(0, 12).map((i) => (
                    <CaptureTile key={i.id} slug={slug} it={i} />
                  ))}
                  {g.items.length > 12 && (
                    <Link to="/scan" className="flex-1 min-w-14 max-w-36 aspect-square rounded-md border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 grid place-items-center text-xs font-medium text-muted dark:text-slate-300 hover:border-accent hover:text-accent transition">
                      +{g.items.length - 12}
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {scanGroups.residual > 0 && (
          <Link to="/scan" className="block rounded-lg border border-line dark:border-slate-800 bg-surface dark:bg-slate-900 px-3 py-2 text-xs text-faint dark:text-slate-400 hover:text-accent hover:border-accent transition">
            {scanGroups.residual} unidentified or still reading — review in the Scan Inbox →
          </Link>
        )}
      </section>
    )}
    </>
  );
}
