import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@cobblr/platform-web";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { api } from "../../lib/api";

type Field = { type?: string; title?: string; default?: unknown; enum?: unknown[]; minimum?: number; maximum?: number };
type Template = { id: string; title: string; summary?: string; params_schema?: { properties?: Record<string, Field>; required?: string[] } };

export function DesignMakeDoor({ makeId }: { makeId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="mt-2 rounded border border-line dark:border-slate-700 px-3 py-1.5 text-sm">Design this</button>
    {open && <DesignMakeDialog makeId={makeId} onClose={() => setOpen(false)} />}
  </>;
}

export function DesignMakeDialog({ makeId, onClose }: { makeId: string; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const options = useQuery({ queryKey: ["design-options", activeSlug], queryFn: () => api.getServiceCapabilityOptions(activeSlug, "design.part") as Promise<{ templates?: Template[] } | null> });
  const [method, setMethod] = useState("template");
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [source, setSource] = useState("");
  const [language, setLanguage] = useState<"solidcraft" | "openscad">("solidcraft");
  const [material, setMaterial] = useState("PLA");
  const templates = options.data?.templates ?? [];
  const template = templates.find((t) => t.id === templateId);
  const start = useMutation({
    mutationFn: () => api.printThis(activeSlug, { make_id: makeId, material, ...(method === "template" ? { template: templateId, params } : { source, source_lang: language }) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["makes", activeSlug] }); onClose(); },
  });
  const inputClass = "mt-1 block w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5";
  return <Modal open onClose={onClose} title="Design this">
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
      <p className="text-sm text-muted">The design service makes a model and a preview. Review them before choosing a printer or slicing.</p>
      <label className="block text-sm">Design method<select className={inputClass} value={method} onChange={(e) => setMethod(e.target.value)}><option value="template">A template</option><option value="source">CAD source</option></select></label>
      {method === "template" ? <>
        {options.isLoading && <p className="text-sm text-muted">Loading templates…</p>}
        {options.isError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">The templates could not be read. Close this form and try again.</p>}
        {!options.isLoading && !options.isError && !templates.length && <p className="text-sm text-muted">This service has no templates. Ask Cobb to write a design, or choose CAD source to bring one.</p>}
        <label className="block text-sm">Template<select required className={inputClass} value={templateId} onChange={(e) => {
          setTemplateId(e.target.value);
          const picked = templates.find((t) => t.id === e.target.value);
          setParams(Object.fromEntries(Object.entries(picked?.params_schema?.properties ?? {}).filter(([, p]) => p.default !== undefined).map(([k, p]) => [k, p.default])));
        }}><option value="">Choose a template</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
        {template?.summary && <p className="text-sm text-muted">{template.summary}</p>}
        {Object.entries(template?.params_schema?.properties ?? {}).map(([key, field]) => <label key={key} className="block text-sm">{field.title ?? key.replace(/_/g, " ")}
          {field.type === "boolean" ? <input type="checkbox" className="ml-2" checked={params[key] === true} onChange={(e) => setParams({ ...params, [key]: e.target.checked })} /> : field.enum ? <select required={template?.params_schema?.required?.includes(key)} className={inputClass} value={String(params[key] ?? "")} onChange={(e) => setParams({ ...params, [key]: field.enum!.find((v) => String(v) === e.target.value) })}><option value="">Choose…</option>{field.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}</select> : <input className={inputClass} type={field.type === "number" || field.type === "integer" ? "number" : "text"} step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} required={template?.params_schema?.required?.includes(key)} value={String(params[key] ?? "")} onChange={(e) => {
            const next = { ...params };
            if (!e.target.value) delete next[key];
            else next[key] = field.type === "number" || field.type === "integer" ? Number(e.target.value) : e.target.value;
            setParams(next);
          }} />}
        </label>)}
      </> : <>
        <label className="block text-sm">Language<select className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}><option value="solidcraft">SolidCraft (JSON script)</option><option value="openscad">OpenSCAD</option></select></label>
        <label className="block text-sm">CAD source<textarea required rows={8} className={`${inputClass} font-mono`} value={source} onChange={(e) => setSource(e.target.value)} /></label>
      </>}
      <label className="block text-sm">Material<input required className={inputClass} value={material} onChange={(e) => setMaterial(e.target.value)} /></label>
      {start.isError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{start.error.message}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded border border-line px-3 py-1.5 text-sm">Cancel</button><button type="submit" disabled={start.isPending || !material.trim() || (method === "template" ? !templateId : !source.trim())} className="rounded bg-cobble-600 text-white disabled:opacity-50 px-3 py-1.5 text-sm">{start.isPending ? "Starting design…" : "Make the model"}</button></div>
    </form>
  </Modal>;
}
