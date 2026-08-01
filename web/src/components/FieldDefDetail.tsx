// Click a field def → this panel expands IN PLACE under the row. Shows full
// context (kind, type, position, origin), edits choices, and deletes via a
// confirm. Editing the def's name / type is not supported yet — would require
// migrating any stored values in entity metadata.
//
// A DRAWER, NOT A MODAL, on purpose. A modal is right for one decision you
// finish and dismiss; this is a list you browse, opening several fields in a
// row to compare or tidy them. An overlay blanked the list behind it and threw
// away your scroll position on every open/close (the author, 2026-07-18). See
// docs/architecture/ui-conventions.md — "overlay or in place".

import { useEffect, useState } from "react";
import { useBundleDetail } from "./useBundleDetail";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Trash2, X } from "lucide-react";
import { ApiError, api, type PlatformFieldDef } from "../lib/api";
import { useToast, useConfirm } from "@cobblr/platform-web";
import { ChoicesInput } from "./ChoicesInput";

interface Props {
  onClose: () => void;
  slug: string;
  fieldDef: PlatformFieldDef | null;
  /** Human name of the SCOPE this def is attached to ("All physical items"),
   *  when it's scoped to a class of kinds rather than one kind. The caller
   *  resolves it — the scope vocabulary is served by the API. */
  scopeLabel?: string | null;
}

export function FieldDefDetail({ onClose, slug, fieldDef, scopeLabel }: Props) {
  const navigate = useNavigate();
  const bundleDetail = useBundleDetail(slug);
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  // Choices are editable AFTER the fact: they're suggestions stored as free text,
  // so adding or removing one can never orphan a saved value. (Renaming the field
  // or changing its type still isn't offered — those WOULD strand metadata.)
  const [choices, setChoices] = useState<string[]>(fieldDef?.choices ?? []);
  useEffect(() => {
    setChoices(fieldDef?.choices ?? []);
  }, [fieldDef?.id, fieldDef?.choices]);
  const choicesDirty =
    JSON.stringify(choices) !== JSON.stringify(fieldDef?.choices ?? []);

  const saveChoices = useMutation({
    mutationFn: () =>
      api.updateFieldDef(slug, fieldDef!.id, {
        // null clears the dropdown back to a plain text box.
        choices: choices.length ? choices : null,
      }),
    onSuccess: () => {
      toast.success(
        choices.length ? "Choices updated." : "Dropdown removed — it's a plain text box now.",
      );
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : "Couldn't save choices."),
  });

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
    <div
      data-testid="field-detail"
      className="mt-1 mb-2 rounded-lg border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/30 p-3"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">
            {fieldDef.display_label}
          </div>
          <div className="text-[11px] font-mono text-faint dark:text-slate-500 truncate">
            {scopeLabel ?? fieldDef.entity_kind} · {fieldDef.name}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Collapse field details"
          className="shrink-0 p-1 rounded text-faint hover:text-content dark:hover:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition"
        >
          <X size={14} />
        </button>
      </div>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <Row label={scopeLabel ? "Applies to" : "Entity kind"}>
            <code className="font-mono text-accent dark:text-cobble-300">
              {scopeLabel ?? fieldDef.entity_kind}
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

        {fieldDef.type === "text" && (
          <div>
            <div className="font-mono uppercase tracking-widest text-[10px] text-faint mb-1">
              Choices
              <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                {choices.length ? "renders as a dropdown" : "empty = a plain text box"}
              </span>
            </div>
            <ChoicesInput
              value={choices}
              onChange={setChoices}
              placeholder="e.g. FB Marketplace, Gift, Bought new"
            />
            {choicesDirty && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => saveChoices.mutate()}
                  disabled={saveChoices.isPending}
                  className="rounded-md bg-cobble-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-cobble-500 transition disabled:opacity-50"
                >
                  {saveChoices.isPending ? "Saving…" : "Save choices"}
                </button>
                <button
                  type="button"
                  onClick={() => setChoices(fieldDef.choices ?? [])}
                  className="text-[11px] text-muted hover:text-content dark:hover:text-mortar-100 transition"
                >
                  Revert
                </button>
                {/* Changing the list can't strand a saved value: it's stored as
                    free text, and an unlisted value still renders (as "legacy"). */}
                <span className="text-[10px] text-faint">
                  Safe to change - values already saved are kept either way.
                </span>
              </div>
            )}
          </div>
        )}

        <div className="p-3 rounded-md bg-subtle dark:bg-slate-800/70 text-xs text-content dark:text-mortar-200">
          <div className="font-mono uppercase tracking-widest text-[10px] text-faint mb-1">
            Where it appears
          </div>
          {scopeLabel ? (
            <>
              Renders on <strong>{scopeLabel.toLowerCase()}</strong>  - every kind that
              qualifies today, and any you add later. Editing or deleting it here
              changes it <em>everywhere</em> it appears. To change it on just one
              kind, add a field with the same name{" "}
              <code className="font-mono text-accent">{fieldDef.name}</code> to that
              kind; the more specific one wins.
            </>
          ) : (
            <>
              Renders on every <code className="font-mono text-accent">{fieldDef.entity_kind}</code>{" "}
              detail page under a <em>custom fields</em> section, and the value is
              accessible in templates as{" "}
              <code className="font-mono text-accent">{`{{${fieldDef.name}}}`}</code>.
            </>
          )}
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-line dark:border-slate-700">
          {fieldDef.bundle_id ? (
            <button
              type="button"
              onClick={() => {
                // Opens ON TOP of this modal (it portals to body) instead of
                // navigating to the bundles page - house rule: a modal shows up
                // on the page it was invoked from, and leaving would throw away
                // whatever the user was doing there.
                if (fieldDef.bundle_external_id) bundleDetail.open(fieldDef.bundle_external_id);
                else navigate("/bundles");
              }}
              className="text-[10px] font-mono uppercase tracking-widest text-accent hover:underline"
            >
              part of {fieldDef.bundle_name ?? "a bundle"}  - manage the bundle →
            </button>
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
            Collapse
          </button>
        </div>
      </div>
      {bundleDetail.element}
    </div>
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
