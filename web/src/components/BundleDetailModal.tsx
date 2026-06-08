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

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Compass, Download, Package, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  ApiError,
  api,
  type PlatformBundle,
  type PlatformBundleManifest,
} from "../lib/api";
import {
  resolveBundleManifest,
  resolveNextSteps,
  deriveNextSteps,
  FEATURED_BUNDLES,
  type BundleNextStep,
} from "../lib/featured-bundles";
import { recordSetup } from "../lib/setupCards";
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
  /** When alreadyInstalled, the version currently installed — if it differs
   *  from this manifest's version, the modal offers an Update instead of just
   *  "Already installed". */
  installedVersion?: string | null;
  /** Post-install guided steps for the "what's next" panel. */
  nextSteps?: BundleNextStep[];
  /** First-run wizard mode: on a successful install, skip the "what's next"
   *  panel and navigate straight into the bundle's landing module (the first
   *  next-step, else the first required module) so the user isn't stranded. */
  autoLand?: boolean;
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
  // First-run wizard: land the user inside the bundle on install instead of
  // showing the "what's next" panel (which is the right call from the
  // marketplace, but leaves a brand-new user a click short of their data).
  const autoLand = props.mode === "featured" && props.autoLand === true;
  // An installed bundle whose installed version differs from this manifest's
  // version → offer an Update (install supersedes by external_id).
  const installedVersion = props.mode === "featured" ? props.installedVersion ?? null : null;
  const isUpdate =
    props.mode === "featured" &&
    props.alreadyInstalled === true &&
    !!installedVersion &&
    installedVersion !== (props.manifest?.version ?? "");
  // A fresh install (featured bundle not yet installed) — the changelog is noise
  // for a first-time user, so we hide it. It only matters once installed/updating.
  const isFreshInstall = props.mode === "featured" && props.alreadyInstalled !== true;
  // After a successful install we keep the modal open and swap to a
  // "what's next" panel instead of dumping the user back on the page.
  // `reopened` = the user re-opened the "where to start" panel from an already-
  // installed bundle (no fresh "Added N fields" line — that's install-time only).
  const [justInstalled, setJustInstalled] = useState<{ wires: number; field_defs: number; reopened?: boolean } | null>(null);
  // Technical details (wires + custom fields + raw manifest) are collapsed by
  // default — a novice doesn't need them; the requires-modules row is the
  // always-visible accordion header.
  const [showTech, setShowTech] = useState(false);
  // Which optional features are checked. Lazy-init from each feature's `default`.
  // (Modal is keyed by bundle id in the parent, so this resets per bundle.)
  const [selectedFeatures, setSelectedFeatures] = useState<Set<string>>(
    () => new Set((props.mode === "featured" ? props.manifest.features : undefined)?.filter((f) => f.default).map((f) => f.key) ?? []),
  );

  // Installed-only: fetch the actually-installed wires + field defs + the
  // stored manifest (with features) + enabled_features (for "Manage features").
  const installedBundleId = props.mode === "installed" ? props.bundle.id : null;
  const detail = useQuery({
    queryKey: ["bundle-detail", slug, installedBundleId],
    queryFn: () => api.getBundle(slug, installedBundleId!),
    enabled: open && !!installedBundleId,
  });

  // Installed mode: once the detail loads, seed the feature checkboxes from the
  // bundle's stored enabled_features so the manage UI reflects reality.
  useEffect(() => {
    if (props.mode === "installed" && detail.data) {
      setSelectedFeatures(new Set(detail.data.bundle.enabled_features ?? []));
    }
  }, [props.mode, detail.data]);

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
      void qc.invalidateQueries({ queryKey: ["instances", slug] });
      void qc.invalidateQueries({ queryKey: ["entity-kind-overrides", slug] });
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't uninstall.");
    },
  });

  const install = useMutation({
    mutationFn: (vars: { manifest: PlatformBundleManifest; confirm: boolean; enabledFeatures?: string[] }) =>
      api.installBundle(slug, vars.manifest, vars.confirm, vars.enabledFeatures),
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
      // …and may have created module instances (Yarn/Hooks/Designs) — refresh
      // the instances + their nav overrides so the new entries + item_noun
      // ("New yarn") show without a full reload.
      void qc.invalidateQueries({ queryKey: ["instances", slug] });
      void qc.invalidateQueries({ queryKey: ["entity-kind-overrides", slug] });
      // Persist a "where to start" card to the dashboard so it's re-findable
      // after the user navigates away (the author: "I could never find it again").
      if (props.mode === "featured" && props.manifest) {
        recordSetup(slug, {
          externalId: r.bundle.external_id,
          name: r.bundle.name,
          glyph: props.glyph ?? "📦",
          nextSteps: deriveNextSteps(props.manifest, props.nextSteps, selectedFeatures),
        });
      }
      // Wizard mode lands straight in the module (handled in handleInstall);
      // marketplace mode keeps the modal open on the guided "what's next" panel.
      if (!autoLand) setJustInstalled(r.applied);
    },
    onError: (e: unknown) => {
      // `needs_enable` + `field_def_collision` are handled by handleInstall's
      // confirm prompts (enable-modules / replace-conflicting) — don't also
      // surface them as a raw error toast.
      if (e instanceof ApiError && (e.code === "needs_enable" || e.code === "field_def_collision")) return;
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    },
  });

  // Installed mode: change which optional features are on. v2 does this as a
  // reinstall (uninstall + install with the new enabled set) — reuses the
  // proven paths; entity data is untouched (only field defs/wires/views move).
  const saveFeatures = useMutation({
    mutationFn: async () => {
      if (props.mode !== "installed" || !detail.data) throw new Error("bundle not loaded");
      const full = detail.data.bundle.manifest;
      await api.uninstallBundle(slug, props.bundle.id);
      await api.installBundle(slug, full, true, [...selectedFeatures]);
    },
    onSuccess: () => {
      toast.success("Features updated.");
      void qc.invalidateQueries({ queryKey: ["bundles", slug] });
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      void qc.invalidateQueries({ queryKey: ["org-modules", slug] });
      void qc.invalidateQueries({ queryKey: ["instances", slug] });
      void qc.invalidateQueries({ queryKey: ["entity-kind-overrides", slug] });
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't update features."),
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

  // Featured bundles can carry opt-in features; merge the selected ones into
  // the manifest so the preview (wires/fields/requires/counts) and the install
  // all reflect exactly what the user checked. Base only in installed mode.
  // Opt-in features now live in the manifest. The featured preview merges the
  // checked ones for the live wires/fields/counts; install sends the FULL
  // manifest + the enabled keys and the backend resolves.
  const features = manifest?.features;
  const effectiveManifest: PlatformBundleManifest | undefined =
    props.mode === "featured" && features?.length && manifest
      ? resolveBundleManifest(manifest, selectedFeatures)
      : manifest;

  function toggleFeature(key: string) {
    setSelectedFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

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
  // Wizard mode: where to drop the user after install — the first resolved
  // next-step's module, else the first required module. Same precedence the
  // "what's next" panel uses, so marketplace + wizard agree. If the bundle
  // shipped a pinned view for that module's entity kind, land IN that view
  // (e.g. Yarn → /inventory?view=<My yarn stash>), so the curated, grouped
  // surface is the landing — its empty-state still carries the add CTA.
  async function landAfterInstall() {
    if (!autoLand) return;
    // Instance bundles (Yarn/Hooks/Designs) land in their primary instance —
    // its own page with its own fields + add flow.
    const instances = effectiveManifest?.provides_instances ?? [];
    if (instances[0]) {
      onClose();
      navigate(`/instances/${instances[0].instance_name}`);
      return;
    }
    const steps = resolveNextSteps(
      props.mode === "featured" ? props.nextSteps : undefined,
      features,
      selectedFeatures,
    );
    const mod = steps[0]?.module ?? effectiveManifest?.requires?.[0]?.module;
    if (!mod) return;
    let target = `/${mod}`;
    try {
      const pinned = (effectiveManifest?.saved_views ?? []).find(
        (v) => v.pinned && v.entity_kind.startsWith(`${mod}:`),
      );
      if (pinned) {
        const res = await api.listSavedViews(slug, pinned.entity_kind);
        const match = res.items.find((v) => v.name === pinned.name);
        if (match) target = `/${mod}?view=${match.id}`;
      }
    } catch {
      /* fall back to the plain module page */
    }
    onClose();
    navigate(target);
  }

  // Field-def collision → offer to SUPERSEDE the conflicting installed
  // bundle(s): "Replace Yarn Stash?". On OK, uninstall them (their fields/views
  // go; the user's items stay) so the new bundle can take over. Returns true if
  // the user approved a removal (caller should retry the install), false if it
  // can't be auto-resolved (module/workspace-owned fields) or the user declined.
  async function offerSupersede(e: ApiError): Promise<boolean> {
    const conflicts =
      (e.details as { conflicts?: Array<{ owned_by?: string }> } | undefined)?.conflicts ?? [];
    const bundleNames = [
      ...new Set(
        conflicts
          .map((c) => c.owned_by ?? "")
          .filter((o) => o.startsWith("bundle:"))
          .map((o) => o.slice("bundle:".length)),
      ),
    ];
    if (bundleNames.length === 0) {
      toast.error(e.message); // module/workspace-owned fields — can't auto-replace
      return false;
    }
    const list = bundleNames.join(", ");
    const plural = bundleNames.length > 1;
    const ok = await confirm({
      title: `Replace ${plural ? "these bundles" : `"${list}"`}?`,
      message: `${list} already ${plural ? "provide" : "provides"} some of these fields. Replace ${
        plural ? "them" : "it"
      } with "${name}"? This removes ${plural ? "their" : "its"} fields, views and automations — your items (parts, etc.) stay.`,
      confirmLabel: `Replace & install`,
      destructive: true,
    });
    if (!ok) return false;
    // Map the conflicting names → installed bundle ids and uninstall them.
    const installed = await api.listBundles(slug).catch(() => ({ items: [] }));
    const toRemove = installed.items.filter((b) => bundleNames.includes(b.name));
    for (const b of toRemove) {
      await api.uninstallBundle(slug, b.id).catch(() => {});
    }
    return true;
  }

  async function handleInstall() {
    if (!manifest) return;
    const enabledFeatures = [...selectedFeatures];
    let confirmEnable = false;
    // Up to a few passes: enable-modules confirm, then collision-supersede,
    // then the clean install. Each handled error sets up the next retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await install.mutateAsync({ manifest, confirm: confirmEnable, enabledFeatures });
        await landAfterInstall();
        return;
      } catch (e) {
        if (!(e instanceof ApiError)) return;
        if (e.code === "needs_enable") {
          const mods = (e.details as { needs_enable?: string[] } | undefined)?.needs_enable ?? [];
          const list = mods.map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(", ");
          const plural = mods.length > 1;
          const ok = await confirm({
            title: `Enable ${plural ? "modules" : "module"} for this bundle?`,
            message: `"${name}" needs the ${list} module${plural ? "s" : ""}, which ${
              plural ? "aren't" : "isn't"
            } enabled in this workspace yet. Enable ${plural ? "them" : "it"} and install in one step?`,
            confirmLabel: "Enable & install",
          });
          if (!ok) return;
          confirmEnable = true;
          continue;
        }
        if (e.code === "field_def_collision") {
          const handled = await offerSupersede(e);
          if (!handled) return;
          continue; // conflicting bundle(s) removed — retry install
        }
        return; // any other error was already toasted by the mutation's onError
      }
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
      : (effectiveManifest?.wires ?? []).map((w, i) => ({
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
      : (effectiveManifest?.field_defs ?? []).map((f, i) => ({
          id: `preview-${i}`,
          entity_kind: f.entity_kind,
          name: f.name,
          display_label: f.display_label,
          type: f.type,
        }));

  const readme = manifest?.readme_md;
  const screenshots = manifest?.screenshots ?? [];
  const requires = effectiveManifest?.requires ?? [];
  const providesLens = manifest?.provides_lens;

  function downloadManifest() {
    if (!effectiveManifest) return;
    const blob = new Blob([JSON.stringify({ manifest: effectiveManifest }, null, 2)], {
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

  // Post-install guided steps: the bundle's declared next_steps, else one "go
  // to" link per required DOMAIN module (core-* plumbing filtered). Shared with
  // the persisted dashboard setup card via deriveNextSteps so they agree. For an
  // installed bundle we re-derive from its stored manifest + the embedded
  // flagship's base next_steps (the registry drops the web-only next_steps).
  const installedManifest = props.mode === "installed" ? detail.data?.bundle.manifest : undefined;
  const installedBaseNextSteps =
    props.mode === "installed"
      ? FEATURED_BUNDLES.find((b) => b.manifest.id === props.bundle.external_id)?.next_steps
      : undefined;
  const nextSteps: BundleNextStep[] =
    props.mode === "featured" && props.manifest
      ? deriveNextSteps(props.manifest, props.nextSteps, selectedFeatures)
      : installedManifest
        ? deriveNextSteps(installedManifest, installedBaseNextSteps, selectedFeatures)
        : [...new Set(requires.map((r) => r.module))]
            .filter((m) => !m.startsWith("core-"))
            .map((m) => ({
              label: `Go to ${m.charAt(0).toUpperCase() + m.slice(1)}`,
              module: m,
            }));

  // Navigate to a step's target: an explicit `path` (e.g. an instance route
  // "/instances/yarn/items") wins, else the module's own route.
  function goTo(target: string) {
    setJustInstalled(null);
    onClose();
    navigate(target.startsWith("/") ? target : `/${target}`);
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
                {justInstalled.reopened ? (
                  "Here's where to start:"
                ) : (
                  <>
                    Added {justInstalled.field_defs} field{justInstalled.field_defs === 1 ? "" : "s"}
                    {justInstalled.wires > 0
                      ? ` and ${justInstalled.wires} automation${justInstalled.wires === 1 ? "" : "s"}`
                      : ""}
                    . Here's where to start:
                  </>
                )}
              </div>
            </div>
          </div>
          {nextSteps.length > 0 && (
            <ul className="space-y-2">
              {nextSteps.map((s, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => goTo(s.path ?? s.module)}
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

        {/* Re-open the post-install "where to start" guide from an installed
            bundle (the author: "once I navigated away I could never find it again"). */}
        {props.mode === "installed" && nextSteps.length > 0 && (
          <button
            type="button"
            onClick={() => setJustInstalled({ wires: 0, field_defs: 0, reopened: true })}
            className="w-full text-left rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-3 py-2.5 flex items-center gap-2 hover:border-cobble-400 transition group"
          >
            <Compass size={15} className="text-accent shrink-0" />
            <span className="text-sm font-medium text-content dark:text-mortar-100">Where to start</span>
            <span className="text-xs text-faint dark:text-slate-400">— jump into what this set up</span>
            <div className="flex-1" />
            <ArrowRight size={15} className="text-faint group-hover:text-accent transition shrink-0" />
          </button>
        )}

        {/* What's new — shown prominently when updating; the technical detail of
            what the new version touches stays in the requires/details accordion.
            Hidden on a fresh install (noise for a first-time user). */}
        {manifest?.changelog && !isFreshInstall && (
          <div
            className={
              "rounded-md border p-3 " +
              (isUpdate
                ? "border-cobble-400 dark:border-cobble-600 bg-cobble-50 dark:bg-cobble-900/30"
                : "border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-800/40")
            }
          >
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
                {isUpdate ? `what's new in v${version}` : `v${version} changes`}
              </span>
              {manifest.released_at && (
                <span className="text-[10px] font-mono text-faint dark:text-slate-500">
                  {new Date(manifest.released_at).toLocaleDateString()}
                </span>
              )}
            </div>
            <p className="text-sm text-content dark:text-mortar-200 whitespace-pre-line">{manifest.changelog}</p>
          </div>
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

        {features && features.length > 0 && (
          <Section title={props.mode === "installed" ? "features" : "optional features"}>
            <p className="text-xs text-faint dark:text-slate-400 mb-2">
              {props.mode === "installed"
                ? "Turn capabilities on or off, then save. Re-applies the bundle with your choice — your entities (parts, designs, …) stay; only the bundle's fields/views/automations change."
                : "The basics are always included. Turn on what you want — the fields, views, and modules below update to match. (Changeable anytime after install.)"}
            </p>
            <ul className="space-y-1.5">
              {features.map((f) => {
                const on = selectedFeatures.has(f.key);
                return (
                  <li key={f.key}>
                    <label
                      className={
                        "flex items-start gap-3 rounded-md border p-3 cursor-pointer transition " +
                        (on
                          ? "border-cobble-500 dark:border-cobble-500 bg-cobble-50 dark:bg-cobble-900/30"
                          : "border-line dark:border-slate-700 bg-surface dark:bg-slate-900 hover:border-cobble-300 dark:hover:border-cobble-700")
                      }
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleFeature(f.key)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-cobble-600"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-content dark:text-mortar-100">{f.question ?? f.name}</div>
                        {f.description && (
                          <div className="text-xs text-muted dark:text-slate-300 mt-0.5">{f.description}</div>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
            {props.mode === "installed" &&
              (() => {
                const current = new Set(detail.data?.bundle.enabled_features ?? []);
                const dirty =
                  current.size !== selectedFeatures.size ||
                  [...selectedFeatures].some((k) => !current.has(k));
                return (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => saveFeatures.mutate()}
                      disabled={!dirty || saveFeatures.isPending}
                      className="text-xs font-medium px-3 py-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {saveFeatures.isPending ? "Saving…" : "Save feature changes"}
                    </button>
                  </div>
                );
              })()}
          </Section>
        )}

        {/* Technical details — collapsed for novices. The always-visible header
            row is the required modules; the toggle on its left expands the
            wires + custom fields + raw manifest. */}
        <div className="rounded-md border border-line dark:border-slate-700">
          <button
            type="button"
            onClick={() => setShowTech((v) => !v)}
            className="w-full px-3 py-2.5 text-left hover:bg-subtle/60 dark:hover:bg-slate-800/40 transition rounded-md"
            aria-expanded={showTech}
          >
            {/* Top line is a single flat row: chevron + label + counts. The
                module chips wrap on their OWN full-width line below — squeezing
                them between the label and counts collapsed them into a tall
                vertical column on phones. */}
            <div className="flex items-center gap-2">
              {showTech ? (
                <ChevronDown size={15} className="text-faint shrink-0" />
              ) : (
                <ChevronRight size={15} className="text-faint shrink-0" />
              )}
              <span className="text-[10px] font-mono uppercase tracking-widest text-accent shrink-0">
                requires
              </span>
              <div className="flex-1" />
              <span className="text-[10px] font-mono text-faint dark:text-slate-500 shrink-0">
                {showTech ? "hide details" : `${wires.length}w · ${fieldDefs.length}f`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1.5 pl-[23px]">
              {requires.length > 0 ? (
                requires.map((r) => (
                  <span
                    key={r.module}
                    className="font-mono text-[11px] px-2 py-0.5 rounded border border-line dark:border-slate-700 text-content dark:text-mortar-200 whitespace-nowrap"
                  >
                    {r.module}
                    {r.version ? `@${r.version}` : ""}
                  </span>
                ))
              ) : (
                <span className="text-xs text-faint dark:text-slate-500">no extra modules</span>
              )}
            </div>
          </button>

          {showTech && (
            <div className="border-t border-line dark:border-slate-700 p-3 space-y-4">
              {providesLens && (
                <div className="text-xs text-content dark:text-mortar-200">
                  Adds a{" "}
                  <strong>{providesLens.display_name ?? providesLens.name}</strong> view
                  under <code className="font-mono">{providesLens.entity_kind}</code>.
                </div>
              )}

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

              {effectiveManifest && (
                <details className="text-xs">
                  <summary className="font-mono uppercase tracking-widest text-[10px] text-faint cursor-pointer">
                    View raw manifest JSON
                  </summary>
                  <pre className="mt-2 p-2 rounded bg-subtle dark:bg-slate-800 font-mono text-[11px] overflow-x-auto text-content dark:text-mortar-200 max-h-64">
                    {JSON.stringify(effectiveManifest, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>

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
          ) : isUpdate ? (
            // Installed, but an older version — offer the update (supersedes).
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleInstall()}
                disabled={!effectiveManifest || install.isPending}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white transition flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Package size={13} />
                {install.isPending ? "Updating…" : `Update v${installedVersion} → v${version}`}
              </button>
              <button
                onClick={handleUninstall}
                disabled={uninstall.isPending}
                className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition"
              >
                {uninstall.isPending ? "removing…" : "remove"}
              </button>
            </div>
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
                !effectiveManifest || install.isPending || props.alreadyInstalled === true
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
              disabled={!effectiveManifest}
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
