// "What do you want to do?" — the capture-first onboarding homepage (v3).
//
//   ┌ Add another thing ─────────────┐ ┌ ready-made: chips …  ┐
//   │ [ type what you've got   ]     │ │                      │
//   │ [ + Add it ] [ Pair phone ]    │ │ [ Describe what you  │
//   │  Start a Live Sort…            │ │   have → AI builds ] │
//   └────────────────────────────────┘ └──────────────────────┘
//     More ways to start ⌄
//   ┌ every way to start ─────────── [ search ] ──────────────┐
//   │ Ready-made trackers   🖨 3D Printers  📚 Bookshelf  …   │
//   │ Full setups           🛠 Maker Workshop  …              │
//   │ Start from a blank slate  + Tracking  + New Inventory…  │
//   └─────────────────────────────────────────────────────────┘
//   [ mini scan inbox — what you've captured shows here ]
//
// The top row never changes width; "More ways to start" opens ONE browse
// surface below it (one search, three sections in priority order) rather than
// the old building-blocks/recipes column pair. A tile pick primes the hero:
// a ready-made tracker → "set it up & drop me in"; a blank slate → "add a
// blank one" / "name a new category". Build-it-yourself is a CTA, not a lane.

import { productName } from "@cobblr/platform-web";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changeWorkspaceShape, useToast, SearchInput, EntityPhoto } from "@cobblr/platform-web";
import { FileSpreadsheet, Sparkles, ArrowRight, Loader2, Boxes, Wand2, Plus, ChevronDown, ChevronUp, ScanLine, X, Map as MapIcon } from "lucide-react";
import { api, type ScanInboxItem } from "../lib/api";
import { useBundleCatalog, type CatalogBundle } from "../lib/useBundleCatalog";
import { fuzzyMatch } from "../lib/fuzzy";
import { BundleDetailModal } from "./BundleDetailModalLazy";
import { BundleSection, BundleTile, splitCatalog } from "./BundleBrowse";
import { AiOffNotice, useAiStatus } from "./AiStatusNotice";
import { FirstScanCard } from "./FirstScanCard";
import { isSandboxSession } from "../lib/sandbox-session";
import { DEMO_BARCODE } from "../lib/demo-barcode";
import { useIsTouch } from "../lib/useIsTouch";
import { FreeformAdd } from "./FreeformAdd";
import { useAddByWords } from "../lib/useAddByWords";
import { itemEnriching } from "../pages/scan-status";
import { useMaterializeCapture } from "../lib/useMaterializeCapture";
import { openSheetImport } from "../lib/sheet-import";
import { withArticle } from "@cobblr/platform-contract/plural";
import { scanTrackedMatch } from "@cobblr/platform-contract/scan-triage";
import { typedInThePanel } from "@cobblr/platform-contract/scan-source";

import { rowPictures, leadYours } from "../lib/rowPictures";

import { countOf } from "@cobblr/platform-contract/plural";
function CaptureThumbnail({ slug, item, name }: { slug: string; item: ScanInboxItem; name: string }) {
  const pics = rowPictures(slug, item);
  const picture = leadYours(pics.pictures) ?? pics.pictures.find(p => p.fileId);
  return <span className="relative h-12 w-12 shrink-0 sm:h-16 sm:w-16">
    <EntityPhoto src={picture ? pics.src(picture, "thumb") : null} alt={name} fill fit="cover" className="rounded-lg" />
  </span>;
}

function captureName(it: ScanInboxItem): string {
  return it.suggested_candidates?.[0]?.name || it.suggested_name || "Captured item";
}

function captureTarget(it: ScanInboxItem) {
  const d = it.resolved_destination;
  return d ? { target_module: d.module, target_kind: d.kind ?? undefined, ...(d.instance ? { instance: d.instance } : {}) } : {};
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

function LaneHeader({ kicker, title, count }: { kicker: string; title: string; count?: number }) {
  return (
    <div className="mb-2 flex items-start justify-between gap-2">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-accent">{kicker}</div>
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
      toast.success("Got it - finding the right home…");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save that name"),
  });
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What is this? e.g. blue worsted yarn"
        className="input !py-1 text-xs flex-1"
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
const STARTER_CHIPS = ["a spool of black PLA", "blue worsted yarn", "a monstera plant"];

export function WhatToDoPanel({
  slug,
  startCollapsed = false,
}: {
  slug: string;
  startCollapsed?: boolean;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const aiStatus = useAiStatus();
  // Capture-first funnel: the building-blocks / all-trackers columns stay
  // hidden until asked for, so the first screen is one question + capture +
  // a short tracker strip (launch-simplification.md §4).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [moreOpen, setMoreOpen] = useState(false);

  // The panel persists once the workspace has content (startCollapsed) so you
  // can keep adding via the guided flow — collapsed by default, expandable, and
  // the choice is remembered per workspace. (showToggle / showBody are derived
  // below, AFTER captures load, so a pending scan inbox keeps the panel open.)
  const openKey = `cobblr.whatToDo.open:${slug}`;
  const [open, setOpen] = useState<boolean>(() => {
    if (!startCollapsed) return true;
    try {
      const stored = localStorage.getItem(openKey);
      if (stored != null) return stored === "1";
      // A sandbox is pre-stocked on purpose, so it never looks like an empty
      // spreadsheet - but that made the app read a first-time visitor as an
      // established user and fold this panel away, which is the one thing on
      // the page telling them what to do. The content is ours, not theirs.
      return isSandboxSession();
    } catch {
      return false;
    }
  });
  const setOpenPersist = (v: boolean) => {
    setOpen(v);
    try { localStorage.setItem(openKey, v ? "1" : "0"); } catch { /* ignore */ }
  };

  // ONE search across the whole browse surface — trackers, setups and blank
  // kinds all answer the same question ("what do I start with?"), so splitting
  // them across two boxes only made the user guess which one to type in.
  const [browseQ, setBrowseQ] = useState("");
  const [categoryName, setCategoryName] = useState(""); // col 3: a new category (named instance)
  // A no-camera desktop scans by pairing a phone (QR → phone signs in to THIS
  // workspace → its camera scans land in the inbox below); touch devices use
  // their own camera. Decide once on mount.
  const isTouch = useIsTouch();
  // The funnel selection: a tile pick on the browse surface primes the hero
  // (the captive "add your first one" step). A recipe and a kind are mutually
  // exclusive - whichever you picked last is what the hero acts on.
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

  // The blank-slate offer: an empty kind you shape yourself. A kind you HAVEN'T
  // enabled is offered whole; one you already have is offered as another
  // CATEGORY of it (multi-instance kinds only — a pantry next to your parts
  // bin). Without the category half this section decayed into a remainder list:
  // the more of Cobblr you used, the more it looked like four random leftovers
  // (the operator, 2026-07-31).
  const blankSlates = useMemo(() => {
    const domains = (modulesQ.data?.items ?? []).filter(
      (m) =>
        m.band === "stock" &&
        !m.name.startsWith("core-") &&
        // Operators (labels, digifab) act ON things — not a kind you track.
        (m.operates_on?.length ?? 0) === 0,
    );
    return domains
      .filter((m) => !m.enabled || m.instanceability === "multi")
      .map((m) => ({
        module: m.name,
        isCategory: m.enabled,
        label: m.enabled ? `New ${m.displayName} category` : m.displayName,
        description: m.enabled
          ? `Another separate ${m.displayName.toLowerCase()} table${KIND_VOCAB[m.name] ? ` - like ${KIND_VOCAB[m.name]!.categoryEg}` : ""}.`
          : firstSentence(m.description),
      }))
      .sort(
        (a, b) =>
          // Kinds you don't have yet lead — starting one is a bigger step than
          // adding another category to a kind you already run.
          Number(a.isCategory) - Number(b.isCategory) ||
          kindRank(a.module) - kindRank(b.module) ||
          a.label.localeCompare(b.label),
      );
  }, [modulesQ.data]);
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
  const blankMatches = useMemo(() => {
    const q = browseQ.trim().toLowerCase();
    if (!q) return blankSlates;
    return blankSlates
      .map((s) => ({ s, r: rankMatch(q, s.label, `${s.description} ${s.module}`) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => b.r - a.r)
      .map((x) => x.s);
  }, [blankSlates, browseQ]);

  // Skins vs setups (the author's baby-bundle model, inverted 2026-07-02): a SKIN is a
  // pre-shaped tracker of ONE kind (an instance + a few ready-made fields —
  // Fasteners, Filament, Yarn); a SETUP genuinely spans modules (Maker
  // Workshop). Skins are the relatable front door, so col 2 leads with them
  // ALWAYS — unscoped too — and the multi-module setups sit under a quieter
  // "Full setups" subheading instead of being the default face of the column.
  const { skins, setups } = useMemo(() => {
    const q = browseQ.trim().toLowerCase();
    let base = [...catalog];
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
    return splitCatalog(base);
  }, [catalog, browseQ]);

  // ── actions ─────────────────────────────────────────────────────────────
  const enableModuleMut = useMutation({
    mutationFn: (name: string) => changeWorkspaceShape(qc, slug, () => api.enableModule(slug, name)),
    onSuccess: (_r, name) => {
      const m = (modulesQ.data?.items ?? []).find((x) => x.name === name);
      toast.success(`Added ${m?.displayName ?? name}.`);
      navigate(`/${name}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add that"),
  });
  const sampleScanMut = useMutation({
    mutationFn: () => api.scanBarcode(slug, { barcode: DEMO_BARCODE, source_kind: "barcode" }),
    onSuccess: (item) => {
      void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] });
      toast.success("Scanned a sample. Review it in the inbox.");
      navigate(`/scan?item=${item.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't run the sample scan"),
  });
  const noteMut = useAddByWords(slug);
  // Setting a bundle up from a capture, the shared way (useMaterializeCapture):
  // the picker first when there is something to choose, the landing rule after.
  const materialize = useMaterializeCapture(slug);
  const discardMut = useMutation({
    mutationFn: (id: string) => api.discardScanItem(slug, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't remove that"),
  });
  // File a captured item into a tracker — a matched existing instance, a matched
  // module's generic table, or (no body) the backend's generic default home.
  const confirmMut = useMutation({
    mutationFn: (v: { id: string; body: { target_module?: string; target_kind?: string; instance?: string }; label?: string }) =>
      api.confirmScanItem(slug, v.id, v.body),
    onSuccess: (r, v) => {
      void qc.invalidateQueries();
      // ALWAYS say where it went, by the table's own name ("3D Printers", not
      // the slug "Printers"): "Filed it." with no destination left users
      // hunting (Inventory silently appeared in the navbar). And stay here: a
      // row of the dashboard's captures is one of several to file, and Add all
      // never left the page either. Open goes to the table.
      const dest = v.body.instance ?? r.item.target_module ?? v.body.target_module ?? "Inventory";
      const label = v.label ?? dest.charAt(0).toUpperCase() + dest.slice(1);
      const to = v.body.instance ? `/instances/${v.body.instance}` : v.body.target_module ? `/${v.body.target_module}` : null;
      if (to) toast.action(`Saved to ${label}.`, { actionLabel: "Open", onAction: () => navigate(to), duration: 6000 });
      else toast.success(`Saved to ${label}.`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't file that"),
  });
  const batchMut = useMutation({
    mutationFn: (captures: ScanInboxItem[]) => api.fileScanItems(slug, captures.map(it => it.id), captureTarget(captures[0]!)),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      if (r.failed.length) toast.error(`${r.filed.length} added. ${r.failed.length} could not be added: ${r.failed[0]!.reason}`);
      else toast.success(`Added ${countOf(r.filed.length, "item")}.`);
    },
    onError: (e) => { void qc.invalidateQueries(); toast.error(e instanceof Error ? e.message : "Couldn't add those items"); },
  });
  const mergeMut = useMutation({
    mutationFn: (ids: string[]) => api.combineScanItems(slug, ids),
    onSuccess: () => { void qc.invalidateQueries(); toast.success("Captures merged. You can undo this in the inbox."); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't merge those captures"),
  });
  const addCaptures = (captures: ScanInboxItem[]) => {
    const d = captures[0]?.resolved_destination;
    if (d?.bundle_external_id) materialize.start(d.bundle_external_id, captures.map(it => it.id));
    else if (captures.length > 1) batchMut.mutate(captures);
    else if (captures[0]) confirmMut.mutate({ id: captures[0].id, body: captureTarget(captures[0]), label: d?.label || undefined });
  };
  // Col 3 for a multi-instance kind: create a new CATEGORY (a named instance) and
  // drop the user in to add items — the kind → category → item model.
  const createInstanceMut = useMutation({
    mutationFn: ({ module_name, name }: { module_name: string; name: string }) => changeWorkspaceShape(qc, slug, async () => {
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
      } catch { /* quiet: nav grouping is a nicety; the create succeeded and is what was asked */ }
      return inst;
    }),
    onSuccess: (inst) => {
      setCategoryName("");
      toast.success(`Created ${inst.display_name}.`);
      navigate(`/instances/${inst.instance_name}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't create that category"),
  });
  // Captive setup: install the recipe and drop the user straight into it (no
  // modal) — that's the "and you're in" end of the funnel.
  const setupRecipeMut = useMutation({
    mutationFn: (b: CatalogBundle) => changeWorkspaceShape(qc, slug, () => api.installBundle(slug, b.manifest, true)),
    onSuccess: (_r, b) => {
      toast.success(`Set up ${b.manifest.name}.`);
      const dest = b.next_steps?.[0]?.path ?? "/dashboard";
      navigate(dest === "/dashboard" ? dest : `${dest}${dest.includes("?") ? "&" : "?"}created=${encodeURIComponent(b.manifest.name)}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't set that up"),
  });

  // Picking a kind clears any chosen recipe (they drive the same hero); picking
  // the same kind again deselects it.
  // A blank-kind pick has a name field or a button in the hero, not a single
  // action that fits inside a tile, so for that path the hero is brought to
  // the person instead: scrolled into view and focused, on the next frame,
  // once it has rendered its new shape. Recipes render their action inline
  // (see recipeTile); this is the fallback for the shape that cannot.
  const heroRef = useRef<HTMLDivElement | null>(null);
  const pickModule = (name: string) => {
    let picked = false;
    setSelectedModule((cur) => {
      const next = cur === name ? null : name;
      picked = next !== null;
      setSelectedRecipe(null);
      return next;
    });
    requestAnimationFrame(() => {
      if (!picked || !heroRef.current) return;
      heroRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      const target = heroRef.current.querySelector<HTMLElement>("input, button");
      target?.focus({ preventScroll: true });
    });
  };
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
  // The same next action the hero shows, rendered inside the chosen tile too,
  // so a pick far down the catalog has its button under the thumb rather than
  // in a panel that scrolled off the top (the 2026-09-13 review's "Set up
  // Groceries" that nothing pointed at).
  const setupRecipe = (b: CatalogBundle) => (b.manifest.features?.length ? setPicked(b) : setupRecipeMut.mutate(b));
  const recipeTile = (b: CatalogBundle) => {
    const on = selectedRecipe?.manifest.id === b.manifest.id;
    return (
      <BundleTile
        key={b.manifest.id}
        b={b}
        selected={on}
        onOpen={() => pickRecipe(b)}
        onDetails={() => setPicked(b)}
        action={
          <button
            type="button"
            disabled={setupRecipeMut.isPending}
            onClick={() => setupRecipe(b)}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-cobble-600 text-white text-sm font-medium px-3 py-2 hover:bg-cobble-700 transition disabled:opacity-50"
          >
            {setupRecipeMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            Set up {b.manifest.name}
          </button>
        }
      />
    );
  };

  // One blank-slate tile: an empty kind, or another category of one you already
  // run. Deliberately quieter than a recipe tile (a dashed glyph, no cover art)
  // so the ready-made offer stays the loudest thing on the surface.
  const blankTile = (s: { module: string; label: string; description: string; isCategory: boolean }) => {
    const on = selectedModule === s.module;
    return (
      <li key={`${s.module}:${s.isCategory ? "cat" : "new"}`}>
        <button
          type="button"
          onClick={() => pickModule(s.module)}
          title={on ? "Click again to deselect" : undefined}
          className={
            "w-full h-full cursor-pointer text-left rounded-lg border p-2.5 flex items-start gap-2.5 transition group " +
            (on ? "border-accent bg-accent/5" : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900 hover:border-cobble-300 dark:hover:border-cobble-700")
          }
        >
          <span className={"w-8 h-8 rounded-lg border border-dashed flex items-center justify-center shrink-0 " + (on ? "border-accent text-accent" : "border-line dark:border-slate-600 text-faint dark:text-slate-500 group-hover:text-accent")}>
            {s.isCategory ? <Plus size={15} /> : <Boxes size={15} />}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block font-medium text-content dark:text-mortar-100 text-sm">{s.label}</span>
            <span className="text-xs text-faint dark:text-slate-400 line-clamp-2">{s.description}</span>
          </span>
          <ArrowRight size={13} className={(on ? "text-accent" : "text-faint dark:text-slate-600 group-hover:text-accent") + " transition mt-1 shrink-0"} />
        </button>
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
  // A recipe that declares optional capabilities (e.g. Lego: Bricks / Rebrickable
  // / Disassemble / Labels / Scan) routes its captive "Set up" through the detail
  // modal so the user SEES and picks what it does — a silent install would drop
  // them on an empty page never knowing those capabilities exist (beta report:
  // "installed Lego, empty Sets page, no walkthrough"). A featureless recipe keeps
  // the one-tap "set it up & drop me straight in".
  const recipeHasFeatures = !!selectedRecipe?.manifest.features?.length;
  const items = inbox.data?.items ?? [];
  // Provenance split (the author): TYPED captures are part of the funnel conversation
  // and stay in col 3; SCANNED ones (barcode/photo/url/receipt) are a batch
  // stream and get their own queue section BELOW the whole panel.
  // Only what was typed into THIS panel (typedInThePanel): an assistant's add
  // over MCP, a share, an offer and an import share the note shape but live
  // in the scan inbox alone. The owner's eight printers from Claude were
  // listed here as typed and held the panel open (#6565).
  const typed = items.filter((i) => typedInThePanel(i));
  // An established workspace's panel always folds. With typed things still
  // waiting, the folded bar says so, so nothing is hidden by surprise.
  const showToggle = startCollapsed;
  const showBody = showToggle ? open : true;

  // One column, one action (2026-09 product review: the first screen offered
  // about seventeen things to click and no default, and nobody clicked any).
  // The hero is the whole compact panel: type it, or scan it. Under it, one
  // quiet line of ready-made setups and the "more ways" fold; the AI builder,
  // the full catalog and the blank kinds all live behind that fold.
  // The setups are their own section, a grid, with "More ways to start" as
  // its last cell: a strip of chips wrapping round an inline "or start from a
  // ready-made setup:" label read as a sentence that broke apart (#7199).
  const startRow = "flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-subtle dark:hover:bg-slate-800/60 disabled:opacity-50";
  const moreWays = (
    <button
      type="button"
      data-tour="more-ways"
      onClick={() => setMoreOpen((v) => !v)}
      className="col-span-2 sm:col-span-1 flex min-h-11 w-full items-center justify-between gap-1 rounded-lg border border-dashed border-line dark:border-slate-700 px-3 py-2 text-left text-sm font-medium text-accent hover:border-accent"
    >
      {moreOpen ? (<>Fewer ways to start <ChevronUp size={14} /></>) : (<>More ways to start <ChevronDown size={14} /></>)}
    </button>
  );
  const setupChip = "flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ";
  const readyMadeStrip = (
    <section data-strip="ready-made" aria-labelledby="start-from-a-setup" className="space-y-2">
      <h3 id="start-from-a-setup" className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">Start from a setup</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {skins
          .filter((b) => (b.manifest.catalog ?? "core") === "core")
          .slice(0, 4)
          .map((b) => (
          <button
            key={b.manifest.id}
            type="button"
            onClick={() => pickRecipe(b)}
            className={
              setupChip +
              (selectedRecipe?.manifest.id === b.manifest.id
                ? "border-accent text-accent bg-accent/5"
                : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900 text-content dark:text-slate-200 hover:border-accent hover:text-accent")
            }
          >
            <span aria-hidden>{b.glyph}</span>
            <span className="min-w-0 truncate">{b.manifest.name}</span>
          </button>
        ))}
        {moreWays}
      </div>
    </section>
  );

  const describeCard = (
    <Link
      to="/build?mode=workspace"
      className="flex items-center gap-3 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 px-4 py-2.5 hover:border-cobble-400 transition group"
    >
      <span className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
        <Wand2 size={16} />
      </span>
      <span className="flex-1 text-sm text-content dark:text-mortar-100">
        <span className="font-medium">Describe what you have</span>
        <span className="text-faint dark:text-slate-400">  - the AI builder compiles a custom setup, fields and all.</span>
      </span>
      <ArrowRight size={15} className="text-faint group-hover:text-accent transition shrink-0" />
    </Link>
  );

  // A capture of something the workspace already has is never offered Add:
  // Add creates a record, and a second MakerGear M2 is the mistake the
  // inbox card prevents with "+1 more" (review of #4912). Those open their
  // card instead; the groups, and Add all, hold only new things.
  const known = typed.filter((it) => scanTrackedMatch(it as never));
  const fresh = typed.filter((it) => !scanTrackedMatch(it as never));
  const groups = new Map<string, { label: string; captures: ScanInboxItem[]; rows: Map<string, ScanInboxItem[]> }>();
  for (const it of fresh) {
    const d = it.resolved_destination;
    const key = JSON.stringify([d?.module, d?.kind, d?.instance, d?.bundle_external_id]);
    let group = groups.get(key);
    if (!group) { group = { label: d?.label || "Inventory", captures: [], rows: new Map() }; groups.set(key, group); }
    group.captures.push(it);
    const name = captureName(it);
    const rowKey = it.suggested_name || it.suggested_candidates?.[0]?.name ? name : it.id;
    const rows = group.rows.get(rowKey) ?? [];
    rows.push(it);
    group.rows.set(rowKey, rows);
  }
  const orderedGroups = [...groups.entries()].sort(([aKey, a], [bKey, b]) => b.captures.length - a.captures.length || a.label.localeCompare(b.label) || aKey.localeCompare(bKey));
  const renderCapture = (captures: ScanInboxItem[], headerLabel: string) => {
    const it = captures[0]!;
    const d = it.resolved_destination;
    const name = captureName(it);
    const label = d?.label || "Inventory";
    const title = captures.length > 1 ? `${name} ×${captures.length}` : name;
    const enriching = itemEnriching(it);
    const done = !!it.ai_suggested_at || Date.now() - new Date(it.created_at).getTime() > 45_000;
    const needsName = done && !it.suggested_candidates?.length && !it.suggested_name && !!it.ai_suggested_at;
    const busy = discardMut.isPending || batchMut.isPending || confirmMut.isPending || mergeMut.isPending || (!!d?.bundle_external_id && materialize.busy(d.bundle_external_id));
    const open = expanded.has(it.id);
    return <li key={it.id}>
      <div data-testid="captured-item" className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-1 py-2 dark:bg-slate-900">
        <CaptureThumbnail slug={slug} item={it} name={name} />
        <div className="min-w-0 flex-1">
          {captures.length > 1 ? <button type="button" aria-expanded={open} aria-controls={`captures-${it.id}`} aria-label={`${open ? "Collapse" : "Expand"} ${title}`} onClick={() => setExpanded(prev => { const next = new Set(prev); if (open) next.delete(it.id); else next.add(it.id); return next; })} className="flex w-full min-w-0 items-center gap-1 text-left text-sm font-medium text-content hover:text-accent">
            <span className="line-clamp-2 min-w-0 break-words sm:line-clamp-1">{name}</span><span className="shrink-0"> ×{captures.length}</span>{open ? <ChevronUp size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
          </button> : <Link to={`/scan?item=${it.id}`} data-testid="captured-item-link" className="line-clamp-2 break-words sm:line-clamp-1 text-sm font-medium text-content hover:text-accent">{name}</Link>}
          {label !== headerLabel && <span data-testid="capture-destination" className="mt-1 inline-block max-w-full truncate rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted dark:bg-slate-800">{label}</span>}
          {enriching && <span data-testid="captured-item-progress" className="block truncate text-[11px] text-faint">{d ? "still filling in…" : it.suggested_name ? "looking it up…" : "finding a home…"}</span>}
        </div>
        {(d || done) && !needsName && <button type="button" disabled={busy} aria-label={`${d?.bundle_external_id ? "Create" : "Add"} ${title} to ${label}`} onClick={() => addCaptures(captures)} className="shrink-0 rounded-md bg-cobble-600 px-2 py-2 text-xs font-medium text-white hover:bg-cobble-700 disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : d?.bundle_external_id ? "Create" : "Add"}</button>}
        <button type="button" disabled={discardMut.isPending || busy} aria-label={`Dismiss ${captures.length > 1 ? `one ${name} capture` : name}`} title={`Dismiss ${captures.length > 1 ? `one ${name} capture` : name}`} onClick={() => discardMut.mutate(it.id)} className="shrink-0 rounded p-2 text-faint hover:bg-subtle hover:text-content disabled:opacity-50"><X size={14} /></button>
      </div>
      {needsName && <NameIt slug={slug} itemId={it.id} />}
      {captures.length > 1 && open && <div id={`captures-${it.id}`} className="pl-2">
        <ul>{captures.map(item => renderCapture([item], headerLabel))}</ul>
        <button type="button" disabled={busy} aria-label={`Same item? Merge ${name}`} onClick={() => mergeMut.mutate(captures.map(item => item.id))} className="px-2 py-2 text-xs text-accent hover:underline disabled:opacity-50">Same item? Merge</button>
      </div>}
    </li>;
  };

  return (
    <>
    <section
      data-tour="do-box"
      // The box spans the dashboard column, like the activity row under it,
      // and the hero spans the box. Two earlier shapes both read wrong: a
      // full-width box around a half-width hero was a page with a hole in it,
      // and a reading-width box centred over a full-width activity row sat
      // off-centre in the sidebar layout (the operator, 2026-09-02, twice).
      className="rounded-xl border-2 border-dashed border-cobble-300 dark:border-cobble-700 bg-cobble-50/30 dark:bg-cobble-900/10 p-5 space-y-4"
    >
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
      {/* Folded with things typed here still waiting: said, so nothing waits
          unseen behind the fold (#6565). */}
      {!showBody && typed.length > 0 && (
        <button
          type="button"
          data-testid="what-to-do-waiting"
          onClick={() => setOpenPersist(true)}
          className="inline-flex min-h-11 items-center gap-1 text-sm text-accent hover:underline"
        >
          {typed.length} added · waiting to file <ChevronDown size={13} aria-hidden />
        </button>
      )}

      {/* OUTSIDE the collapsible body on purpose. This used to sit inside `showBody`,
          so on any workspace with content the panel starts collapsed and the AI notice
          vanished entirely: a workspace with AI switched off said nothing at all on the
          dashboard. Whether AI is on is status, not onboarding, so it does not collapse
          with the guided flow. */}
      {isSandboxSession() && <FirstScanCard />}

      {/* One line, and it can be put away: four lines of it led the first
          screen, before anything to do (#7199). A reason with its own
          sentence (no AI on this plan, switched off) still says it whole. */}
      <AiOffNotice status={aiStatus} compact dismissible={`cobblr:ai-notice-hidden:${slug}`} ctaLabel={"Connect AI for the builder and Cobb \u2192"}>
        <strong>{aiStatus?.identify_available ? "Scanning and identifying work now" : "Scanning works now"}</strong>{" · "}
      </AiOffNotice>
      {showBody && (<>
      {/* Capture-first: the reactive add/capture surface is the hero and the
          whole compact panel. Everything else (ready-made setups, the AI
          builder, the catalog, blank kinds) only renders once "More ways to
          start" is opened. Selection state still lives IN the fold; a strip
          pick or a tile pick primes the same hero. */}
      <div>

        {/* The hero — the captive terminal step. Reacts to the funnel: a chosen
            recipe → "set it up & drop me in"; a chosen kind → "add a blank one";
            nothing → the freeform "type what you've got". */}
        <div ref={heroRef} className={
          "order-first rounded-xl border p-3 transition " +
          (selectedRecipe || selectedModuleObj ? "border-accent/60 bg-accent/5 dark:bg-cobble-900/15" : "border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40")
        }>
          <LaneHeader
            kicker="just add it"
            title={
              selectedRecipe ? `Set up ${selectedRecipe.manifest.name}`
              : selectedModuleObj ? (kindIsMulti ? `New ${selectedModuleObj.displayName} category` : `Add ${withArticle(selectedModuleObj.displayName)}`)
              // startCollapsed ⇒ an established workspace (Dashboard only collapses
              // the panel once it has content), so "first thing" would be wrong.
              : startCollapsed ? "Add another thing"
              : "Add your first thing"
            }
          />
          <p className="text-xs text-faint dark:text-slate-500 mb-2">
            {selectedRecipe
              ? recipeHasFeatures
                ? `Choose what ${selectedRecipe.manifest.name} should do, then add your first one.`
                : "We'll set it up and take you straight in to add your first one."
              : selectedModuleObj
                ? (kindIsMulti
                    ? `Name a category${kindVocab ? ` (like ${kindVocab.categoryEg})` : ""}, then add things inside it.`
                    : `Turn on ${selectedModuleObj.displayName} and add your first one.`)
                : `Type what you've got - ${productName()} finds or builds the right home and files it.`}
          </p>

          {/* Mode D — a recipe. Featureless: install + drop straight in. With
              optional capabilities: open the detail modal (its checkboxes are the
              "here's what it does" surface) — same proven autoLand path as the
              "details →" link, so Install still lands the user in their instance. */}
          {selectedRecipe && (
            <button
              type="button"
              disabled={setupRecipeMut.isPending}
              onClick={() => setupRecipe(selectedRecipe)}
              className="w-full mb-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-cobble-600 text-white text-sm font-medium px-3 py-2 hover:bg-cobble-700 transition disabled:opacity-50"
            >
              {setupRecipeMut.isPending ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
              {recipeHasFeatures
                ? `Set up ${selectedRecipe.manifest.name}`
                : `Set up ${selectedRecipe.manifest.name} & add my first one`}
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
                  className="input !pl-8 !py-1.5 text-sm"
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
            <div className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">or just add an item</div>
          )}
          <FreeformAdd slug={slug} placeholder={`e.g. ${itemPlaceholder}`} add={noteMut} />

          {/* Starter chips: one row under the input that scrolls sideways
              rather than wrapping, so the examples never stack into a block.
              Only when nothing is captured yet and nothing is chosen. */}
          {items.length === 0 && !selectedRecipe && !selectedModuleObj && (
            <div data-testid="starter-chips" className="-mx-3 mt-2 flex items-center gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="shrink-0 text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">try:</span>
              {STARTER_CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={noteMut.isPending}
                  onClick={() => noteMut.mutate(c)}
                  className="shrink-0 whitespace-nowrap rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-0.5 text-[11px] text-muted dark:text-slate-300 hover:border-accent hover:text-accent transition disabled:opacity-50"
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {/* Three other ways in, each a row of its own: an icon, a bold
              label and a one-line hint, the whole row the target. They were
              links inside sentences, whose chips stretched their lines apart
              and left ", see where everything goes" alone on a line (#7199). */}
          <ul data-testid="start-rows" className="mt-3 divide-y divide-line/70 dark:divide-slate-800 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
            <li>
              <button
                type="button"
                data-tour="sample-scan"
                data-testid="sample-scan"
                disabled={sampleScanMut.isPending}
                onClick={() => sampleScanMut.mutate()}
                className={startRow}
              >
                {sampleScanMut.isPending ? <Loader2 size={16} className="shrink-0 animate-spin text-accent" /> : <ScanLine size={16} className="shrink-0 text-accent" />}
                <span className="min-w-0 leading-snug"><span className="font-medium text-content dark:text-mortar-100">Try a sample scan</span><span className="text-faint dark:text-slate-500"> · review one in the inbox</span></span>
              </button>
            </li>
            <li>
              <button type="button" data-testid="bring-your-spreadsheet" onClick={() => openSheetImport()} className={startRow}>
                <FileSpreadsheet size={16} className="shrink-0 text-accent" />
                <span className="min-w-0 leading-snug"><span className="font-medium text-content dark:text-mortar-100">Bring your spreadsheet</span><span className="text-faint dark:text-slate-500"> · undo it whole if it's wrong</span></span>
              </button>
            </li>
            <li>
              <Link data-testid="draw-your-rooms" to="/locations?view=plan&new=room" className={startRow}>
                <MapIcon size={16} className="shrink-0 text-accent" />
                <span className="min-w-0 leading-snug"><span className="font-medium text-content dark:text-mortar-100">Draw your rooms</span><span className="text-faint dark:text-slate-500"> · then drag things to their shelf</span></span>
              </Link>
            </li>
          </ul>

          {/* What you've added — each capture, its match, and a one-tap CTA to
              give it a home. This is the funnel's payoff: col 3 fills in. */}
          {typed.length > 0 && (
            <div data-testid="capture-panel" className="mt-3 min-w-0 space-y-3 rounded-xl border border-line bg-surface/60 p-3 dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">what you've added ({typed.length})</div>
              <div className="grid grid-cols-1 min-w-0 gap-4 lg:grid-cols-2">
                {orderedGroups.map(([key, group]) => {
                  const d = group.captures[0]!.resolved_destination;
                  return <section key={key} aria-label={group.label} data-testid="capture-group" className="min-w-0">
                    <div className="flex min-w-0 items-center justify-between gap-2 py-1">
                      <div className="min-w-0">
                        <h3 className="truncate text-[10px] uppercase tracking-widest text-accent">{group.label} · {group.captures.length}</h3>
                        {d?.bundle_external_id && <p className="text-[11px] text-faint">Collection will be created</p>}
                      </div>
                      {d && <button type="button" aria-label={`Add all ${group.captures.length} to ${group.label}`} disabled={discardMut.isPending || batchMut.isPending || confirmMut.isPending || mergeMut.isPending || (!!d.bundle_external_id && materialize.busy(d.bundle_external_id))} onClick={() => addCaptures(group.captures)} className="shrink-0 rounded px-2 py-2 text-xs font-medium text-accent hover:bg-subtle disabled:opacity-50">Add all {group.captures.length}</button>}
                    </div>
                    <ul>{[...group.rows.values()].map(captures => renderCapture(captures, group.label))}</ul>
                  </section>;
                })}
              </div>
              {known.length > 0 && <section aria-label="Already in your workspace" data-testid="capture-known" className="min-w-0">
                <h3 className="py-1 text-[10px] uppercase tracking-widest text-faint">Already in your workspace · {known.length}</h3>
                <ul>{known.map((it) => <li key={it.id} className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-1 py-2 dark:bg-slate-900">
                  <CaptureThumbnail slug={slug} item={it} name={captureName(it)} />
                  <div className="min-w-0 flex-1 text-sm">
                    <span className="line-clamp-1 font-medium text-content">{captureName(it)}</span>
                    <span className="block truncate text-[11px] text-muted">You have {scanTrackedMatch(it as never)?.title}</span>
                  </div>
                  <Link to={`/scan?item=${it.id}`} aria-label={`Open ${captureName(it)} in the scan inbox`} className="shrink-0 rounded-md border border-line px-2 py-2 text-xs font-medium text-content hover:border-cobble-400 dark:border-slate-700 dark:text-mortar-100">Open</Link>
                </li>)}</ul>
              </section>}
            </div>
          )}
        </div>
      </div>

      {/* Under the hero: the ready-made setups, ending in the fold that holds
          every other way to start. */}
      {skins.length > 0 && !moreOpen ? readyMadeStrip : <div className="sm:w-64">{moreWays}</div>}

      {moreOpen && (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface/60 dark:bg-slate-900/40 p-3 space-y-4">
          {describeCard}
          {/* The messy-pile first mission (put-away.md §5): sorting a physical
              pile IS a great first session — bins get made and named as you go.
              On a phone this lands in the camera with Sort mode already on. */}
          <p className="text-[11px] text-faint dark:text-slate-500">
            Got a pile of stuff to put away?{" "}
            <Link
              to={isTouch ? "/scan/camera?sort=1" : "/scan?livesort=1"}
              className="text-accent hover:underline font-medium"
            >
              Start a Live Sort
            </Link>{" "}
             - scan each thing and get told which bin it goes in; number a few containers with a
            marker and the bins name themselves as you sort.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-0 text-[10px] uppercase tracking-widest text-accent">every way to start</div>
            <SearchInput value={browseQ} onChange={setBrowseQ} placeholder="Search bundles and modules…" onKeyDown={(e) => {
                  // Enter takes the first tile in section order, so the top-left
                  // result is always what a blind Enter selects.
                  if (e.key !== "Enter") return;
                  if (skins[0]) pickRecipe(skins[0]);
                  else if (setups[0]) pickRecipe(setups[0]);
                  else if (blankMatches[0]) pickModule(blankMatches[0].module);
                }} wrapperClassName="w-full sm:w-72" />
          </div>

          {registry.isLoading && skins.length === 0 && setups.length === 0 ? (
            <div className="text-xs text-faint dark:text-slate-500 py-2">Loading…</div>
          ) : skins.length === 0 && setups.length === 0 && blankMatches.length === 0 ? (
            <p className="text-xs text-faint dark:text-slate-500 py-1">
              Nothing here matches “{browseQ.trim()}”. Type it into the box above instead - {productName()} will build the right home for it.
            </p>
          ) : (
            <>
              {/* Ready-made leads: a one-kind tracker with the fields already
                  shaped is the most relatable front door. Multi-module setups
                  come next, and the blank kinds last - the escape hatch, not
                  the offer. */}
              {skins.length > 0 && (
                <BundleSection title="ready-made bundles" hint="one kind of thing, fields already shaped - add your first item right away">
                  {skins.map((b) => recipeTile(b))}
                </BundleSection>
              )}
              {setups.length > 0 && (
                <BundleSection title="full-setup bundles" hint="several modules wired together">
                  {setups.map((b) => recipeTile(b))}
                </BundleSection>
              )}
              {blankMatches.length > 0 && (
                <BundleSection title="start from a blank slate" hint="an empty module you shape yourself">
                  {blankMatches.map((s) => blankTile(s))}
                </BundleSection>
              )}
            </>
          )}

          {/* Operators (labels, digifab) — capabilities that act ON your
              things, not kinds you track. A quiet strip keeps them one tap
              away without letting them masquerade as trackable kinds. */}
          {capabilityModules.length > 0 && !browseQ.trim() && (
            <div className="pt-3 border-t border-line/60 dark:border-slate-700/60">
              <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                <span className="text-[10px] uppercase tracking-widest text-accent">add a capability</span>
                <span className="text-[11px] text-faint dark:text-slate-500">acts on things you already track</span>
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
      )}


      {picked && (
        <BundleDetailModal key={picked.manifest.id} open onClose={() => setPicked(null)} slug={slug} mode="featured" manifest={picked.manifest} glyph={picked.glyph} blurb={picked.blurb} nextSteps={picked.next_steps} autoLand />
      )}
      {materialize.modal}
      </>)}
    </section>

    </>
  );
}
