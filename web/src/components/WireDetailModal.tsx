// Click a wire row → this modal opens. Shows full binding context
// (source kind, action, trigger, template, filter, args, bundle
// origin, timestamps) and lets you edit the template + enable flag.
// Destructive delete moved here too, behind a confirm modal.

import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { ApiError, api, type PlatformBinding } from "../lib/api";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";

interface Props {
  open: boolean;
  onClose: () => void;
  slug: string;
  binding: PlatformBinding | null;
}

export function WireDetailModal({ open, onClose, slug, binding }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [template, setTemplate] = useState("");
  const [enabled, setEnabled] = useState(true);

  // Seed local state when the modal opens / target changes.
  useEffect(() => {
    if (binding) {
      setTemplate(binding.template ?? "");
      setEnabled(binding.enabled);
    }
  }, [binding?.id, binding?.template, binding?.enabled]);

  // Pull recent firings for this specific wire.
  const recent = useQuery({
    queryKey: ["wire-firings", slug, binding?.id],
    queryFn: () => api.listActivity(slug, { actions: ["wire_fired", "wire_failed"], limit: 50 }),
    enabled: open && !!binding,
  });
  // Filter to the rows where diff.action matches this binding.
  const matching =
    recent.data?.items.filter((r) => {
      const d = (r.diff ?? {}) as { action?: string };
      return d.action === binding?.action_id;
    }) ?? [];

  const save = useMutation({
    mutationFn: () =>
      api.updateBinding(slug, binding!.id, {
        template: template.trim() ? template : null,
        enabled,
      }),
    onSuccess: () => {
      toast.success("Wire saved.");
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save wire.");
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteBinding(slug, binding!.id),
    onSuccess: () => {
      toast.success("Wire deleted.");
      void qc.invalidateQueries({ queryKey: ["bindings", slug] });
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't delete wire.");
    },
  });

  async function handleDelete() {
    if (!binding) return;
    const ok = await confirm({
      title: "Delete this wire?",
      message: `${binding.source_kind} → ${binding.action_id}\n\nThis can't be undone. The action handler and source module aren't affected.`,
      confirmLabel: "Delete wire",
      destructive: true,
    });
    if (ok) remove.mutate();
  }

  if (!binding) return null;

  const dirty =
    (template.trim() || null) !== (binding.template ?? null) ||
    enabled !== binding.enabled;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="wire detail"
      subtitle={`${binding.source_kind} → ${binding.action_id}`}
      size="lg"
    >
      <div className="space-y-5">
        {/* Origin / trigger / timestamps in a definition list */}
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <Row label="Source kind">
            <code className="font-mono text-cobble-600 dark:text-cobble-300">
              {binding.source_kind}
            </code>
          </Row>
          <Row label="Action">
            <code className="font-mono text-cobble-600 dark:text-cobble-300">
              {binding.action_id}
            </code>
          </Row>
          <Row label="Trigger">
            <span>
              {binding.trigger_type}
              {binding.trigger_event ? ` · ${binding.trigger_event}` : ""}
            </span>
          </Row>
          <Row label="Created">
            {new Date(binding.created_at).toLocaleString()}
          </Row>
          <Row label="Updated">
            {new Date(binding.updated_at).toLocaleString()}
          </Row>
          <Row label="Origin">
            {binding.bundle_id ? (
              <Link
                to="/bundles"
                onClick={onClose}
                className="text-cobble-600 hover:text-cobble-500 inline-flex items-center gap-1"
              >
                bundle <ExternalLink size={11} />
              </Link>
            ) : (
              <span className="text-slate-500">user-authored</span>
            )}
          </Row>
        </dl>

        {/* Editable fields */}
        <div className="space-y-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Template
            </span>
            <input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="optional — uses entity defaults if blank"
              className="input font-mono text-xs"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-cobble-500"
            />
            <span className="font-mono uppercase tracking-widest text-slate-500 dark:text-slate-400">
              Enabled
            </span>
          </label>
          {(!!binding.filter || !!binding.args) && (
            <details className="text-xs">
              <summary className="font-mono uppercase tracking-widest text-[10px] text-slate-400 dark:text-slate-500 cursor-pointer">
                Advanced (filter / args)
              </summary>
              <pre className="mt-2 p-2 rounded bg-mortar-50 dark:bg-slate-800 font-mono text-[11px] overflow-x-auto text-slate-600 dark:text-mortar-200">
                {JSON.stringify({ filter: binding.filter, args: binding.args }, null, 2)}
              </pre>
            </details>
          )}
        </div>

        {/* Recent firings for this wire */}
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-2">
            // recent firings for this wire ({matching.length})
          </div>
          {matching.length === 0 ? (
            <div className="text-xs text-slate-400 italic">
              No firings recorded yet for this binding.
            </div>
          ) : (
            <ul className="space-y-1">
              {matching.slice(0, 8).map((r) => {
                const failed = r.action === "wire_failed";
                const d = (r.diff ?? {}) as { error?: string; event?: string };
                return (
                  <li
                    key={r.id}
                    className={
                      "rounded-md border p-2 text-[11px] " +
                      (failed
                        ? "border-ember-200 bg-ember-50/60 dark:bg-slate-900 dark:border-ember-700/40"
                        : "border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700")
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          "font-mono text-[10px] uppercase " +
                          (failed ? "text-ember-500" : "text-moss-600")
                        }
                      >
                        {failed ? "failed" : "fired"}
                      </span>
                      <span className="font-mono text-[10px] text-slate-400">
                        {new Date(r.occurred_at).toLocaleString()}
                      </span>
                      {d.event && (
                        <span className="font-mono text-[10px] text-cobble-600">
                          {d.event}
                        </span>
                      )}
                    </div>
                    {d.error && (
                      <div className="font-mono text-[10px] text-ember-600 dark:text-ember-300 mt-1 break-all">
                        {d.error}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-700">
          <button
            onClick={handleDelete}
            disabled={remove.isPending}
            className="text-[10px] font-mono uppercase tracking-widest text-slate-400 hover:text-ember-500 transition flex items-center gap-1"
          >
            <Trash2 size={11} /> delete wire
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 transition"
            >
              Close
            </button>
            <button
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-700 hover:bg-slate-600 text-mortar-50 transition disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save"}
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
