// /bundles — list installed bundles + a paste-JSON install form.
// Phase 4 stops short of a hosted registry; bundles are local
// JSON the user pastes / uploads.

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy, Download, Library, Package, Plus, Search, Share2, Trash2, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { BundleSection, BundleTile, splitCatalog } from "../components/BundleBrowse";
import { ApiError, api, type PlatformBundle, type PlatformBundleManifest, type RegistryDriverEntry, type RegistryModuleEntry, type RegistryRendererEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import { type FeaturedBundle } from "../lib/featured-bundles";
import { useBundleCatalog } from "../lib/useBundleCatalog";
import { BundleDetailModal } from "../components/BundleDetailModal";
import { RegistryItemModal, type RegistryItem } from "../components/RegistryItemModal";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import { ConfigHeaderActions } from "../components/ConfigPageHeader";

// Third-party source index URLs (the HACS "add a custom repository" list).
// Instance-wide persistence is a small follow-up; for now they live in the
// admin's browser. The official curated index is always merged server-side.
const SOURCES_KEY = "cobblr.registry.sources";
function loadSources(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SOURCES_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

type SelectedBundle =
  | { mode: "installed"; bundle: PlatformBundle }
  | { mode: "featured"; featured: FeaturedBundle; alreadyInstalled: boolean }
  | null;

export function BundlesPage() {
  usePageTitle("Bundles");
  const { activeSlug: slug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<SelectedBundle>(null);
  const bundles = useQuery({
    queryKey: ["bundles", slug],
    queryFn: () => api.listBundles(slug),
    enabled: !!slug,
  });

  // ── Marketplace catalog (the cobblr-extensions registry) ──
  // The featured section is now registry-backed. If the official index is
  // unreachable (e.g. no token provisioned yet), we fall back to the
  // embedded FEATURED_BUNDLES so the page is never empty.
  const [sources, setSources] = useState<string[]>(loadSources);
  const [newSource, setNewSource] = useState("");
  useEffect(() => {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
  }, [sources]);
  // Catalog + registry come from one shared hook so the marketplace and the
  // first-run wizard agree (and so the registry's dropped next_steps are
  // restored in one place — see useBundleCatalog).
  const { registry, catalog } = useBundleCatalog(sources);

  // Deep-link: the dashboard "Update" nudge sends ?open=<bundle-id> so the
  // bundle's modal opens straight away (the author: the home Update button shouldn't
  // just dump you on the bundles page). Open it once the catalog is loaded,
  // then strip the param so closing the modal doesn't reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get("open");
  useEffect(() => {
    if (!openId || selected || !catalog.length || !bundles.data) return;
    const b = catalog.find((c) => c.manifest.id === openId);
    if (b) {
      setSelected({
        mode: "featured",
        featured: b,
        alreadyInstalled: bundles.data.items.some((x) => x.external_id === b.manifest.id),
      });
    }
    setSearchParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.delete("open");
        return n;
      },
      { replace: true },
    );
  }, [openId, selected, catalog, bundles.data, setSearchParams]);

  const installedRenderers = useQuery({
    queryKey: ["installed-renderers", slug],
    queryFn: () => api.getInstalledRenderers(slug),
    enabled: !!slug,
  });
  const installedRendererNames = new Set((installedRenderers.data?.items ?? []).map((r) => r.name));
  const officialOk = registry.data?.sources.find((s) => s.label === "official")?.ok;

  // Rank: official flagship first, plain official next, official community
  // below that, third-party sources last. Stable within a tier, so the
  // index's own order is preserved. (sort tier is derived from the id
  // namespace + source — see the personal-bundles note in the page.)
  const tierOf = (b: FeaturedBundle & { source?: string }): number => {
    if (b.source && b.source !== "official") return 3; // third-party repo
    if (b.manifest.id.includes(".flagship.")) return 0;
    if (b.manifest.id.includes(".community.")) return 2;
    return 1; // other official
  };
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const q = query.trim().toLowerCase();
  const shownCatalog = [...catalog]
    .sort((a, b) => tierOf(a) - tierOf(b))
    .filter(
      (b) =>
        !q ||
        `${b.manifest.name} ${b.manifest.id} ${b.blurb} ${b.manifest.description ?? ""}`
          .toLowerCase()
          .includes(q),
    );
  // Same grouping as the dashboard's browse surface - ONE catalog, one shape
  // (new-user-flow.md F2). Tier order is preserved within each section.
  const shownSections = splitCatalog(shownCatalog);

  const [paste, setPaste] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const install = useMutation({
    mutationFn: (manifest: PlatformBundleManifest) =>
      api.installBundle(slug, manifest),
    onSuccess: (r) => {
      setErr(null);
      setOk(null);
      toast.success(
        `Installed ${r.bundle.name} v${r.bundle.version} — ${r.applied.wires} wire(s), ${r.applied.field_defs} field def(s).`,
      );
      setPaste("");
      void qc.invalidateQueries({ queryKey: ["bundles", slug] });
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
    },
    onError: (e: unknown) => {
      setOk(null);
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setErr(msg);
      toast.error(msg);
    },
  });

  // ── Driver lane (digifab) — admin installs a declarative driver. ──
  const installDriver = useMutation({
    mutationFn: (d: RegistryDriverEntry) => api.installDigifabDriver(slug, d.manifest),
    onSuccess: (_r, d) => toast.success(`Installed the ${d.name} driver.`),
    onError: (e: unknown) =>
      toast.error(
        e instanceof ApiError && e.status === 404
          ? "Enable the Digital Fabrication module first (Configuration → Modules)."
          : e instanceof ApiError ? e.message : (e as Error).message,
      ),
  });

  // ── Module lane (sandboxed WASM) — super-admin, signed install. ──
  const { user } = useAuth();
  const isPlatformAdmin = !!user?.is_platform_admin;
  const confirm = useConfirm();
  // Direct remove from an installed-bundle row (was only reachable by opening
  // the detail modal — users couldn't find it).
  const uninstall = useMutation({
    mutationFn: (id: string) => api.uninstallBundle(slug, id),
    onSuccess: () => {
      toast.success("Removed.");
      void qc.invalidateQueries({ queryKey: ["bundles", slug] });
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't remove."),
  });
  async function handleRemoveBundle(b: PlatformBundle) {
    const ok = await confirm({
      title: `Remove “${b.name}”?`,
      message: "This removes the bundle's fields, wires and views from this workspace. Your entities (parts, designs, …) stay.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) uninstall.mutate(b.id);
  }
  const installModule = useMutation({
    mutationFn: (m: RegistryModuleEntry) => api.sandboxInstall({ name: m.name, version: m.version }),
    onSuccess: (_r, m) => toast.success(`Installed module ${m.name} v${m.version}.`),
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : (e as Error).message),
  });
  // Notarised-open consent gate: a module Cobblr hasn't vouched for needs
  // an explicit OK before install. The sandbox + capabilities still bound
  // what it can do — this is informed consent, not the only safeguard.
  async function onInstallModule(m: RegistryModuleEntry) {
    if (m.trust !== "official") {
      const ok = await confirm({
        title: `Install ${m.name}?`,
        message:
          `Cobblr hasn't reviewed this module${m.source !== "official" ? ` (source: ${m.source})` : ""}. ` +
          `It runs in a sandbox and can't exceed your workspace's permissions — but only install code from sources you trust.`,
        confirmLabel: "Install anyway",
        destructive: true,
      });
      if (!ok) return;
    }
    installModule.mutate(m);
  }

  // ── Renderer lane (sandboxed file-preview renderers) ──
  const installRenderer = useMutation({
    mutationFn: (r: RegistryRendererEntry) =>
      api.installRenderer(slug, {
        name: r.name,
        version: r.version,
        exts: r.exts,
        renderer_js: r.renderer_js,
        pubkey: r.pubkey,
        signature: r.signature,
      }),
    onSuccess: (_r, r) => {
      toast.success(`Installed the ${r.name} renderer (.${r.exts.join(", .")}).`);
      void qc.invalidateQueries({ queryKey: ["installed-renderers", slug] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : (e as Error).message),
  });
  async function onInstallRenderer(r: RegistryRendererEntry) {
    if (r.trust !== "official") {
      const ok = await confirm({
        title: `Install ${r.name}?`,
        message:
          `Cobblr hasn't reviewed this renderer${r.source !== "official" ? ` (source: ${r.source})` : ""}. ` +
          `It runs fully sandboxed — no network, no access to your data — it only ever sees the file you preview. Install anyway?`,
        confirmLabel: "Install anyway",
        destructive: true,
      });
      if (!ok) return;
    }
    installRenderer.mutate(r);
  }

  function installFromPaste() {
    let parsed: PlatformBundleManifest;
    try {
      parsed = JSON.parse(paste) as PlatformBundleManifest;
    } catch {
      setErr("Bundle JSON didn't parse");
      setOk(null);
      return;
    }
    install.mutate(parsed);
  }


  function submit(e: FormEvent) {
    e.preventDefault();
    if (!paste.trim()) return;
    installFromPaste();
  }

  // Old: clicked → immediately downloaded. New: opens a preview
  // modal so authors can see WHAT they're publishing, edit the
  // human-facing metadata (name / description / author), and
  // choose between download / copy / paste-as-text. Backed by the
  // same exportBundle endpoint.
  const [exportOpen, setExportOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // Detail modal for a clicked driver/module/renderer card.
  const [regItem, setRegItem] = useState<RegistryItem | null>(null);

  const installedIds = new Set(
    bundles.data?.items.map((b) => b.external_id) ?? [],
  );
  // external_id → installed version, to flag "update available" when the
  // registry's version differs from what's installed.
  const installedVersionById = new Map(
    (bundles.data?.items ?? []).map((b) => [b.external_id, b.version]),
  );

  return (
    <div className="space-y-5">
      <ConfigHeaderActions>
        <Link
          to="/bundles/compose"
          className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-accent transition flex items-center gap-1"
          title="Pick which wires + field defs go into a bundle, no JSON authoring required"
        >
          <Package size={12} /> compose
        </Link>
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-accent transition flex items-center gap-1"
          title="Export the whole workspace's customisations as one bundle (no per-item picker)"
        >
          <Download size={12} /> publish mine
        </button>
      </ConfigHeaderActions>
      {exportOpen && (
        <ExportBundleModal slug={slug} onClose={() => setExportOpen(false)} />
      )}

      <Modal
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        title="Bundle sources"
        subtitle="Cobblr merges the official index with any third-party repos you add — each is a URL to an index.json (HACS-style). Bundles from added repos show a “3rd-party” badge; only the official index is signature-verified."
      >
        <ul className="space-y-1.5 mb-4">
          <li className="flex items-center gap-2 text-sm text-muted dark:text-slate-300">
            <span className="text-moss-600 shrink-0" title="official source">●</span>
            <span className="text-content dark:text-mortar-100">official</span>
            <span className="text-faint font-mono text-xs truncate">CobblrHQ/cobblr-extensions</span>
            {officialOk === false && (
              <span className="text-[10px] font-mono uppercase tracking-widest text-ember-500 shrink-0" title="The official index couldn't be reached - showing the built-in list.">offline</span>
            )}
          </li>
          {sources.map((s) => {
            const st = registry.data?.sources.find((x) => x.label === s);
            return (
              <li key={s} className="flex items-center gap-2 text-sm text-muted dark:text-slate-300">
                <span title={st?.ok === false ? st.error : "ok"} className={`shrink-0 ${st?.ok === false ? "text-ember-500" : "text-moss-600"}`}>
                  {st?.ok === false ? "✕" : "●"}
                </span>
                <span className="font-mono text-xs truncate flex-1 min-w-0">{s}</span>
                <button type="button" onClick={() => setSources((p) => p.filter((x) => x !== s))} className="text-faint hover:text-ember-500 shrink-0" title="Remove source">
                  <X size={14} />
                </button>
              </li>
            );
          })}
          {sources.length === 0 && (
            <li className="text-xs text-faint dark:text-slate-500 italic pl-5">
              No third-party repos added - just the official index.
            </li>
          )}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const u = newSource.trim();
            if (!u || sources.includes(u)) return;
            setSources((p) => [...p, u]);
            setNewSource("");
          }}
          className="flex items-center gap-2"
        >
          <input
            value={newSource}
            onChange={(e) => setNewSource(e.target.value)}
            placeholder="https://…/index.json"
            className="input text-sm flex-1"
            aria-label="Third-party source URL"
          />
          <button
            type="submit"
            disabled={!newSource.trim()}
            className="shrink-0 flex items-center gap-1 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3 py-2 disabled:opacity-40 transition"
          >
            <Plus size={14} /> Add repo
          </button>
        </form>
      </Modal>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
            // marketplace
          </div>
          {registry.isFetching && <span className="text-[10px] text-faint">loading…</span>}
          {officialOk === false && (
            <span className="text-[10px] font-mono text-faint" title="The official index couldn't be reached - showing the built-in list.">
              (offline - built-in list)
            </span>
          )}
          <div className="flex-1" />
          <div className="relative w-full max-w-xs">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter bundles…"
              className="input text-xs py-1 pl-7 pr-7"
              aria-label="Filter bundles"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-ember-500"
                title="Clear filter"
                aria-label="Clear filter"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {/* Sources live behind this button (HACS-style) — the add-a-repo
              field doesn't deserve prime real estate. Badge shows how many
              third-party repos are added on top of the official index. */}
          <button
            type="button"
            onClick={() => setSourcesOpen(true)}
            className="shrink-0 flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-muted hover:text-accent transition border border-line dark:border-slate-700 rounded px-2 py-1"
            title="Manage bundle sources - add a third-party repository"
          >
            <Library size={12} /> sources{sources.length ? ` · ${sources.length}` : ""}
          </button>
        </div>

        {q && shownCatalog.length === 0 && (
          <div className="text-xs text-faint dark:text-slate-500 italic py-2">
            No bundles match “{query.trim()}”.
          </div>
        )}
        <div className="space-y-4">
          {([
            ["// ready-made bundles", "one kind of thing, fields already shaped", shownSections.skins],
            ["// full-setup bundles", "several modules wired together", shownSections.setups],
          ] as const).map(([title, hint, list]) =>
            list.length === 0 ? null : (
              <BundleSection key={title} title={title} hint={hint}>
                {list.map((b) => {
                  const installed = installedIds.has(b.manifest.id);
                  const installedV = installedVersionById.get(b.manifest.id);
                  const updateAvailable = installed && !!installedV && installedV !== b.manifest.version;
                  const thirdParty = b.source && b.source !== "official";
                  return (
                    <BundleTile
                      key={b.manifest.id}
                      b={b}
                      showId
                      onOpen={() => setSelected({ mode: "featured", featured: b, alreadyInstalled: installed })}
                      badges={
                        <>
                          {updateAvailable ? (
                            <span className="text-[10px] font-mono uppercase tracking-widest text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded px-1.5 py-0.5" title={`Installed v${installedV} · latest v${b.manifest.version}`}>
                              update available
                            </span>
                          ) : installed ? (
                            <span className="text-[10px] font-mono uppercase tracking-widest text-moss-600 bg-moss-50 dark:bg-moss-950/30 border border-moss-200 dark:border-moss-800 rounded px-1.5 py-0.5">
                              installed
                            </span>
                          ) : null}
                          {thirdParty && (
                            <span className="text-[10px] font-mono uppercase tracking-widest text-faint border border-line dark:border-slate-700 rounded px-1.5 py-0.5" title={`From ${b.source}`}>
                              3rd-party
                            </span>
                          )}
                        </>
                      }
                    />
                  );
                })}
              </BundleSection>
            ),
          )}
        </div>
      </div>

      {/* ── Drivers lane (digifab declarative-HTTP machine drivers) ── */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">
          // drivers
        </div>
        <p className="text-[11px] text-faint dark:text-slate-500 mb-2">
          Machine drivers for the Digital Fabrication module - installed hot, no restart.
        </p>
        {(registry.data?.drivers.length ?? 0) === 0 ? (
          <div className="text-xs text-faint dark:text-slate-500 italic">No drivers in the registry yet.</div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {registry.data!.drivers.map((d) => (
              <li key={d.id} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3">
                <div className="text-2xl shrink-0">{d.glyph ?? "🔌"}</div>
                <button type="button" onClick={() => setRegItem({ kind: "driver", entry: d })} className="flex-1 min-w-0 text-left">
                  <div className="font-medium text-content dark:text-mortar-100 text-sm flex items-center gap-2 flex-wrap">
                    {d.name}
                    {d.source !== "official" && (
                      <span className="text-[10px] font-mono uppercase tracking-widest text-faint border border-line dark:border-slate-700 rounded px-1.5 py-0.5" title={`From ${d.source}`}>3rd-party</span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-0.5">{d.id}</div>
                  {d.blurb && <div className="text-xs text-content dark:text-mortar-200 mt-1.5">{d.blurb}</div>}
                  {d.caveat && <div className="text-[10px] text-faint dark:text-slate-500 italic mt-1">⚠ {d.caveat}</div>}
                </button>
                <button
                  type="button"
                  onClick={() => installDriver.mutate(d)}
                  disabled={installDriver.isPending}
                  className="shrink-0 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
                >
                  Install
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Modules lane (sandboxed WASM — signed, super-admin only) ── */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">
          // modules
        </div>
        <p className="text-[11px] text-faint dark:text-slate-500 mb-2">
          Sandboxed WASM modules - signature-verified, hot-installed.{" "}
          {isPlatformAdmin ? "Super-admin install." : "Installed by a platform super-admin."}
        </p>
        {(registry.data?.modules.length ?? 0) === 0 ? (
          <div className="text-xs text-faint dark:text-slate-500 italic">No modules published yet.</div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {registry.data!.modules.map((m) => (
              <li key={m.name} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3">
                <div className="text-2xl shrink-0">{m.glyph ?? "🧩"}</div>
                <button type="button" onClick={() => setRegItem({ kind: "module", entry: m })} className="flex-1 min-w-0 text-left">
                  <div className="font-medium text-content dark:text-mortar-100 text-sm flex items-center gap-2 flex-wrap">
                    {m.name}
                    <span className="text-[10px] font-mono text-faint">v{m.version}</span>
                    {m.trust === "official" ? (
                      <span className="text-[10px] font-mono uppercase tracking-widest text-moss-600 bg-moss-50 dark:bg-moss-950/30 border border-moss-200 dark:border-moss-800 rounded px-1.5 py-0.5" title="Signed by a Cobblr-vouched key">verified</span>
                    ) : (
                      <span className="text-[10px] font-mono uppercase tracking-widest text-faint border border-line dark:border-slate-700 rounded px-1.5 py-0.5" title={`Cobblr hasn't reviewed this — from ${m.source}`}>unverified</span>
                    )}
                  </div>
                  {(m.blurb || m.description) && <div className="text-xs text-content dark:text-mortar-200 mt-1.5">{m.blurb || m.description}</div>}
                </button>
                {isPlatformAdmin ? (
                  <button
                    type="button"
                    onClick={() => void onInstallModule(m)}
                    disabled={installModule.isPending}
                    className="shrink-0 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
                  >
                    Install
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] font-mono uppercase tracking-widest text-faint self-center">super-admin</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Renderers lane (sandboxed file-preview renderers) ── */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">
          // renderers
        </div>
        <p className="text-[11px] text-faint dark:text-slate-500 mb-2">
          File-preview renderers for extra formats - they run fully sandboxed (no network, no data
          access), so a new file type previews without touching anything else.
        </p>
        {(registry.data?.renderers.length ?? 0) === 0 ? (
          <div className="text-xs text-faint dark:text-slate-500 italic">No renderers in the registry yet.</div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {registry.data!.renderers.map((r) => {
              const installed = installedRendererNames.has(r.name);
              return (
                <li key={r.name} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3">
                  <div className="text-2xl shrink-0">{r.glyph ?? "🖼️"}</div>
                  <button type="button" onClick={() => setRegItem({ kind: "renderer", entry: r })} className="flex-1 min-w-0 text-left">
                    <div className="font-medium text-content dark:text-mortar-100 text-sm flex items-center gap-2 flex-wrap">
                      {r.name}
                      <span className="text-[10px] font-mono text-faint">.{r.exts.join(" .")}</span>
                      {r.trust === "official" ? (
                        <span className="text-[10px] font-mono uppercase tracking-widest text-moss-600 bg-moss-50 dark:bg-moss-950/30 border border-moss-200 dark:border-moss-800 rounded px-1.5 py-0.5" title="Signed by a Cobblr-vouched key">verified</span>
                      ) : (
                        <span className="text-[10px] font-mono uppercase tracking-widest text-faint border border-line dark:border-slate-700 rounded px-1.5 py-0.5" title={`Cobblr hasn't reviewed this — from ${r.source}`}>unverified</span>
                      )}
                    </div>
                    {(r.blurb || r.description) && <div className="text-xs text-content dark:text-mortar-200 mt-1.5">{r.blurb || r.description}</div>}
                  </button>
                  {installed ? (
                    <span className="shrink-0 text-[10px] font-mono uppercase tracking-widest text-moss-600 self-center">installed</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onInstallRenderer(r)}
                      disabled={installRenderer.isPending}
                      className="shrink-0 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
                    >
                      Install
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form
        onSubmit={submit}
        className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3"
      >
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // install a bundle
        </div>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={8}
          placeholder='{"id":"my.bundle","version":"1.0.0","name":"My Bundle","wires":[...],"field_defs":[...]}'
          className="input font-mono text-xs"
        />
        {err && <div className="text-xs text-ember-500 break-words">{err}</div>}
        {ok && <div className="text-xs text-moss-600 dark:text-moss-300">{ok}</div>}
        <button
          type="submit"
          disabled={!paste.trim() || install.isPending}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50 flex items-center gap-1.5"
        >
          <Package size={14} />
          {install.isPending ? "…" : "Install"}
        </button>
      </form>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
          // installed bundles
        </div>
        {bundles.isLoading && <div className="text-xs text-faint">loading…</div>}
        {bundles.data?.items.length === 0 && (
          <div className="text-xs text-faint dark:text-slate-500 italic">
            Nothing installed yet - pick a bundle from the marketplace above and it lands here.
          </div>
        )}
        <ul className="space-y-2">
          {bundles.data?.items.map((b) => (
            <li
              key={b.id}
              className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 flex items-stretch hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
            >
              <button
                type="button"
                onClick={() => setSelected({ mode: "installed", bundle: b })}
                className="flex-1 min-w-0 text-left p-4 text-sm flex items-start gap-3"
              >
                <Package size={18} className="text-accent mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-content dark:text-mortar-100">
                    {b.name}{" "}
                    <span className="text-[10px] font-mono text-faint">
                      v{b.version}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-faint dark:text-slate-500 mt-0.5">
                    {b.external_id}
                    {b.author ? ` · ${b.author}` : ""}
                  </div>
                  {b.description && (
                    <div className="text-xs text-content dark:text-mortar-200 mt-2">
                      {b.description}
                    </div>
                  )}
                </div>
                <ChevronRight
                  size={14}
                  className="text-faint dark:text-slate-600 group-hover:text-accent transition mt-1"
                />
              </button>
              <button
                type="button"
                onClick={() => handleRemoveBundle(b)}
                disabled={uninstall.isPending}
                title={`Remove ${b.name}`}
                aria-label={`Remove ${b.name}`}
                // Icon-only + hover-only colour was invisible on mobile (no
                // hover on touch). Always-visible label + ember tint + a real
                // touch target so it reads as a tappable Remove on a phone.
                className="shrink-0 px-4 min-w-[64px] flex flex-col items-center justify-center gap-0.5 border-l border-line dark:border-slate-700 text-ember-500/80 hover:text-ember-600 hover:bg-ember-50 active:bg-ember-100 dark:hover:bg-ember-950/20 dark:active:bg-ember-950/40 transition disabled:opacity-40"
              >
                <Trash2 size={16} />
                <span className="text-[10px] font-medium leading-none">Remove</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {selected?.mode === "installed" ? (
        <BundleDetailModal
          open
          onClose={() => setSelected(null)}
          slug={slug}
          mode="installed"
          bundle={selected.bundle}
        />
      ) : selected?.mode === "featured" ? (
        <BundleDetailModal
          // key by bundle id so per-bundle state (selected features, post-install
          // panel) resets when switching bundles in the same modal slot.
          key={selected.featured.manifest.id}
          open
          onClose={() => setSelected(null)}
          slug={slug}
          mode="featured"
          manifest={selected.featured.manifest}
          glyph={selected.featured.glyph}
          blurb={selected.featured.blurb}
          alreadyInstalled={selected.alreadyInstalled}
          installedBundleId={
            bundles.data?.items.find(
              (x) => x.external_id === selected.featured.manifest.id,
            )?.id ?? null
          }
          installedVersion={installedVersionById.get(selected.featured.manifest.id) ?? null}
          nextSteps={selected.featured.next_steps}
        />
      ) : (
        <BundleDetailModal
          open={false}
          onClose={() => setSelected(null)}
          slug={slug}
          mode={null}
        />
      )}

      <RegistryItemModal
        open={!!regItem}
        onClose={() => setRegItem(null)}
        item={regItem}
        installed={regItem?.kind === "renderer" ? installedRendererNames.has(regItem.entry.name) : false}
        canInstall={regItem?.kind === "module" ? isPlatformAdmin : true}
        cannotInstallNote="Super-admin only"
        busy={installDriver.isPending || installModule.isPending || installRenderer.isPending}
        onInstall={() => {
          if (!regItem) return;
          if (regItem.kind === "driver") installDriver.mutate(regItem.entry);
          else if (regItem.kind === "module") void onInstallModule(regItem.entry);
          else void onInstallRenderer(regItem.entry);
          setRegItem(null);
        }}
      />
    </div>
  );
}

// Marketplace v0.2 author tool: preview + publish the current
// workspace's customisations (field defs + wires) as a bundle
// manifest. Editable metadata so the bundle is self-documenting:
// name, id, version, description, author.
function ExportBundleModal({
  slug,
  onClose,
}: {
  slug: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [manifest, setManifest] = useState<PlatformBundleManifest | null>(null);
  // Editable metadata fields — overlaid on the manifest from the server.
  const [meta, setMeta] = useState({
    id: "",
    name: "",
    version: "0.1.0",
    description: "",
    author: "",
  });

  // Fetch the manifest on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.exportBundle(slug);
        if (cancelled) return;
        setManifest(res.manifest);
        setMeta({
          id: res.manifest.id || "my-workspace-bundle",
          name: res.manifest.name || "My workspace bundle",
          version: res.manifest.version || "0.1.0",
          description: res.manifest.description || "",
          author: res.manifest.author || "",
        });
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const finalManifest: PlatformBundleManifest | null = manifest
    ? { ...manifest, ...meta }
    : null;
  const json = finalManifest
    ? JSON.stringify({ manifest: finalManifest }, null, 2)
    : "";
  const wireCount = manifest?.wires?.length ?? 0;
  const fieldCount = manifest?.field_defs?.length ?? 0;

  function download() {
    if (!finalManifest) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${finalManifest.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Bundle JSON downloaded");
  }

  function copy() {
    if (!json) return;
    void navigator.clipboard.writeText(json);
    toast.success("Bundle JSON copied to clipboard");
  }

  return (
    <Modal open onClose={onClose} title="Publish your workspace as a bundle" size="lg">
      {loading && <div className="text-sm text-muted">Loading…</div>}
      {err && <div className="text-sm text-ember-500">{err}</div>}
      {!loading && !err && finalManifest && (
        <div className="space-y-3">
          <p className="text-xs text-muted dark:text-slate-400">
            Bundles the field defs + wires you've created in this
            workspace - module-contributed ones are excluded since
            they'd re-install with the module anyway. Edit the
            metadata below before exporting; the JSON updates live.
          </p>
          <div className="text-[11px] font-mono text-muted dark:text-slate-400 flex gap-3">
            <span>
              <strong className="text-content dark:text-mortar-100">{wireCount}</strong> wire
              {wireCount === 1 ? "" : "s"}
            </span>
            <span>
              <strong className="text-content dark:text-mortar-100">{fieldCount}</strong> field def
              {fieldCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bundle ID (kebab-case, unique)">
              <input
                type="text"
                value={meta.id}
                onChange={(e) => setMeta((m) => ({ ...m, id: e.target.value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-") }))}
                className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </Field>
            <Field label="Version (semver)">
              <input
                type="text"
                value={meta.version}
                onChange={(e) => setMeta((m) => ({ ...m, version: e.target.value }))}
                className="w-full px-2 py-1 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </Field>
            <Field label="Display name" className="col-span-2">
              <input
                type="text"
                value={meta.name}
                onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))}
                className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </Field>
            <Field label="Description" className="col-span-2">
              <textarea
                value={meta.description}
                onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
                rows={2}
                className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </Field>
            <Field label="Author" className="col-span-2">
              <input
                type="text"
                value={meta.author}
                onChange={(e) => setMeta((m) => ({ ...m, author: e.target.value }))}
                placeholder="e.g. Sarah's LUG, jane@example.com"
                className="w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              />
            </Field>
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1">
              preview
            </div>
            <pre className="max-h-48 overflow-auto text-[10px] font-mono p-3 rounded bg-subtle dark:bg-slate-900 border border-line dark:border-slate-700 text-content dark:text-mortar-200">
              {json}
            </pre>
          </div>
          <div className="flex items-center gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={() => {
                void navigator.share?.({
                  title: meta.name,
                  text: meta.description,
                });
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-muted hover:text-accent transition"
              title="Web Share (mobile / browsers that support it)"
            >
              <Share2 size={12} />
            </button>
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-line dark:border-slate-700 text-content hover:text-accent"
            >
              <Copy size={12} /> Copy JSON
            </button>
            <button
              type="button"
              onClick={download}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white"
            >
              <Download size={12} /> Download
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}
