// /configuration/templates — entity-template editor.
//
// Each template binds to a target entity kind (inventory:part,
// machines:machine, assets:asset, ...). Defaults are a free-form
// JSON object — they pass through to the target's create endpoint
// at instantiation time. default_tags are applied to the new entity
// via core-tags' polymorphic attachments.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  
  CopyPlus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Modal, useConfirm, useToast, usePageTitle } from "@cobblr/platform-web";
import {
  ApiError,
  api,
  type EntityTemplate,
} from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ConfigHeaderActions } from "../components/ConfigPageHeader";

// Kinds the templates module can instantiate. Mirrors the server-side
// KIND_CREATE_ENDPOINTS map in modules/core-templates/src/api/templates.ts.
const SUPPORTED_KINDS = [
  { id: "inventory:part", label: "Inventory part" },
  { id: "machines:machine", label: "Machine" },
  { id: "assets:asset", label: "Asset" },
  { id: "projects:project", label: "Project" },
  { id: "projects:task", label: "Task" },
  { id: "purchases:order", label: "Purchase order" },
  { id: "core-locations:location", label: "Location" },
];

export function TemplatesPage() {
  usePageTitle("Templates");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<EntityTemplate | null>(null);
  const [adding, setAdding] = useState(false);

  const list = useQuery({
    queryKey: ["templates", activeSlug],
    queryFn: () => api.listTemplates(activeSlug),
    enabled: !!activeSlug,
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteTemplate(activeSlug, id),
    onSuccess: () => {
      toast.success("Template deleted.");
      void qc.invalidateQueries({ queryKey: ["templates", activeSlug] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const items = list.data?.items ?? [];

  // Group by target_kind for a tidier display.
  const grouped = SUPPORTED_KINDS.map((k) => ({
    kind: k,
    items: items.filter((t) => t.target_kind === k.id),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-5">
      <ConfigHeaderActions>
        <span className="text-sm text-muted dark:text-slate-400">
          {items.length} template{items.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> New template
        </button>
      </ConfigHeaderActions>

      <p className="text-sm text-muted dark:text-slate-400">
        Save a set of default field values + tags against an entity
        kind. When you "create from template," those defaults get
        merged into the new entity's body before it's POSTed to the
        kind's create endpoint. Use cases: household-appliance defaults
        (insured=true, lifetime_warranty=false), "new Voron printer"
        starting state (family=Voron, state=building), "Lego set
        acquired" (tags=[lego, new-arrival]).
      </p>

      {list.isLoading && (
        <div className="text-sm text-muted">Loading…</div>
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <CopyPlus size={28} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">
            No templates yet. Click "New template" to define one.
          </div>
        </div>
      )}

      {grouped.map(({ kind, items }) => (
        <section key={kind.id}>
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-2">
            // {kind.label} ({items.length})
          </div>
          <ul className="space-y-2">
            {items.map((t) => (
              <li
                key={t.id}
                className="border border-line dark:border-slate-700 rounded-md bg-surface dark:bg-slate-900 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-content dark:text-mortar-100">
                      {t.name}
                    </div>
                    {t.description && (
                      <div className="text-sm text-muted mt-0.5">
                        {t.description}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {Object.keys(t.defaults).map((k) => (
                        <span
                          key={k}
                          className="text-[10px] font-mono bg-mortar-100 dark:bg-slate-800 text-muted dark:text-mortar-200 rounded px-1.5 py-0.5"
                        >
                          {k} = {fmtValue(t.defaults[k])}
                        </span>
                      ))}
                      {t.default_tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] font-mono rounded px-1.5 py-0.5 border border-cobble-200 dark:border-cobble-800 text-accent"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => setEditing(t)}
                      title="Edit"
                      className="text-faint hover:text-accent p-1"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete template?",
                          message: `${t.name} — entities already created from it stay; only the template definition is removed.`,
                          confirmLabel: "Delete",
                          destructive: true,
                        });
                        if (ok) del.mutate(t.id);
                      }}
                      title="Delete"
                      className="text-faint hover:text-ember-500 p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {(adding || editing) && (
        <TemplateFormModal
          template={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function fmtValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  if (typeof v === "string") return v.length > 24 ? `${v.slice(0, 22)}…` : v;
  if (typeof v === "object") return JSON.stringify(v).slice(0, 24) + "…";
  return String(v);
}

function TemplateFormModal({
  template,
  onClose,
}: {
  template: EntityTemplate | null;
  onClose: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [targetKind, setTargetKind] = useState<string>(
    template?.target_kind ?? SUPPORTED_KINDS[0]!.id,
  );
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [defaultsText, setDefaultsText] = useState(
    JSON.stringify(template?.defaults ?? {}, null, 2),
  );
  const [defaultsErr, setDefaultsErr] = useState<string | null>(null);
  const [tagsText, setTagsText] = useState(
    (template?.default_tags ?? []).join(", "),
  );

  const save = useMutation({
    mutationFn: () => {
      let defaults: Record<string, unknown>;
      try {
        defaults = JSON.parse(defaultsText || "{}");
      } catch {
        throw new ApiError(400, "invalid_json", "Defaults isn't valid JSON.");
      }
      const default_tags = tagsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const body = {
        target_kind: targetKind,
        name: name.trim(),
        description: description.trim() || null,
        defaults,
        default_tags,
      };
      return template
        ? api.updateTemplate(activeSlug, template.id, body)
        : api.createTemplate(activeSlug, body);
    },
    onSuccess: () => {
      toast.success(template ? "Template updated." : "Template created.");
      void qc.invalidateQueries({ queryKey: ["templates", activeSlug] });
      onClose();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // Validate defaults JSON as the user types so the save button
  // disables on invalid input.
  function onDefaultsChange(v: string) {
    setDefaultsText(v);
    if (!v.trim()) {
      setDefaultsErr(null);
      return;
    }
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setDefaultsErr("Must be a JSON object (e.g. {})");
      } else {
        setDefaultsErr(null);
      }
    } catch (e) {
      setDefaultsErr((e as Error).message);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={template ? `Edit "${template.name}"` : "New template"}
      size="md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (defaultsErr) return;
          save.mutate();
        }}
        className="space-y-3"
      >
        <label className="block">
          <div className="text-xs text-muted mb-1">Target kind</div>
          <select
            value={targetKind}
            onChange={(e) => setTargetKind(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            {SUPPORTED_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} ({k.id})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Name</div>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Household appliance"
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">Description (optional)</div>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this template for?"
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">
            Default field values (JSON object)
          </div>
          <textarea
            value={defaultsText}
            onChange={(e) => onDefaultsChange(e.target.value)}
            rows={6}
            className="w-full px-2 py-1.5 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            placeholder='{"insured": true, "lifetime_warranty": false}'
          />
          {defaultsErr && (
            <div className="text-xs text-ember-500 mt-1">{defaultsErr}</div>
          )}
        </label>
        <label className="block">
          <div className="text-xs text-muted mb-1">
            Default tags (comma-separated)
          </div>
          <input
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="appliance, household, insured"
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending || !!defaultsErr || !name.trim()}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {save.isPending ? "saving…" : template ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
