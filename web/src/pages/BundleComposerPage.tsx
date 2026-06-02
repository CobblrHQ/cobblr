// /bundles/compose — no-raw-JSON bundle authoring (BACKLOG D11).
//
// The bundles page already has a "publish mine" export modal that
// pulls everything the workspace has authored. The composer extends
// that one axis: per-item checkboxes so the user picks exactly
// which wires + field defs (and optional `requires` modules) make
// it into the bundle. JSON is still the export format — but it's
// generated for the user, not written by them.
//
// Output: a manifest the user can download, copy to clipboard, or
// install directly into another workspace via the existing
// /bundles paste flow.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  Copy,
  Download,
  Package,
  Plus,
  Square,
  SquareCheck,
} from "lucide-react";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import {
  ApiError,
  api,
  type PlatformBundleManifest,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

interface ManifestWire {
  source_kind: string;
  action_id: string;
  trigger_type?: string;
  trigger_event?: string;
  template?: string;
  filter?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

interface ManifestFieldDef {
  entity_kind: string;
  name: string;
  display_label?: string;
  type: string;
  required?: boolean;
  position?: number;
  choices?: string[] | null;
}

// Tiny lookup-key helpers for the checkbox state. Wires don't have
// a stable id on the manifest shape, so we synthesise one from the
// source_kind + action_id + trigger_event.
function wireKey(w: ManifestWire): string {
  return `${w.source_kind}|${w.action_id}|${w.trigger_type ?? ""}|${w.trigger_event ?? ""}`;
}
function fieldKey(f: ManifestFieldDef): string {
  return `${f.entity_kind}|${f.name}`;
}

export function BundleComposerPage() {
  usePageTitle("Compose bundle");
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [src, setSrc] = useState<PlatformBundleManifest | null>(null);

  // Selection state — by default everything is checked, the user
  // un-checks to narrow.
  const [selectedWires, setSelectedWires] = useState<Set<string>>(new Set());
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());

  // Metadata.
  const [meta, setMeta] = useState({
    id: "",
    name: "",
    version: "0.1.0",
    description: "",
    author: "",
    readme_md: "",
  });

  // Track which modules the selected items depend on; auto-add to
  // `requires` so the install side knows to pre-flight those.
  const requires = useMemo(() => {
    if (!src) return [];
    const mods = new Set<string>();
    const selectedFieldList =
      src.field_defs?.filter((f) => selectedFields.has(fieldKey(f))) ?? [];
    const selectedWireList =
      src.wires?.filter((w) => selectedWires.has(wireKey(w))) ?? [];
    for (const f of selectedFieldList) {
      const [mod] = f.entity_kind.split(":");
      if (mod) mods.add(mod);
    }
    for (const w of selectedWireList) {
      const [mod] = w.source_kind.split(":");
      if (mod) mods.add(mod);
      const [actMod] = w.action_id.split(":");
      if (actMod) mods.add(actMod);
    }
    // Filter out the platform-side kinds that aren't proper modules.
    return [...mods]
      .filter((m) => !["core", "platform"].includes(m))
      .map((module) => ({ module }));
  }, [src, selectedWires, selectedFields]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.exportBundle(activeSlug);
        if (cancelled) return;
        setSrc(res.manifest);
        // Default: everything pre-selected.
        setSelectedWires(new Set((res.manifest.wires ?? []).map(wireKey)));
        setSelectedFields(new Set((res.manifest.field_defs ?? []).map(fieldKey)));
        setMeta({
          id: res.manifest.id || "my-workspace-bundle",
          name: res.manifest.name || "My workspace bundle",
          version: res.manifest.version || "0.1.0",
          description: res.manifest.description || "",
          author: res.manifest.author || "",
          readme_md: res.manifest.readme_md || "",
        });
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof ApiError ? e.message : (e as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSlug]);

  // Build the final manifest from the selections + metadata.
  const finalManifest: PlatformBundleManifest | null = useMemo(() => {
    if (!src) return null;
    const wires = (src.wires ?? []).filter((w) => selectedWires.has(wireKey(w)));
    const field_defs = (src.field_defs ?? []).filter((f) =>
      selectedFields.has(fieldKey(f)),
    );
    return {
      ...meta,
      requires,
      wires,
      field_defs,
    };
  }, [src, selectedWires, selectedFields, meta, requires]);

  const json = finalManifest ? JSON.stringify({ manifest: finalManifest }, null, 2) : "";

  function download() {
    if (!finalManifest) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${finalManifest.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Bundle JSON downloaded.");
  }

  function copy() {
    if (!json) return;
    void navigator.clipboard.writeText(json);
    toast.success("Bundle JSON copied.");
  }

  const install = useMutation({
    mutationFn: () => {
      if (!finalManifest) throw new ApiError(400, "no_manifest", "Nothing to install");
      return api.installBundle(activeSlug, finalManifest);
    },
    onSuccess: () => toast.success("Bundle installed in this workspace."),
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : (e as Error).message),
  });

  function toggleWire(k: string, on: boolean) {
    setSelectedWires((prev) => {
      const n = new Set(prev);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  }
  function toggleField(k: string, on: boolean) {
    setSelectedFields((prev) => {
      const n = new Set(prev);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  }
  function selectAllWires(on: boolean) {
    if (!src) return;
    setSelectedWires(on ? new Set((src.wires ?? []).map(wireKey)) : new Set());
  }
  function selectAllFields(on: boolean) {
    if (!src) return;
    setSelectedFields(on ? new Set((src.field_defs ?? []).map(fieldKey)) : new Set());
  }

  if (loading) {
    return (
      <div className="space-y-3 max-w-4xl">
        <h1 className="font-display text-2xl font-extrabold lowercase text-content dark:text-mortar-100">
          compose bundle
        </h1>
        <div className="text-sm text-faint">loading workspace…</div>
      </div>
    );
  }
  if (err) {
    return <div className="text-sm text-ember-500">{err}</div>;
  }
  if (!src) return null;

  const wires = src.wires ?? [];
  const fieldDefs = src.field_defs ?? [];
  const empty = wires.length === 0 && fieldDefs.length === 0;

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <Link
          to="/bundles"
          className="text-sm text-muted hover:text-accent inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> bundles
        </Link>
        <h1 className="font-display text-2xl font-extrabold lowercase text-content dark:text-mortar-100 flex items-center gap-2">
          <Package size={20} className="text-accent" />
          compose bundle
        </h1>
      </div>
      <p className="text-sm text-muted dark:text-slate-400">
        Pick the wires and field defs you want to ship together. The
        metadata becomes the bundle's identity (id / version / readme).
        On the right you can preview the JSON or skip JSON entirely and
        install straight into this workspace as a named bundle.
      </p>

      {empty && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <Package size={28} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">
            No user-authored wires or field defs in this workspace yet.
            Create some via{" "}
            <Link to="/bindings" className="text-accent hover:text-accent underline">
              wires
            </Link>{" "}
            and{" "}
            <Link to="/fields" className="text-accent hover:text-accent underline">
              custom fields
            </Link>{" "}
            first.
          </div>
        </div>
      )}

      {!empty && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-4">
            <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
              <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-3">
                // metadata
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="ID (kebab-case)">
                  <input
                    type="text"
                    value={meta.id}
                    onChange={(e) =>
                      setMeta((m) => ({
                        ...m,
                        id: e.target.value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-"),
                      }))
                    }
                    className="input font-mono text-xs"
                  />
                </Field>
                <Field label="Version (semver)">
                  <input
                    type="text"
                    value={meta.version}
                    onChange={(e) => setMeta((m) => ({ ...m, version: e.target.value }))}
                    className="input font-mono text-xs"
                  />
                </Field>
                <Field label="Name" className="col-span-2">
                  <input
                    type="text"
                    value={meta.name}
                    onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))}
                    className="input"
                  />
                </Field>
                <Field label="Description" className="col-span-2">
                  <textarea
                    value={meta.description}
                    onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
                    rows={2}
                    className="input"
                  />
                </Field>
                <Field label="Author" className="col-span-2">
                  <input
                    type="text"
                    value={meta.author}
                    onChange={(e) => setMeta((m) => ({ ...m, author: e.target.value }))}
                    placeholder="e.g. Sarah's LUG, jane@example.com"
                    className="input"
                  />
                </Field>
                <Field label="Walkthrough (markdown, optional)" className="col-span-2">
                  <textarea
                    value={meta.readme_md}
                    onChange={(e) => setMeta((m) => ({ ...m, readme_md: e.target.value }))}
                    rows={4}
                    className="input font-mono text-xs"
                    placeholder="## What this bundle does..."
                  />
                </Field>
              </div>
              {requires.length > 0 && (
                <div className="mt-3 text-[11px] font-mono text-muted">
                  // auto-requires:{" "}
                  {requires.map((r, i) => (
                    <span key={r.module}>
                      {i > 0 && ", "}
                      {r.module}
                    </span>
                  ))}
                </div>
              )}
            </section>

            <Section
              title={`wires (${selectedWires.size}/${wires.length})`}
              onAll={(on) => selectAllWires(on)}
              hasAny={wires.length > 0}
            >
              <ul className="space-y-1.5">
                {wires.map((w) => {
                  const k = wireKey(w);
                  const on = selectedWires.has(k);
                  return (
                    <li
                      key={k}
                      className="rounded border border-line dark:border-slate-700 p-2 text-xs flex items-start gap-2"
                    >
                      <button
                        type="button"
                        onClick={() => toggleWire(k, !on)}
                        className="mt-0.5"
                        aria-label={on ? "Exclude" : "Include"}
                      >
                        {on ? (
                          <SquareCheck size={16} className="text-accent" />
                        ) : (
                          <Square size={16} className="text-faint" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <code className="font-mono text-accent dark:text-cobble-300">
                            {w.source_kind}
                          </code>
                          <span className="text-faint">→</span>
                          <code className="font-mono text-accent dark:text-cobble-300">
                            {w.action_id}
                          </code>
                          <span className="text-[10px] font-mono text-faint">
                            ({w.trigger_type ?? "user-invoked"}
                            {w.trigger_event ? ` on ${w.trigger_event}` : ""})
                          </span>
                        </div>
                        {w.template && (
                          <div className="mt-1 font-mono text-[11px] text-muted dark:text-mortar-200 bg-subtle dark:bg-slate-800/70 rounded px-2 py-1 break-all">
                            {w.template}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Section>

            <Section
              title={`field defs (${selectedFields.size}/${fieldDefs.length})`}
              onAll={(on) => selectAllFields(on)}
              hasAny={fieldDefs.length > 0}
            >
              <ul className="space-y-1">
                {fieldDefs.map((f) => {
                  const k = fieldKey(f);
                  const on = selectedFields.has(k);
                  return (
                    <li
                      key={k}
                      className="flex items-center gap-2 text-sm border-b border-line dark:border-slate-700 last:border-0 py-1"
                    >
                      <button
                        type="button"
                        onClick={() => toggleField(k, !on)}
                        aria-label={on ? "Exclude" : "Include"}
                      >
                        {on ? (
                          <SquareCheck size={16} className="text-accent" />
                        ) : (
                          <Square size={16} className="text-faint" />
                        )}
                      </button>
                      <code className="font-mono text-xs text-accent dark:text-cobble-300 w-40 truncate">
                        {f.entity_kind}
                      </code>
                      <code className="font-mono text-xs text-faint w-32 truncate">
                        {f.name}
                      </code>
                      <span className="flex-1 text-content dark:text-mortar-200 truncate">
                        {f.display_label ?? f.name}
                      </span>
                      <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
                        {f.type}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          </div>

          <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
            <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
                  // preview
                </div>
                <div className="text-[10px] font-mono text-faint">
                  {selectedWires.size} wires · {selectedFields.size} fields
                </div>
              </div>
              <pre className="max-h-96 overflow-auto text-[10px] font-mono p-3 rounded bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 text-content dark:text-mortar-200">
                {json}
              </pre>
            </section>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center justify-center gap-1 px-3 py-2 text-sm rounded border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800"
              >
                <Copy size={14} /> Copy
              </button>
              <button
                type="button"
                onClick={download}
                className="inline-flex items-center justify-center gap-1 px-3 py-2 text-sm rounded border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800"
              >
                <Download size={14} /> Download
              </button>
              <button
                type="button"
                onClick={() => install.mutate()}
                disabled={
                  install.isPending ||
                  !finalManifest ||
                  selectedWires.size + selectedFields.size === 0
                }
                className="inline-flex items-center justify-center gap-1 px-3 py-2 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50"
              >
                <Plus size={14} />
                {install.isPending ? "Installing…" : "Install"}
              </button>
            </div>
            <p className="text-[11px] text-muted dark:text-slate-400">
              Install creates a bundle row in this workspace bound to the
              picked items. Download or copy if you want to share the
              manifest with another workspace.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  onAll,
  hasAny,
  children,
}: {
  title: string;
  onAll: (on: boolean) => void;
  hasAny: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // {title}
        </div>
        {hasAny && (
          <div className="text-[10px] font-mono">
            <button
              type="button"
              onClick={() => onAll(true)}
              className="text-accent hover:text-accent mr-2"
            >
              all
            </button>
            <button
              type="button"
              onClick={() => onAll(false)}
              className="text-muted hover:text-content"
            >
              none
            </button>
          </div>
        )}
      </div>
      {children}
    </section>
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
