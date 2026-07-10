// Click a field def → this modal opens. Shows full context (kind,
// type, position, origin) and lets the user delete it via a confirm.
// Editing the def's name / type is not supported yet — would
// require migrating any stored values in entity metadata.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { ApiError, api, type PlatformFieldDef } from "../lib/api";
import { Modal, useToast, useConfirm } from "@cobblr/platform-web";

interface Props {
  open: boolean;
  onClose: () => void;
  slug: string;
  fieldDef: PlatformFieldDef | null;
}

export function FieldDefDetailModal({ open, onClose, slug, fieldDef }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const remove = useMutation({
    mutationFn: () => api.deleteFieldDef(slug, fieldDef!.id),
    onSuccess: () => {
      toast.success(`Field "${fieldDef!.name}" deleted.`);
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      onClose();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof ApiError ? e.message : "Couldn't delete field.");
    },
  });

  async function handleDelete() {
    if (!fieldDef) return;
    const ok = await confirm({
      title: `Delete field "${fieldDef.name}"?`,
      message: `The field definition will be removed. Existing entity metadata values stored under "${fieldDef.name}" remain on each row but won't render anywhere until you re-add the field.`,
      confirmLabel: "Delete field",
      destructive: true,
    });
    if (ok) remove.mutate();
  }

  if (!fieldDef) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={fieldDef.display_label}
      subtitle={`${fieldDef.entity_kind} · ${fieldDef.name}`}
      size="md"
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <Row label="Entity kind">
            <code className="font-mono text-accent dark:text-cobble-300">
              {fieldDef.entity_kind}
            </code>
          </Row>
          <Row label="Field name">
            <code className="font-mono text-accent dark:text-cobble-300">
              {fieldDef.name}
            </code>
          </Row>
          <Row label="Type">
            <span className="font-mono uppercase tracking-widest text-[10px] text-muted">
              {fieldDef.type}
            </span>
          </Row>
          <Row label="Required">{fieldDef.required ? "yes" : "no"}</Row>
          <Row label="Position">{fieldDef.position}</Row>
          <Row label="Origin">
            {fieldDef.bundle_id ? (
              <span className="text-accent dark:text-cobble-300">bundled</span>
            ) : (
              <span className="text-muted">user-authored</span>
            )}
          </Row>
          {fieldDef.renderer && (
            <Row label="Renderer">
              <span className="font-mono uppercase tracking-widest text-[10px] text-accent dark:text-cobble-300">
                {fieldDef.renderer}
              </span>
            </Row>
          )}
          {fieldDef.unit && (
            <Row label="Unit">
              <span className="font-mono text-accent dark:text-cobble-300">{fieldDef.unit}</span>
            </Row>
          )}
        </dl>

        <div className="p-3 rounded-md bg-subtle dark:bg-slate-800/70 text-xs text-content dark:text-mortar-200">
          <div className="font-mono uppercase tracking-widest text-[10px] text-faint mb-1">
            Where it appears
          </div>
          Renders on every <code className="font-mono text-accent">{fieldDef.entity_kind}</code>{" "}
          detail page under a <em>custom fields</em> section, and the value is
          accessible in templates as <code className="font-mono text-accent">{`{{${fieldDef.name}}}`}</code>.
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-line dark:border-slate-700">
          {fieldDef.bundle_id ? (
            <Link
              to={fieldDef.bundle_external_id ? `/bundles?open=${encodeURIComponent(fieldDef.bundle_external_id)}` : "/bundles"}
              onClick={onClose}
              className="text-[10px] font-mono uppercase tracking-widest text-accent hover:underline"
            >
              part of {fieldDef.bundle_name ?? "a bundle"} — manage the bundle →
            </Link>
          ) : (
            <button
              onClick={handleDelete}
              disabled={remove.isPending}
              className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition flex items-center gap-1"
            >
              <Trash2 size={11} /> delete field
            </button>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Close
          </button>
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
