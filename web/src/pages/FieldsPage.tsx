// /fields — manage custom field defs per entity kind. Mirror of
// what bundles do, but exposed as a UI so users can sketch their
// own without writing a bundle manifest.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { ApiError, api, type PlatformFieldDef } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { FieldDefDetailModal } from "../components/FieldDefDetailModal";
import { useToast } from "@cobblr/platform-web";

const TYPES: PlatformFieldDef["type"][] = ["text", "number", "boolean", "date", "url"];

export function FieldsPage() {
  const { activeSlug: slug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<PlatformFieldDef | null>(null);

  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
  });
  const fields = useQuery({
    queryKey: ["field-defs", slug],
    queryFn: () => api.listFieldDefs(slug),
    enabled: !!slug,
  });

  const [entityKind, setEntityKind] = useState("");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<PlatformFieldDef["type"]>("text");
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createFieldDef(slug, {
        entity_kind: entityKind,
        name,
        display_label: label,
        type,
      }),
    onSuccess: () => {
      toast.success(`Added "${label}" to ${entityKind}.`);
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      setEntityKind("");
      setName("");
      setLabel("");
      setType("text");
      setErr(null);
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? e.message : "Couldn't create";
      setErr(msg);
      toast.error(msg);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!entityKind || !name || !label) return;
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      setErr("name must be lowercase, start with a letter, only a-z 0-9 _");
      return;
    }
    create.mutate();
  }

  // Group fields by entity kind for readability.
  const grouped: Record<string, PlatformFieldDef[]> = {};
  for (const f of fields.data?.items ?? []) {
    (grouped[f.entity_kind] ||= []).push(f);
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase">
          fields
        </h1>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          custom fields on platform entities. show up on the detail page.
        </span>
      </div>

      <form
        onSubmit={submit}
        className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-3"
      >
        <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
          // new field
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Entity kind
            </span>
            <select
              value={entityKind}
              onChange={(e) => setEntityKind(e.target.value)}
              className="input"
            >
              <option value="">— pick one —</option>
              {kinds.data?.items.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.display_name} ({k.id})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Type
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as PlatformFieldDef["type"])}
              className="input"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Name (a-z 0-9 _)
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. shelf_id"
              className="input font-mono text-xs"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
              Display label
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Shelf ID"
              className="input"
            />
          </label>
        </div>
        {err && <div className="text-xs text-ember-500">{err}</div>}
        <button
          type="submit"
          disabled={!entityKind || !name || !label || create.isPending}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50 flex items-center gap-1.5"
        >
          <Plus size={14} /> Add field
        </button>
      </form>

      <div className="space-y-3">
        {Object.keys(grouped).length === 0 && (
          <div className="text-xs text-slate-400 dark:text-slate-500 italic">
            No custom fields yet. Install a bundle or add one above.
          </div>
        )}
        {Object.entries(grouped).map(([kind, list]) => (
          <div
            key={kind}
            className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4"
          >
            <div className="font-mono text-xs text-cobble-600 dark:text-cobble-300 mb-2">
              {kind}
            </div>
            <ul className="space-y-0.5">
              {list
                .sort((a, b) => a.position - b.position)
                .map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(f)}
                      className="w-full text-left flex items-center gap-3 text-sm text-slate-700 dark:text-mortar-100 px-1 py-1.5 rounded hover:bg-mortar-50 dark:hover:bg-slate-800/60 transition group"
                    >
                      <span className="font-mono text-xs text-slate-400 dark:text-slate-500 w-32 truncate">
                        {f.name}
                      </span>
                      <span className="flex-1">{f.display_label}</span>
                      <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500">
                        {f.type}
                      </span>
                      {f.bundle_id && (
                        <span className="text-[10px] font-mono uppercase tracking-widest text-cobble-500">
                          bundled
                        </span>
                      )}
                      <ChevronRight
                        size={13}
                        className="text-slate-300 dark:text-slate-600 group-hover:text-cobble-500 transition"
                      />
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>

      <FieldDefDetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        slug={slug}
        fieldDef={selected}
      />
    </div>
  );
}
