// Click an installed bundle → this modal opens. Shows what's inside:
// the wires it added, the field defs it added, the original manifest,
// and an uninstall button (behind a destructive confirm). Read-only
// for the content itself — to edit a wire or field def from here,
// you'd uninstall the bundle and add them yourself.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { ApiError, api, type PlatformBundle } from "../lib/api";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";

interface Props {
  open: boolean;
  onClose: () => void;
  slug: string;
  bundle: PlatformBundle | null;
}

export function BundleDetailModal({ open, onClose, slug, bundle }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const detail = useQuery({
    queryKey: ["bundle-detail", slug, bundle?.id],
    queryFn: () => api.getBundle(slug, bundle!.id),
    enabled: open && !!bundle,
  });

  const uninstall = useMutation({
    mutationFn: () => api.uninstallBundle(slug, bundle!.id),
    onSuccess: () => {
      toast.success(`Uninstalled ${bundle?.name ?? "bundle"}.`);
      void qc.invalidateQueries({ queryKey: ["bundles", slug] });
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't uninstall.");
    },
  });

  async function handleUninstall() {
    if (!bundle) return;
    const ok = await confirm({
      title: `Uninstall ${bundle.name}?`,
      message: `This removes the bundle's wires and custom fields. Your data (parts, tasks, etc.) is untouched — only the bundle-installed customisations go.`,
      confirmLabel: "Uninstall",
      destructive: true,
    });
    if (ok) uninstall.mutate();
  }

  function downloadManifest() {
    const manifest = (detail.data?.bundle as { manifest?: unknown } | undefined)?.manifest;
    if (!manifest) return;
    const blob = new Blob([JSON.stringify({ manifest }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bundle?.external_id ?? "bundle"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.info("Manifest downloaded.");
  }

  if (!bundle) return null;

  const wires = detail.data?.wires ?? [];
  const fieldDefs = detail.data?.field_defs ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bundle.name}
      subtitle={`${bundle.external_id} · v${bundle.version}${bundle.author ? ` · by ${bundle.author}` : ""}`}
      size="lg"
    >
      <div className="space-y-5">
        {bundle.description && (
          <p className="text-sm text-slate-600 dark:text-mortar-200">
            {bundle.description}
          </p>
        )}

        <dl className="grid grid-cols-3 gap-2 text-xs">
          <Row label="Installed">{new Date(bundle.installed_at).toLocaleString()}</Row>
          <Row label="Wires installed">{wires.length}</Row>
          <Row label="Fields installed">{fieldDefs.length}</Row>
        </dl>

        {/* Wires from this bundle */}
        <Section title={`wires (${wires.length})`}>
          {wires.length === 0 ? (
            <EmptyHint>This bundle didn't install any wires.</EmptyHint>
          ) : (
            <ul className="space-y-1.5">
              {wires.map((w) => (
                <li
                  key={w.id}
                  className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 text-xs"
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <code className="font-mono text-cobble-600 dark:text-cobble-300">
                      {w.source_kind}
                    </code>
                    <span className="text-slate-400">→</span>
                    <code className="font-mono text-cobble-600 dark:text-cobble-300">
                      {w.action_id}
                    </code>
                    <span className="text-[10px] font-mono text-slate-400">
                      ({w.trigger_type}
                      {w.trigger_event ? ` on ${w.trigger_event}` : ""})
                    </span>
                  </div>
                  {w.template && (
                    <div className="mt-1.5 font-mono text-[11px] text-slate-600 dark:text-mortar-200 bg-mortar-50 dark:bg-slate-800/70 rounded px-2 py-1 break-all">
                      {w.template}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Field defs from this bundle */}
        <Section title={`custom fields (${fieldDefs.length})`}>
          {fieldDefs.length === 0 ? (
            <EmptyHint>This bundle didn't install any custom fields.</EmptyHint>
          ) : (
            <ul className="space-y-1">
              {fieldDefs.map((f) => (
                <li
                  key={f.id}
                  className="flex items-baseline gap-3 text-sm text-slate-700 dark:text-mortar-100 py-1 border-b border-slate-100 dark:border-slate-700 last:border-0"
                >
                  <code className="font-mono text-xs text-cobble-600 dark:text-cobble-300 w-32 truncate">
                    {f.entity_kind}
                  </code>
                  <code className="font-mono text-xs text-slate-400 w-32 truncate">
                    {f.name}
                  </code>
                  <span className="flex-1">{f.display_label}</span>
                  <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
                    {f.type}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Raw manifest collapsible */}
        <details className="text-xs">
          <summary className="font-mono uppercase tracking-widest text-[10px] text-slate-400 cursor-pointer">
            View raw manifest JSON
          </summary>
          {detail.data && (
            <pre className="mt-2 p-2 rounded bg-mortar-50 dark:bg-slate-800 font-mono text-[11px] overflow-x-auto text-slate-600 dark:text-mortar-200 max-h-64">
              {JSON.stringify((detail.data.bundle as { manifest: unknown }).manifest, null, 2)}
            </pre>
          )}
        </details>

        {/* Footer actions */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-700">
          <button
            onClick={handleUninstall}
            disabled={uninstall.isPending}
            className="text-[10px] font-mono uppercase tracking-widest text-slate-400 hover:text-ember-500 transition flex items-center gap-1"
          >
            <Trash2 size={11} /> uninstall bundle
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={downloadManifest}
              disabled={!detail.data}
              className="text-[10px] font-mono uppercase tracking-widest text-slate-500 hover:text-cobble-600 transition flex items-center gap-1"
              title="Download the manifest JSON"
            >
              <Download size={11} /> download
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 transition"
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
      <dt className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-0.5">
        {label}
      </dt>
      <dd className="text-slate-700 dark:text-mortar-100">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
        // {title}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-slate-400 italic">{children}</div>;
}
