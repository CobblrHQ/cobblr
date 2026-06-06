// Bundle detail modal — used for both installed and featured (not
// yet installed) bundles. The two modes share the same preview shape
// (description, screenshots, readme, wires + field defs the manifest
// declares); the footer changes:
//
//   installed       → uninstall + download
//   featured/preview → install + download
//
// For installed bundles we additionally hit /bundles/:id to fetch the
// actually-installed wires/field-defs (in case the manifest drifted).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CheckCircle2, Download, Package, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  ApiError,
  api,
  type PlatformBundle,
  type PlatformBundleManifest,
} from "../lib/api";
import type { BundleNextStep } from "../lib/featured-bundles";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";

interface InstalledMode {
  mode: "installed";
  bundle: PlatformBundle;
}

interface FeaturedMode {
  mode: "featured";
  manifest: PlatformBundleManifest;
  /** Optional glyph from the featured catalog. */
  glyph?: string;
  /** Optional cleaner one-line blurb. */
  blurb?: string;
  /** Set to true if the bundle's external_id matches one already
   *  installed — the modal shows "Already installed" instead of
   *  enabling Install. */
  alreadyInstalled?: boolean;
  /** When alreadyInstalled, the internal id of the installed bundle, so
   *  the footer can offer an enabled Remove right from the marketplace
   *  modal (uninstall is keyed by internal id, not external_id). */
  installedBundleId?: string | null;
  /** Post-install guided steps for the "what's next" panel. */
  nextSteps?: BundleNextStep[];
}

type Props = {
  open: boolean;
  onClose: () => void;
  slug: string;
} & (InstalledMode | FeaturedMode | { mode: null });

export function BundleDetailModal(props: Props) {
  const { open, onClose, slug } = props;
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  // After a successful install we keep the modal open and swap to a
  // "what's next" panel instead of dumping the user back on the page.
  const [justInstalled, setJustInstalled] = useState<{ wires: number; field_defs: number } | null>(null);

  // Installed-only: fetch the actually-installed wires + field defs.
  const installedBundleId = props.mode === "installed" ? props.bundle.id : null;
  const detail = useQuery({
    queryKey: ["bundle-detail", slug, installedBundleId],
    queryFn: () => api.getBundle(slug, installedBundleId!),
    enabled: open && !!installedBundleId,
  });

  // The bundle to uninstall: the installed bundle in installed mode, or a
  // marketplace bundle the user already has installed (featured mode) so
  // Remove works from the marketplace modal too.
  const uninstallId =
    props.mode === "installed"
      ? props.bundle.id
      : props.mode === "featured"
        ? props.installedBundleId ?? null
        : null;

  const uninstall = useMutation({
    mutationFn: () => api.uninstallBundle(slug, uninstallId!),
    onSuccess: () => {
      toast.success(`Uninstalled.`);
      void qc.invalidateQueries({ queryKey: ["bundles", slug] });
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't uninstall.");
    },
  });

  const install = useMutation({
    mutationFn: (vars: { manifest: PlatformBundleManifest; confirm: boolean }) =>
      api.installBundle(slug, vars.manifest, vars.confirm),
    onSuccess: (r) => {
      toast.success(
        `Installed ${r.bundle.name} v${r.bundle.version} — ${r.applied.wires} wire(s), ${r.applied.field_defs} field def(s).`,
      );
      void qc.invalidateQueries({ queryKey: ["bundles", slug] });
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      // The install may have enabled new modules — refresh the nav so they
      // appear (and so the "what's next" links land on a populated sidebar).
      void qc.invalidateQueries({ queryKey: ["org-modules", slug] });
      // Keep the modal open; show the guided "what's next" panel.
      setJustInstalled(r.applied);
    },
    onError: (e: unknown) => {
      // `needs_enable` is handled by handleInstall's confirm prompt —
      // don't also surface it as a raw error toast.
      if (e instanceof ApiError && e.code === "needs_enable") return;
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    },
  });

  async function handleUninstall() {
    if (!uninstallId) return;
    const bundleName =
      props.mode === "installed"
        ? props.bundle.name
        : props.mode === "featured"
          ? props.manifest?.name ?? "this bundle"
          : "this bundle";
    const ok = await confirm({
      title: `Remove ${bundleName}?`,
      message: `This removes the bundle's wires and custom fields. Your data (parts, tasks, etc.) is untouched — only the bundle-installed customisations go.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) uninstall.mutate();
  }

  if (props.mode === null || !open) return null;

  // Derive the shared rendering shape — the manifest for previews
  // comes from either the installed bundle's stored manifest or the
  // featured catalog's manifest.
  const manifest: PlatformBundleManifest | undefined =
    props.mode === "installed"
      ? ((detail.data?.bundle as { manifest?: PlatformBundleManifest } | undefined)?.manifest ??
        props.bundle.manifest)
      : props.manifest;

  const name = props.mode === "installed" ? props.bundle.name : manifest?.name ?? "";
  const externalId =
    props.mode === "installed" ? props.bundle.external_id : manifest?.id ?? "";
  const version = props.mode === "installed" ? props.bundle.version : manifest?.version ?? "";
  const author =
    props.mode === "installed" ? props.bundle.author : manifest?.author ?? null;
  const description =
    props.mode === "installed" ? props.bundle.description : (manifest?.description ?? null);

  // Install — transparently offering to enable any module the bundle
  // depends on. The backend answers 409 `needs_enable` with the list of
  // missing modules; instead of dead-ending on that error, we ask once
  // and re-install with confirm:true (enable + install in one step).
  async function handleInstall() {
    if (!manifest) return;
    try {
      await install.mutateAsync({ manifest, confirm: false });
    } catch (e) {
      if (e instanceof ApiError && e.code === "needs_enable") {
        const mods =
          (e.details as { needs_enable?: string[] } | undefined)?.needs_enable ?? [];
        const list = mods
          .map((m) => m.charAt(0).toUpperCase() + m.slice(1))
          .join(", ");
        const plural = mods.length > 1;
        const ok = await confirm({
          title: `Enable ${plural ? "modules" : "module"} for this bundle?`,
          message: `"${name}" needs the ${list} module${plural ? "s" : ""}, which ${
            plural ? "aren't" : "isn't"
          } enabled in this workspace yet. Enable ${
            plural ? "them" : "it"
          } and install in one step?`,
          confirmLabel: "Enable & install",
        });
        if (ok) await install.mutateAsync({ manifest, confirm: true }).catch(() => {});
      }
      // Any other error was already toasted by the mutation's onError.
    }
  }

  // For installed: wires + field defs come from the server (live state).
  // For featured: we render the manifest's declared wires + field defs
  // so the user can see EXACTLY what installing will do.
  const wires =
    props.mode === "installed"
      ? (detail.data?.wires ?? []).map((w) => ({
          id: w.id,
          source_kind: w.source_kind,
          action_id: w.action_id,
          trigger_type: w.trigger_type,
          trigger_event: w.trigger_event,
          template: w.template,
        }))
      : (manifest?.wires ?? []).map((w, i) => ({
          id: `preview-${i}`,
          source_kind: w.source_kind,
          action_id: w.action_id,
          trigger_type: w.trigger_type ?? "user-invoked",
          trigger_event: w.trigger_event ?? null,
          template: w.template ?? null,
        }));

  const fieldDefs =
    props.mode === "installed"
      ? (detail.data?.field_defs ?? []).map((f) => ({
          id: f.id,
          entity_kind: f.entity_kind,
          name: f.name,
          display_label: f.display_label,
          type: f.type,
        }))
      : (manifest?.field_defs ?? []).map((f, i) => ({
          id: `preview-${i}`,
          entity_kind: f.entity_kind,
          name: f.name,
          display_label: f.display_label,
          type: f.type,
        }));

  const readme = manifest?.readme_md;
  const screenshots = manifest?.screenshots ?? [];
  const requires = manifest?.requires ?? [];
  const providesLens = manifest?.provides_lens;

  function downloadManifest() {
    if (!manifest) return;
    const blob = new Blob([JSON.stringify({ manifest }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${externalId || "bundle"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.info("Manifest downloaded.");
  }

  const subtitle = `${externalId}${version ? ` · v${version}` : ""}${
    author ? ` · by ${author}` : ""
  }`;
  const titlePrefix =
    props.mode === "featured" && props.glyph ? `${props.glyph} ` : "";

  // Post-install guided steps: use the bundle's declared next_steps, else
  // fall back to one "go to" link per unique required module.
  const declaredSteps = props.mode === "featured" ? props.nextSteps : undefined;
  const nextSteps: BundleNextStep[] = declaredSteps?.length
    ? declaredSteps
    : [...new Set(requires.map((r) => r.module))].map((m) => ({
        label: `Go to ${m.charAt(0).toUpperCase() + m.slice(1)}`,
        module: m,
      }));

  function goTo(moduleName: string) {
    setJustInstalled(null);
    onClose();
    navigate(`/${moduleName}`);
  }

  // Just installed → the "what's next" panel instead of the closed modal.
  if (justInstalled) {
    return (
      <Modal open={open} onClose={onClose} title={`${titlePrefix}${name}`} subtitle="installed" size="lg">
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={22} className="text-moss-600 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-content dark:text-mortar-100">{name} is set up.</div>
              <div className="text-sm text-faint dark:text-slate-400 mt-0.5">
                Added {justInstalled.field_defs} field{justInstalled.field_defs === 1 ? "" : "s"}
                {justInstalled.wires > 0
                  ? ` and ${justInstalled.wires} automation${justInstalled.wires === 1 ? "" : "s"}`
                  : ""}
                . Here's where to start:
              </div>
            </div>
          </div>
          {nextSteps.length > 0 && (
            <ul className="space-y-2">
              {nextSteps.map((s, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => goTo(s.module)}
                    className="w-full text-left rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 flex items-center gap-3 hover:border-cobble-300 dark:hover:border-cobble-700 transition group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-content dark:text-mortar-100">{s.label}</div>
                      {s.hint && (
                        <div className="text-xs text-faint dark:text-slate-400 mt-0.5">{s.hint}</div>
                      )}
                    </div>
                    <ArrowRight size={16} className="text-faint group-hover:text-accent transition shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end pt-3 border-t border-line dark:border-slate-700">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              I'll explore on my own
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={`${titlePrefix}${name}`} subtitle={subtitle} size="lg">
      <div className="space-y-5">
        {props.mode === "featured" && props.blurb && (
          <p className="text-sm text-content dark:text-mortar-200 italic">
            {props.blurb}
          </p>
        )}
        {description && (
          <p className="text-sm text-content dark:text-mortar-200">{description}</p>
        )}

        {screenshots.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {screenshots.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={`${name} screenshot ${i + 1}`}
                className="h-32 rounded-md border border-line dark:border-slate-700 object-cover shrink-0"
                loading="lazy"
              />
            ))}
          </div>
        )}

        {readme && (
          <Section title="walkthrough">
            <div className="prose prose-sm dark:prose-invert max-w-none text-content dark:text-mortar-100">
              <ReactMarkdown>{readme}</ReactMarkdown>
            </div>
          </Section>
        )}

        <dl className="grid grid-cols-3 gap-2 text-xs">
          {props.mode === "installed" ? (
            <Row label="Installed">
              {new Date(props.bundle.installed_at).toLocaleString()}
            </Row>
          ) : (
            <Row label="Status">
              {props.alreadyInstalled ? (
                <span className="text-moss-600">installed</span>
              ) : (
                <span className="text-faint">preview</span>
              )}
            </Row>
          )}
          <Row label={props.mode === "installed" ? "Wires installed" : "Wires added"}>
            {wires.length}
          </Row>
          <Row label={props.mode === "installed" ? "Fields installed" : "Fields added"}>
            {fieldDefs.length}
          </Row>
        </dl>

        {requires.length > 0 && (
          <Section title="requires modules">
            <div className="flex flex-wrap gap-1.5">
              {requires.map((r) => (
                <span
                  key={r.module}
                  className="font-mono text-[11px] px-2 py-0.5 rounded border border-line dark:border-slate-700 text-content dark:text-mortar-200"
                >
                  {r.module}
                  {r.version ? `@${r.version}` : ""}
                </span>
              ))}
            </div>
          </Section>
        )}

        {providesLens && (
          <Section title="provides a lens">
            <div className="text-xs text-content dark:text-mortar-200">
              Adds a{" "}
              <strong>{providesLens.display_name ?? providesLens.name}</strong> view
              under <code className="font-mono">{providesLens.entity_kind}</code>.
            </div>
          </Section>
        )}

        {/* Wires */}
        <Section title={`wires (${wires.length})`}>
          {wires.length === 0 ? (
            <EmptyHint>This bundle doesn't add any wires.</EmptyHint>
          ) : (
            <ul className="space-y-1.5">
              {wires.map((w) => (
                <li
                  key={w.id}
                  className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-xs"
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <code className="font-mono text-accent dark:text-cobble-300">
                      {w.source_kind}
                    </code>
                    <span className="text-faint">→</span>
                    <code className="font-mono text-accent dark:text-cobble-300">
                      {w.action_id}
                    </code>
                    <span className="text-[10px] font-mono text-faint">
                      ({w.trigger_type}
                      {w.trigger_event ? ` on ${w.trigger_event}` : ""})
                    </span>
                  </div>
                  {w.template && (
                    <div className="mt-1.5 font-mono text-[11px] text-content dark:text-mortar-200 bg-subtle dark:bg-slate-800/70 rounded px-2 py-1 break-all">
                      {w.template}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Field defs */}
        <Section title={`custom fields (${fieldDefs.length})`}>
          {fieldDefs.length === 0 ? (
            <EmptyHint>This bundle doesn't add any custom fields.</EmptyHint>
          ) : (
            <ul className="space-y-1">
              {fieldDefs.map((f) => (
                <li
                  key={f.id}
                  className="flex items-baseline gap-3 text-sm text-content dark:text-mortar-100 py-1 border-b border-line dark:border-slate-700 last:border-0"
                >
                  <code className="font-mono text-xs text-accent dark:text-cobble-300 w-32 truncate">
                    {f.entity_kind}
                  </code>
                  <code className="font-mono text-xs text-faint w-32 truncate">
                    {f.name}
                  </code>
                  <span className="flex-1">{f.display_label}</span>
                  <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
                    {f.type}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Raw manifest collapsible */}
        {manifest && (
          <details className="text-xs">
            <summary className="font-mono uppercase tracking-widest text-[10px] text-faint cursor-pointer">
              View raw manifest JSON
            </summary>
            <pre className="mt-2 p-2 rounded bg-subtle dark:bg-slate-800 font-mono text-[11px] overflow-x-auto text-content dark:text-mortar-200 max-h-64">
              {JSON.stringify(manifest, null, 2)}
            </pre>
          </details>
        )}

        {/* Footer actions */}
        <div className="flex items-center justify-between pt-3 border-t border-line dark:border-slate-700">
          {props.mode === "installed" ? (
            <button
              onClick={handleUninstall}
              disabled={uninstall.isPending}
              className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition flex items-center gap-1"
            >
              <Trash2 size={11} /> {uninstall.isPending ? "removing…" : "uninstall bundle"}
            </button>
          ) : props.alreadyInstalled && uninstallId ? (
            // Marketplace modal, but the user already has this bundle —
            // offer Remove right here instead of making them hunt for the
            // installed-list row.
            <button
              onClick={handleUninstall}
              disabled={uninstall.isPending}
              className="text-xs font-medium px-3 py-1.5 rounded-md bg-ember-600 hover:bg-ember-700 text-white transition flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 size={13} />
              {uninstall.isPending ? "Removing…" : "Remove bundle"}
            </button>
          ) : (
            <button
              onClick={() => void handleInstall()}
              disabled={
                !manifest || install.isPending || props.alreadyInstalled === true
              }
              className="text-xs font-medium px-3 py-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white transition flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Package size={13} />
              {props.alreadyInstalled
                ? "Already installed"
                : install.isPending
                  ? "Installing…"
                  : "Install bundle"}
            </button>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={downloadManifest}
              disabled={!manifest}
              className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-accent transition flex items-center gap-1"
              title="Download the manifest JSON"
            >
              <Download size={11} /> download
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-0.5">
        {label}
      </dt>
      <dd className="text-content dark:text-mortar-100">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
        // {title}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-faint italic">{children}</div>;
}
