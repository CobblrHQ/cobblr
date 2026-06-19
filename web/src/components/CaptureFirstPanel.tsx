// Onboarding start — the default empty-state for a fresh workspace. ONE screen,
// no dead-ends: a unifying search/type box at the top, then two ways forward
// side by side —
//   A. Just capture it — scan something or jot it down; Cobblr works out the
//      structure and, once captures cluster, offers to build the tracker.
//   B. Pick a ready-made tracker — the flagship bundle gallery, inline.
// The search filters B live AND lets you just-add freeform text (Enter →
// note capture). See docs/design-decisions/capture-first-onboarding.md.

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { Camera, PenLine, Sparkles, ArrowRight, Loader2, Package, Search, Plus, Boxes, X } from "lucide-react";
import { api } from "../lib/api";
import { useBundleCatalog, type CatalogBundle } from "../lib/useBundleCatalog";
import { fuzzyMatch } from "../lib/fuzzy";
import { BundleDetailModal } from "./BundleDetailModal";

/** Name a bare photo capture that couldn't be auto-identified (no vision) —
 *  naming it triggers a server re-match, so the heuristic routes it. */
function CaptureNameIt({ slug, itemId }: { slug: string; itemId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const mut = useMutation({
    mutationFn: () => api.updateScanItem(slug, itemId, { name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] });
      toast.success("Got it — finding the right tracker…");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save that name"),
  });
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="What is this? e.g. blue worsted yarn"
        aria-label="Name this item"
        className="input !py-1 !text-xs flex-1"
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) mut.mutate();
        }}
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

export function CaptureFirstPanel({ slug }: { slug: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<CatalogBundle | null>(null);

  // Captures land async (the matchmaker runs detached) — poll while the panel
  // is up so a fresh scan / note shows its suggestion within a few seconds.
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

  // The ready-made trackers (B) — the curated flagship set, simplest-first.
  const { registry, catalog } = useBundleCatalog();
  const flagship = useMemo(
    () =>
      catalog
        .filter((b) => b.manifest.id.includes(".flagship."))
        .sort(
          (a, b) =>
            (a.manifest.requires?.length ?? 0) - (b.manifest.requires?.length ?? 0) ||
            a.manifest.name.localeCompare(b.manifest.name),
        ),
    [catalog],
  );
  const q = query.trim().toLowerCase();
  const templates = useMemo(() => {
    // No query → the curated flagship set. But a SEARCH spans the WHOLE catalog,
    // not just flagship — otherwise the ready-made specialisations (3D Printers,
    // Laser Cutters, CNC Machines — all `cobblr.community.*`, requires: machines)
    // stay hidden when a user types "printer". Simplest-first.
    if (!q) return flagship;
    return catalog
      .filter((b) =>
        fuzzyMatch(`${b.manifest.name} ${b.blurb ?? ""} ${b.manifest.description ?? ""}`, q),
      )
      .sort(
        (a, b) =>
          (a.manifest.requires?.length ?? 0) - (b.manifest.requires?.length ?? 0) ||
          a.manifest.name.localeCompare(b.manifest.name),
      );
  }, [flagship, catalog, q]);

  // Not every tracker is a bundle — a whole domain module (Machines, Projects,
  // Purchases…) is a tracker too, and "3d printer" / "printer" should surface
  // **Machines** even though no flagship bundle matches. Search the workspace's
  // not-yet-enabled domain modules (bare-named `stock` band = a nav noun) by
  // name + description, so the search covers modules AND bundles.
  const modulesQ = useQuery({
    queryKey: ["org-modules", slug],
    queryFn: () => api.orgModules(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
  const moduleMatches = useMemo(() => {
    if (!q) return [];
    return (modulesQ.data?.items ?? []).filter(
      (m) =>
        !m.enabled &&
        m.band === "stock" &&
        !m.name.startsWith("core-") &&
        fuzzyMatch(`${m.displayName} ${m.description} ${m.name}`, q),
    );
  }, [modulesQ.data, q]);

  const noteMut = useMutation({
    mutationFn: (t: string) => api.scanNote(slug, t),
    onSuccess: () => {
      setText("");
      setQuery("");
      void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] });
      toast.success("Added — finding the right tracker…");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add that note"),
  });

  const materializeMut = useMutation({
    mutationFn: (bundleId: string) => api.materializeQuickstart(slug, bundleId),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      toast.success(
        `Created your ${r.label ?? "tracker"} with ${r.created} item${r.created === 1 ? "" : "s"}.`,
      );
      if (r.route) navigate(r.route);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't set that up"),
  });

  const enableModuleMut = useMutation({
    mutationFn: (name: string) => api.enableModule(slug, name),
    onSuccess: (_r, name) => {
      void qc.invalidateQueries();
      const m = (modulesQ.data?.items ?? []).find((x) => x.name === name);
      toast.success(`Added ${m?.displayName ?? name}.`);
      navigate(`/${name}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add that tracker"),
  });

  const discardMut = useMutation({
    mutationFn: (id: string) => api.discardScanItem(slug, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't remove that"),
  });

  const items = inbox.data?.items ?? [];
  const suggestions = quick.data?.suggestions ?? [];

  return (
    <section className="rounded-xl border-2 border-dashed border-cobble-300 dark:border-cobble-700 bg-cobble-50/30 dark:bg-cobble-900/10 p-5 space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <h2 className="font-semibold text-content dark:text-mortar-100">
            What do you want to keep track of?
          </h2>
        </div>
        <p className="text-sm text-content dark:text-mortar-200">
          Search a ready-made tracker, or just describe what you have — Cobblr works out
          the structure. No setup, no fields to define.
        </p>
      </div>

      {/* The unifying box: filters the trackers below AND lets you just-add freeform
          text (Enter → a note capture). A camera button sits alongside for scanning. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint dark:text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type 'yarn', '3d printer', or 'blue worsted wool, 3 skeins'…"
            aria-label="Search trackers or describe what you have"
            className="input !pl-9"
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) noteMut.mutate(query.trim());
            }}
          />
        </div>
        <Link
          to="/scan/camera"
          title="Scan a barcode or snap a photo"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 px-3 py-2 text-sm font-medium text-content dark:text-mortar-100 hover:border-cobble-400 dark:hover:border-cobble-600 transition"
        >
          <Camera size={16} /> Scan
        </Link>
      </div>

      {/* While typing: offer to just-add the freeform text (the capture path). */}
      {q && (
        <button
          type="button"
          disabled={noteMut.isPending}
          onClick={() => noteMut.mutate(query.trim())}
          className="w-full flex items-center gap-3 rounded-lg border border-cobble-300 dark:border-cobble-700 bg-surface dark:bg-slate-900 px-4 py-2.5 hover:border-cobble-400 transition group text-left disabled:opacity-60"
        >
          <span className="w-8 h-8 rounded-full bg-cobble-600 text-white flex items-center justify-center shrink-0">
            {noteMut.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          </span>
          <div className="flex-1 min-w-0 text-sm text-content dark:text-mortar-100">
            Add <span className="font-medium">“{query.trim()}”</span>
            <span className="text-faint dark:text-slate-400"> — and I'll find the right tracker</span>
          </div>
          <ArrowRight size={15} className="text-faint group-hover:text-accent transition shrink-0" />
        </button>
      )}

      {/* "These look like yarn — make a Yarn tracker (3)" — install + file. */}
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

      {/* The running capture list — what you've thrown in so far. */}
      {items.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
            captured ({items.length})
          </div>
          <ul className="space-y-1">
            {items.map((it) => {
              const top = it.suggested_candidates?.[0];
              const matched = !!top;
              // `ai_suggested_at` IS the "matchmaker finished" signal (now stamped
              // for notes too — see core-scan matchItem). Until it lands we're
              // genuinely still reading; after it lands with no match we are DONE.
              // DEFENSIVE: also treat a row older than 45s as done — so a stuck
              // entry (e.g. one captured before the stamp fix shipped, which never
              // re-matches) self-heals instead of spinning forever.
              const stale = Date.now() - new Date(it.created_at).getTime() > 45_000;
              const done = !!it.ai_suggested_at || stale;
              const needsName = done && !matched && !it.suggested_name && !!it.ai_suggested_at; // photo couldn't ID
              const name =
                top?.name || it.suggested_name || (needsName ? "Photo — couldn’t identify it" : "Captured item");
              const removing = discardMut.isPending && discardMut.variables === it.id;
              return (
                <li
                  key={it.id}
                  className="rounded-md border border-line dark:border-slate-800 bg-surface dark:bg-slate-900 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate text-content dark:text-mortar-100">{name}</span>
                    {matched ? (
                      <span className="text-xs text-faint dark:text-slate-400 shrink-0">
                        looks like <span className="text-accent">{top.label}</span>
                      </span>
                    ) : !done ? (
                      <span className="flex items-center gap-1 text-xs text-faint dark:text-slate-500 shrink-0">
                        <Loader2 size={12} className="animate-spin" /> reading…
                      </span>
                    ) : needsName ? null : (
                      <span className="text-xs text-faint dark:text-slate-500 shrink-0">captured</span>
                    )}
                    <button
                      type="button"
                      disabled={removing}
                      onClick={() => discardMut.mutate(it.id)}
                      title="Remove this capture"
                      aria-label="Remove this capture"
                      className="shrink-0 rounded p-1 text-faint hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-50"
                    >
                      {removing ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                    </button>
                  </div>
                  {needsName && <CaptureNameIt slug={slug} itemId={it.id} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── OR ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pt-1">
        <div className="flex-1 h-px bg-line dark:bg-slate-700" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
          {q ? "matching trackers" : "or pick a ready-made tracker"}
        </span>
        <div className="flex-1 h-px bg-line dark:bg-slate-700" />
      </div>

      {/* Domain-module matches — a whole tracker (Machines, Projects, Purchases…)
          the search hit. Click adds the module + opens it. */}
      {moduleMatches.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {moduleMatches.map((m) => (
            <li key={m.name}>
              <button
                type="button"
                disabled={enableModuleMut.isPending}
                onClick={() => enableModuleMut.mutate(m.name)}
                className="w-full h-full text-left rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition group disabled:opacity-60"
              >
                <div className="w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
                  {enableModuleMut.isPending && enableModuleMut.variables === m.name ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Boxes size={18} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-content dark:text-mortar-100 text-sm">{m.displayName}</div>
                  <div className="text-xs text-content dark:text-mortar-200 mt-1 line-clamp-2">{m.description}</div>
                </div>
                <ArrowRight size={14} className="text-faint dark:text-slate-600 group-hover:text-accent transition mt-1 shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* B — the ready-made tracker gallery (bundles, filtered by the search). */}
      {registry.isLoading && flagship.length === 0 ? (
        <div className="text-xs text-faint dark:text-slate-500 py-2">Loading trackers…</div>
      ) : templates.length === 0 && moduleMatches.length === 0 ? (
        <p className="text-sm text-faint dark:text-slate-500 py-1">
          No ready-made tracker matches “{query.trim()}”. Add it above and Cobblr will build one.
        </p>
      ) : templates.length === 0 ? null : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((b) => (
            <li key={b.manifest.id}>
              <button
                type="button"
                onClick={() => setPicked(b)}
                className="w-full h-full text-left rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
              >
                <div className="text-2xl shrink-0">{b.glyph}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-content dark:text-mortar-100 text-sm">{b.manifest.name}</div>
                  <div className="text-xs text-content dark:text-mortar-200 mt-1">{b.blurb}</div>
                </div>
                <ArrowRight size={14} className="text-faint dark:text-slate-600 group-hover:text-accent transition mt-1 shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="pt-1">
        <Link to="/bundles" className="text-xs text-faint dark:text-slate-400 hover:text-accent transition">
          or browse the full marketplace →
        </Link>
      </div>

      {/* Keep the old "Write something down" affordance reachable for anyone who
          prefers a multi-line note over the search box. */}
      {writing && (
        <div className="space-y-2 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="One per line is fine. e.g. 'blue worsted wool, 100g, 3 skeins'"
            rows={2}
            autoFocus
            className="input w-full resize-none"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) noteMut.mutate(text.trim());
            }}
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setWriting(false)} className="text-xs text-faint hover:text-content dark:hover:text-mortar-100 px-2 py-1">
              Cancel
            </button>
            <button
              type="button"
              disabled={!text.trim() || noteMut.isPending}
              onClick={() => noteMut.mutate(text.trim())}
              className="rounded-md bg-cobble-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-cobble-700 transition disabled:opacity-50 flex items-center gap-1.5"
            >
              {noteMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <PenLine size={14} />}
              Add it
            </button>
          </div>
        </div>
      )}
      {!writing && (
        <button
          type="button"
          onClick={() => setWriting(true)}
          className="text-xs text-faint dark:text-slate-400 hover:text-accent transition"
        >
          + add several at once
        </button>
      )}

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

// search uses fuzzyMatch (lib/fuzzy.ts) — typo-tolerant.
