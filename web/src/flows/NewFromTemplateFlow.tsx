import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fieldNeed, FieldPack, RecordFormModal, RelationSelect, useToast, type TemplateCreateArgs } from "@cobblr/platform-web";
import { api, type EntityTemplate, type PlatformEntityKind } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function NewFromTemplateFlow({ args, onClose }: { args: Record<string, unknown>; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const { kind, instance, scanItemId, seed } = args as TemplateCreateArgs;
  const [picked, setPicked] = useState<EntityTemplate | null>(null);
  const [kindFilter, setKindFilter] = useState(kind ?? "");
  const templates = useQuery({ queryKey: ["templates", activeSlug, kind], queryFn: () => api.listTemplates(activeSlug, kind), enabled: !!activeSlug });
  const kinds = useQuery({ queryKey: ["entity-kinds", activeSlug], queryFn: () => api.listEntityKinds(activeSlug), enabled: !!activeSlug });
  const items = templates.data?.items ?? [];
  const kindLabel = (id: string) => kinds.data?.items.find((k) => k.id === id)?.display_name ?? id.split(":").pop();
  return (
    <RecordFormModal open onClose={onClose} title="New from template">
      {picked ? <TemplateItemForm key={picked.id} template={picked} kind={kinds.data?.items.find((k) => k.id === picked.target_kind)} instance={instance} scanItemId={scanItemId} seed={seed} onClose={onClose} onBack={() => setPicked(null)} /> : (
        <div className="space-y-3">
          {!kind && items.length > 0 && <label className="block text-sm">Kind
            <select className="input mt-1" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="">All kinds</option>
              {[...new Set(items.map((t) => t.target_kind))].map((id) => <option key={id} value={id}>{kindLabel(id)}</option>)}
            </select>
          </label>}
          {templates.isLoading && <p className="text-sm text-muted">Loading templates…</p>}
          {templates.isError && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">Could not load templates. <button type="button" onClick={() => void templates.refetch()}>Try again</button></p>}
          {templates.isSuccess && items.length === 0 && <p className="text-sm text-muted">No templates for this kind yet. You can set them up in <Link className="text-accent underline" to="/configuration/templates" onClick={onClose}>Templates</Link>.</p>}
          {items.filter((t) => !kindFilter || t.target_kind === kindFilter).map((t) => (
            <button type="button" key={t.id} disabled={!kinds.isSuccess} onClick={() => setPicked(t)} className="block w-full rounded-lg border border-line dark:border-slate-700 p-3 text-left hover:border-accent">
              <span className="block font-medium">{t.name}</span>
              {!kind && <span className="block text-xs text-muted">{kindLabel(t.target_kind)}</span>}
              {t.description && <span className="block text-sm text-muted">{t.description}</span>}
            </button>
          ))}
        </div>
      )}
    </RecordFormModal>
  );
}

function TemplateItemForm({ template, kind, instance, scanItemId, seed, onClose, onBack }: {
  template: EntityTemplate; kind?: PlatformEntityKind; instance?: string; scanItemId?: string; seed?: Record<string, unknown>; onClose: () => void; onBack: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const titleField = kind?.fields.find((f) => f.role === "title")?.name;
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const { metadata: defaultFields, ...nativeDefaults } = template.defaults;
    const { metadata: seedFields, ...nativeSeed } = seed ?? {};
    const metadata = { ...(defaultFields as Record<string, unknown> ?? {}), ...(seedFields as Record<string, unknown> ?? {}) };
    return {
      ...(titleField ? { [titleField]: "" } : {}), ...nativeDefaults, ...nativeSeed,
      ...(defaultFields || seedFields ? { metadata } : {}),
    };
  });
  const save = useMutation({
    mutationFn: () => api.instantiateTemplate(activeSlug, template.id, values, { instance, scan_item_id: scanItemId }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      toast.success("Item saved.");
      onClose();
    },
  });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="text-sm text-muted">{template.name}. Change anything before saving.</p>
      <TemplateFields values={values} onChange={setValues} requiredField={titleField} />
      {template.default_tags.length > 0 && <p className="text-sm text-muted">Tags: {template.default_tags.join(", ")}</p>}
      {save.isError && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{save.error.message}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={save.isPending} onClick={onBack} className="px-3 py-2 text-sm">Choose another template</button>
        <button type="button" disabled={save.isPending} onClick={onClose} className="px-3 py-2 text-sm">Cancel</button>
        <button type="submit" disabled={save.isPending || (!!titleField && !String(values[titleField] ?? "").trim())} className="rounded-md bg-cobble-600 px-3 py-2 text-sm text-white disabled:opacity-50">{save.isPending ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

function TemplateFields({ values, onChange, requiredField }: { values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void; requiredField?: string }) {
  return <FieldPack items={Object.entries(values).map(([key, value]) => ({
    need: {
      ...fieldNeed(key, {
        control: typeof value === "boolean" ? "checkbox" : typeof value === "number" ? "number" : key === "project_id" || key === "location_id" ? "picker" : "text",
        label: key.replaceAll("_", " "),
        valueLength: typeof value === "string" ? value.length : undefined,
      }),
      ...(key === requiredField || value !== null && typeof value === "object" ? { full: true } : {}),
    },
    node: <TemplateValue label={key.replaceAll("_", " ")} value={value} required={key === requiredField} onChange={(next) => onChange({ ...values, [key]: next })} />,
  }))} />;
}

function TemplateValue({ label, value, required, onChange }: { label: string; value: unknown; required?: boolean; onChange: (value: unknown) => void }) {
  const [valueType] = useState(typeof value);
  const words = label.charAt(0).toUpperCase() + label.slice(1);
  if (Array.isArray(value)) return <fieldset className="space-y-2 rounded border border-line p-3"><legend className="text-sm">{words}</legend>
    {value.map((v, i) => <div key={i} className="flex items-start gap-2"><div className="min-w-0 flex-1"><TemplateValue label={`${label} ${i + 1}`} value={v} onChange={(next) => onChange(value.map((old, n) => n === i ? next : old))} /></div><button type="button" className="text-sm" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(value.filter((_, n) => n !== i))}>Remove</button></div>)}
    <button type="button" className="text-sm text-accent" onClick={() => onChange([...value, typeof value[0] === "object" && value[0] !== null ? structuredClone(value[0]) : ""])}>Add another</button>
  </fieldset>;
  if (value !== null && typeof value === "object") return <fieldset className="rounded border border-line p-3"><legend className="text-sm">{words}</legend><TemplateFields values={value as Record<string, unknown>} onChange={onChange} /></fieldset>;
  if (typeof value === "boolean") return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />{words}</label>;
  if (label === "project id") return <label className="block text-sm">Project<RelationSelect refKind="projects:project" value={value} onChange={onChange} /></label>;
  if (label === "location id") return <label className="block text-sm">Location<RelationSelect refKind="core-locations:location" value={value} onChange={onChange} /></label>;
  return <label className="block text-sm">{words}<input className="input mt-1" required={required} type={valueType === "number" ? "number" : "text"} step={valueType === "number" ? "any" : undefined} value={value == null ? "" : String(value)} onChange={(e) => onChange(valueType === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)} /></label>;
}
