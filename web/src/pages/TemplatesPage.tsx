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
import { kindOptionLabels } from "../lib/kind-option-labels";
import { defaultsFields, readDefault, writeDefault, type DefaultsField } from "../lib/template-defaults";
import { ConfigHeaderActions } from "../components/ConfigPageHeader";

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

  // The kinds a template can be made for come from the workspace (its own
  // collections included), never a list kept here.
  const kinds = useQuery({ queryKey: ["template-kinds", activeSlug], queryFn: () => api.listTemplateKinds(activeSlug), enabled: !!activeSlug });
  const labels = kindOptionLabels(kinds.data?.items ?? []);
  const kindLabel = (id: string) => labels.get(id) ?? id.split(":").pop() ?? id;
  // Group by target_kind for a tidier display, in the order the workspace lists its kinds.
  const known = (kinds.data?.items ?? []).map((k) => k.id);
  const inOrder = [...known, ...[...new Set(items.map((t) => t.target_kind))].filter((id) => !known.includes(id))];
  const grouped = inOrder
    .map((id) => ({ kind: { id, label: kindLabel(id) }, items: items.filter((t) => t.target_kind === id) }))
    .filter((g) => g.items.length > 0);

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
        Save the values and tags you start a kind of thing with. Make
        something from a template and they are already filled in, ready
        to change. For example: a household appliance that is insured
        with a lifetime warranty, a new Voron printer that starts as
        "building", a Lego set tagged "new arrival".
      </p>

      {list.isLoading && (
        <div className="text-sm text-muted">Loading…</div>
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="rounded-md border border-dashed border-line dark:border-slate-700 p-8 text-center">
          <CopyPlus size={28} className="mx-auto text-faint dark:text-slate-600 mb-2" />
          <div className="text-sm text-muted dark:text-slate-400">
            No templates yet. Make one with New template.
          </div>
        </div>
      )}

      {grouped.map(({ kind, items }) => (
        <section key={kind.id}>
          <div className="text-[10px] uppercase tracking-widest text-accent mb-2">
            {kind.label} ({items.length})
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
                      aria-label="Edit"
                      type="button"
                      onClick={() => setEditing(t)}
                      title="Edit"
                      className="text-faint hover:text-accent p-1"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      aria-label="Delete"
                      type="button"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete template?",
                          message: `${t.name}: entities already created from it stay; only the template definition is removed.`,
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
  const kindList = useQuery({ queryKey: ["template-kinds", activeSlug], queryFn: () => api.listTemplateKinds(activeSlug), enabled: !!activeSlug });
  const offered = kindList.data?.items ?? [];
  const [pickedKind, setTargetKind] = useState<string>(template?.target_kind ?? "");
  const targetKind = pickedKind || offered[0]?.id || "";
  // A template keeps its own kind visible even if the workspace no longer offers it.
  const options = template && !offered.some((k) => k.id === template.target_kind) ? [...offered, { id: template.target_kind, display_name: template.target_kind.split(":").pop() ?? template.target_kind, display_name_plural: null }] : offered;
  const optionLabels = kindOptionLabels(options);
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [defaults, setDefaults] = useState<Record<string, unknown>>(template?.defaults ?? {});
  // What is typed in the Advanced JSON box until it is valid; null means "show the fields' own".
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [defaultsErr, setDefaultsErr] = useState<string | null>(null);
  // The fields a starting value can be given for: the kind's own, plus the person's custom fields of
  // the kind or of one of its collections (a Bookshelf has its own).
  const entityKinds = useQuery({ queryKey: ["entity-kinds", activeSlug], queryFn: () => api.listEntityKinds(activeSlug), enabled: !!activeSlug });
  const baseKind = entityKinds.data?.items.find((k) => k.id === targetKind);
  // registry-filter-ok: a module's collections are exactly its instance kinds; every kind is still offered in the Kind of thing list above
  const collections = (entityKinds.data?.items ?? []).filter((k) => k.instance_name && baseKind && k.module_name === baseKind.module_name);
  const [collection, setCollection] = useState("");
  const fieldsOfKind = collections.some((k) => k.id === collection) ? collection : targetKind;
  const customDefs = useQuery({ queryKey: ["template-field-defs", activeSlug, fieldsOfKind], queryFn: () => api.listFieldDefs(activeSlug, fieldsOfKind), enabled: !!activeSlug && !!fieldsOfKind });
  const fields = defaultsFields(baseKind?.fields ?? [], customDefs.data?.items ?? []);
  const [tagsText, setTagsText] = useState(
    (template?.default_tags ?? []).join(", "),
  );

  const save = useMutation({
    mutationFn: () => {
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

  // The Advanced box: valid JSON takes over the values, and the save button waits while it is not.
  function onJsonChange(v: string) {
    setJsonDraft(v);
    if (!v.trim()) {
      setDefaults({});
      setDefaultsErr(null);
      return;
    }
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) setDefaultsErr("Must be a JSON object (e.g. {})");
      else {
        setDefaults(parsed as Record<string, unknown>);
        setDefaultsErr(null);
      }
    } catch (e) {
      setDefaultsErr((e as Error).message);
    }
  }
  function onFieldChange(f: DefaultsField, raw: unknown) {
    setDefaults((d) => writeDefault(d, f, raw));
    setJsonDraft(null);
    setDefaultsErr(null);
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
          <div className="text-xs text-muted mb-1">Kind of thing</div>
          <select
            value={targetKind}
            onChange={(e) => setTargetKind(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            {options.map((k) => (
              <option key={k.id} value={k.id}>
                {optionLabels.get(k.id) ?? k.display_name}
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
          <div className="text-xs text-muted mb-1">What it is for (optional)</div>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this template for?"
            className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        {collections.length > 0 && (
          <label className="block">
            <div className="text-xs text-muted mb-1">Fields of</div>
            <select
              value={fieldsOfKind === targetKind ? "" : fieldsOfKind}
              onChange={(e) => setCollection(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            >
              <option value="">{baseKind?.display_name ?? "This kind"} (any collection)</option>
              {collections.map((k) => (
                <option key={k.id} value={k.id}>{k.display_name}</option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="space-y-2" data-testid="template-values">
          <legend className="text-xs text-muted mb-1">Values to fill in</legend>
          {fields.length === 0 && <p className="text-sm text-muted">This kind has no fields to give a starting value.</p>}
          {fields.map((f) => (
            <DefaultInput key={`${f.where}:${f.key}`} field={f} value={readDefault(defaults, f)} onChange={(v) => onFieldChange(f, v)} />
          ))}
        </fieldset>
        <details>
          <summary className="cursor-pointer text-xs text-muted">Advanced: edit as JSON</summary>
          <label className="block mt-2">
            <span className="sr-only">Values as JSON</span>
            <textarea
              value={jsonDraft ?? JSON.stringify(defaults, null, 2)}
              onChange={(e) => onJsonChange(e.target.value)}
              rows={6}
              className="w-full px-2 py-1.5 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              placeholder='{"notes": "Borrowed from the library"}'
            />
            {defaultsErr && <div className="text-xs text-ember-500 mt-1">{defaultsErr}</div>}
          </label>
        </details>
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
            disabled={save.isPending || !!defaultsErr || !name.trim() || !targetKind}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {save.isPending ? "saving…" : template ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const inputClass = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";

function DefaultInput({ field, value, onChange }: { field: DefaultsField; value: unknown; onChange: (v: unknown) => void }) {
  // What is being typed in a number box, kept as text only here; the value handed up is a number.
  const [draft, setDraft] = useState<string | null>(null);
  if (field.input === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }
  return (
    <label className="block">
      <div className="text-xs text-muted mb-1">{field.label}</div>
      {field.input === "choice" ? (
        <select className={inputClass} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">No starting value</option>
          {field.choices!.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      ) : field.input === "number" ? (
        <input
          className={inputClass}
          type="number"
          step="any"
          value={draft ?? (typeof value === "number" ? String(value) : "")}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = e.currentTarget.valueAsNumber;
            onChange(Number.isNaN(n) ? "" : n);
          }}
          onBlur={() => setDraft(null)}
        />
      ) : (
        <input
          className={inputClass}
          type={field.input === "date" ? "date" : "text"}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
