// /bundles — list installed bundles + a paste-JSON install form.
// Phase 4 stops short of a hosted registry; bundles are local
// JSON the user pastes / uploads.

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy, Download, Package, Plus, Share2, X } from "lucide-react";
import { Link } from "react-router-dom";
import { ApiError, api, type PlatformBundle, type PlatformBundleManifest, type RegistryDriverEntry, type RegistryModuleEntry } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useAuth } from "../auth/AuthContext";
import { FEATURED_BUNDLES, type FeaturedBundle } from "../lib/featured-bundles";
import { BundleDetailModal } from "../components/BundleDetailModal";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";

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
  const registry = useQuery({
    queryKey: ["registry-index", sources],
    queryFn: () => api.getRegistryIndex(sources),
  });
  const officialOk = registry.data?.sources.find((s) => s.label === "official")?.ok;
  const catalog: Array<FeaturedBundle & { source?: string }> =
    registry.data && registry.data.bundles.length > 0
      ? registry.data.bundles.map((e) => ({
          manifest: e.manifest,
          glyph: e.glyph ?? "📦",
          blurb: e.blurb ?? e.description ?? "",
          source: e.source,
        }))
      : FEATURED_BUNDLES;

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

  const installedIds = new Set(
    bundles.data?.items.map((b) => b.external_id) ?? [],
  );

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 lowercase">
          bundles
        </h1>
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">
          publishable presets that wire modules together
        </span>
        <div className="flex-1" />
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
      </div>
      {exportOpen && (
        <ExportBundleModal slug={slug} onClose={() => setExportOpen(false)} />
      )}

      <div>
        <div className="flex items-center gap-2 mb-2">
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
            // marketplace
          </div>
          {registry.isFetching && <span className="text-[10px] text-faint">loading…</span>}
          {officialOk === false && (
            <span className="text-[10px] font-mono text-faint" title="The official index couldn't be reached — showing the built-in list.">
              (offline — built-in list)
            </span>
          )}
        </div>

        {/* Add a third-party source (HACS-style custom repository): a URL to
            another index.json. Persisted in this browser; merged server-side. */}
        <div className="rounded-xl border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-900 p-3 mb-3 space-y-2">
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint">
            // sources
          </div>
          <ul className="space-y-1">
            <li className="flex items-center gap-2 text-xs text-muted">
              <span className="text-moss-600">●</span> official
              <span className="text-faint font-mono truncate">CobblrHQ/cobblr-extensions</span>
            </li>
            {sources.map((s) => {
              const st = registry.data?.sources.find((x) => x.label === s);
              return (
                <li key={s} className="flex items-center gap-2 text-xs text-muted">
                  <span title={st?.ok === false ? st.error : "ok"} className={st?.ok === false ? "text-ember-500" : "text-moss-600"}>
                    {st?.ok === false ? "✕" : "●"}
                  </span>
                  <span className="font-mono truncate flex-1 min-w-0">{s}</span>
                  <button type="button" onClick={() => setSources((p) => p.filter((x) => x !== s))} className="text-faint hover:text-ember-500 shrink-0" title="Remove source">
                    <X size={12} />
                  </button>
                </li>
              );
            })}
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
              placeholder="https://…/index.json  (a third-party source)"
              className="input text-xs flex-1 py-1"
            />
            <button type="submit" disabled={!newSource.trim()} className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-accent transition flex items-center gap-1 disabled:opacity-40 shrink-0">
              <Plus size={12} /> add
            </button>
          </form>
        </div>

        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {catalog.map((b) => {
            const installed = installedIds.has(b.manifest.id);
            const thirdParty = b.source && b.source !== "official";
            return (
              <li key={b.manifest.id}>
                <button
                  type="button"
                  onClick={() =>
                    setSelected({
                      mode: "featured",
                      featured: b,
                      alreadyInstalled: installed,
                    })
                  }
                  className="w-full text-left rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
                >
                  <div className="text-2xl shrink-0">{b.glyph}</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-content dark:text-mortar-100 text-sm flex items-center gap-2 flex-wrap">
                      {b.manifest.name}
                      {installed && (
                        <span className="text-[10px] font-mono uppercase tracking-widest text-moss-600 bg-moss-50 dark:bg-moss-950/30 border border-moss-200 dark:border-moss-800 rounded px-1.5 py-0.5">
                          installed
                        </span>
                      )}
                      {thirdParty && (
                        <span className="text-[10px] font-mono uppercase tracking-widest text-faint border border-line dark:border-slate-700 rounded px-1.5 py-0.5" title={`From ${b.source}`}>
                          3rd-party
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-0.5">
                      {b.manifest.id}
                    </div>
                    <div className="text-xs text-content dark:text-mortar-200 mt-1.5">
                      {b.blurb}
                    </div>
                  </div>
                  <ChevronRight
                    size={14}
                    className="text-faint dark:text-slate-600 group-hover:text-accent transition mt-1 shrink-0"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ── Drivers lane (digifab declarative-HTTP machine drivers) ── */}
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">
          // drivers
        </div>
        <p className="text-[11px] text-faint dark:text-slate-500 mb-2">
          Machine drivers for the Digital Fabrication module — installed hot, no restart.
        </p>
        {(registry.data?.drivers.length ?? 0) === 0 ? (
          <div className="text-xs text-faint dark:text-slate-500 italic">No drivers in the registry yet.</div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {registry.data!.drivers.map((d) => (
              <li key={d.id} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3">
                <div className="text-2xl shrink-0">{d.glyph ?? "🔌"}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-content dark:text-mortar-100 text-sm flex items-center gap-2 flex-wrap">
                    {d.name}
                    {d.source !== "official" && (
                      <span className="text-[10px] font-mono uppercase tracking-widest text-faint border border-line dark:border-slate-700 rounded px-1.5 py-0.5" title={`From ${d.source}`}>3rd-party</span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-faint dark:text-slate-500 mt-0.5">{d.id}</div>
                  {d.blurb && <div className="text-xs text-content dark:text-mortar-200 mt-1.5">{d.blurb}</div>}
                  {d.caveat && <div className="text-[10px] text-faint dark:text-slate-500 italic mt-1">⚠ {d.caveat}</div>}
                </div>
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
          Sandboxed WASM modules — signature-verified, hot-installed.{" "}
          {isPlatformAdmin ? "Super-admin install." : "Installed by a platform super-admin."}
        </p>
        {(registry.data?.modules.length ?? 0) === 0 ? (
          <div className="text-xs text-faint dark:text-slate-500 italic">No modules published yet.</div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {registry.data!.modules.map((m) => (
              <li key={m.name} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-start gap-3">
                <div className="text-2xl shrink-0">{m.glyph ?? "🧩"}</div>
                <div className="flex-1 min-w-0">
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
                </div>
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
            No bundles installed.
          </div>
        )}
        <ul className="space-y-2">
          {bundles.data?.items.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setSelected({ mode: "installed", bundle: b })}
                className="w-full text-left rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 text-sm flex items-start gap-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
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
          open
          onClose={() => setSelected(null)}
          slug={slug}
          mode="featured"
          manifest={selected.featured.manifest}
          glyph={selected.featured.glyph}
          blurb={selected.featured.blurb}
          alreadyInstalled={selected.alreadyInstalled}
        />
      ) : (
        <BundleDetailModal
          open={false}
          onClose={() => setSelected(null)}
          slug={slug}
          mode={null}
        />
      )}
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
            workspace — module-contributed ones are excluded since
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
