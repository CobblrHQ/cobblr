// /bundles — list installed bundles + a paste-JSON install form.
// Phase 4 stops short of a hosted registry; bundles are local
// JSON the user pastes / uploads.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, Package } from "lucide-react";
import { ApiError, api, type PlatformBundle, type PlatformBundleManifest } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { FEATURED_BUNDLES } from "../lib/featured-bundles";
import { BundleDetailModal } from "../components/BundleDetailModal";
import { useToast } from "@cobblr/platform-web";

export function BundlesPage() {
  const { activeSlug: slug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<PlatformBundle | null>(null);
  const bundles = useQuery({
    queryKey: ["bundles", slug],
    queryFn: () => api.listBundles(slug),
    enabled: !!slug,
  });

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

  async function exportNow() {
    try {
      const { manifest } = await api.exportBundle(slug);
      const blob = new Blob([JSON.stringify({ manifest }, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${manifest.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setErr(null);
      setOk(null);
      toast.success(
        `Exported ${manifest.wires?.length ?? 0} wire(s) and ${manifest.field_defs?.length ?? 0} field def(s).`,
      );
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      setErr(msg);
      toast.error(msg);
    }
  }

  const installedIds = new Set(
    bundles.data?.items.map((b) => b.external_id) ?? [],
  );

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          bundles
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          publishable presets that wire modules together
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void exportNow()}
          className="text-[10px] font-mono uppercase tracking-widest text-slate-500 hover:text-cobble-600 transition flex items-center gap-1"
          title="Download your wires + field defs as a bundle JSON"
        >
          <Download size={12} /> export mine
        </button>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
          // featured
        </div>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {FEATURED_BUNDLES.map((b) => {
            const installed = installedIds.has(b.manifest.id);
            return (
              <li
                key={b.manifest.id}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 flex items-start gap-3"
              >
                <div className="text-2xl shrink-0">{b.glyph}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-700 dark:text-mortar-100 text-sm">
                    {b.manifest.name}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-0.5">
                    {b.manifest.id}
                  </div>
                  <div className="text-xs text-slate-600 dark:text-mortar-200 mt-1.5">
                    {b.blurb}
                  </div>
                  <button
                    type="button"
                    onClick={() => install.mutate(b.manifest)}
                    disabled={installed || install.isPending}
                    className={
                      "mt-2 text-[11px] font-mono uppercase tracking-widest px-2 py-1 rounded-md transition " +
                      (installed
                        ? "border border-moss-200 text-moss-600 bg-moss-50 cursor-default"
                        : "border border-slate-200 dark:border-slate-700 text-cobble-600 hover:bg-mortar-50 dark:hover:bg-slate-800/70")
                    }
                  >
                    {installed ? "installed" : "install"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <form
        onSubmit={submit}
        className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3"
      >
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
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
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
          // installed bundles
        </div>
        {bundles.isLoading && <div className="text-xs text-slate-400">loading…</div>}
        {bundles.data?.items.length === 0 && (
          <div className="text-xs text-slate-400 dark:text-slate-500 italic">
            No bundles installed.
          </div>
        )}
        <ul className="space-y-2">
          {bundles.data?.items.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setSelected(b)}
                className="w-full text-left rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-sm flex items-start gap-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
              >
                <Package size={18} className="text-cobble-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-700 dark:text-mortar-100">
                    {b.name}{" "}
                    <span className="text-[10px] font-mono text-slate-400">
                      v{b.version}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 dark:text-slate-500 mt-0.5">
                    {b.external_id}
                    {b.author ? ` · ${b.author}` : ""}
                  </div>
                  {b.description && (
                    <div className="text-xs text-slate-600 dark:text-mortar-200 mt-2">
                      {b.description}
                    </div>
                  )}
                </div>
                <ChevronRight
                  size={14}
                  className="text-slate-300 dark:text-slate-600 group-hover:text-cobble-500 transition mt-1"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <BundleDetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        slug={slug}
        bundle={selected}
      />
    </div>
  );
}
