// /fields — manage custom field defs per entity kind. Mirror of
// what bundles do, but exposed as a UI so users can sketch their
// own without writing a bundle manifest.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { ApiError, api, type CatalogFieldRenderer, type PlatformFieldDef } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { FieldDefDetailModal } from "../components/FieldDefDetailModal";
import { FieldRenderer, useToast, usePageTitle } from "@cobblr/platform-web";

const TYPES: PlatformFieldDef["type"][] = ["text", "number", "boolean", "date", "url", "computed"];

// Default renderer per field type — keeps the dropdown small and
// surfaces what the user almost always wants.
const RENDERERS_BY_TYPE: Record<PlatformFieldDef["type"], CatalogFieldRenderer[]> = {
  text: ["text", "color-hex", "image-url", "url-link", "code"],
  number: ["text", "year"],
  boolean: ["boolean"],
  date: ["text"],
  url: ["url-link", "image-url"],
  // computed renders its rendered string as plain text — no renderer picker.
  computed: ["text"],
};

// Tiny inline sample so the user can see what a renderer looks like.
const RENDERER_SAMPLE: Record<CatalogFieldRenderer, string> = {
  text: "Hello",
  "color-hex": "0033B2",
  "image-url": "https://placehold.co/40",
  "url-link": "https://example.com",
  year: "1965",
  boolean: "true",
  code: "ABC-123",
};

export function FieldsPage() {
  usePageTitle("Fields");
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
  const [renderer, setRenderer] = useState<CatalogFieldRenderer>("text");
  const [template, setTemplate] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const rendererChoices = RENDERERS_BY_TYPE[type];

  const create = useMutation({
    mutationFn: () =>
      api.createFieldDef(slug, {
        entity_kind: entityKind,
        name,
        display_label: label,
        type,
        renderer: type === "computed" || renderer === "text" ? null : renderer,
        template: type === "computed" ? template : undefined,
      }),
    onSuccess: () => {
      toast.success(`Added "${label}" to ${entityKind}.`);
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      setEntityKind("");
      setName("");
      setLabel("");
      setType("text");
      setRenderer("text");
      setTemplate("");
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
    if (type === "computed" && !template.trim()) {
      setErr("a computed field needs a template, e.g. {{year}} {{manufacturer}}");
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
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">
          fields
        </h1>
        <span className="page-subtitle">
          custom fields on platform entities. show up on the detail page.
        </span>
      </div>

      <form
        onSubmit={submit}
        className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3"
      >
        <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
          // new field
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
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
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Type
            </span>
            <select
              value={type}
              onChange={(e) => {
                const next = e.target.value as PlatformFieldDef["type"];
                setType(next);
                // Reset renderer if the new type doesn't support the
                // currently-picked one (e.g. switching from text to
                // number invalidates color-hex).
                const allowed = RENDERERS_BY_TYPE[next];
                if (!allowed.includes(renderer)) {
                  setRenderer(allowed[0] ?? "text");
                }
              }}
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
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
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
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Display label
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Shelf ID"
              className="input"
            />
          </label>
          {type === "computed" && (
            <label className="block col-span-2">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                Template
                <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                  read-only — rendered from the entity's fields
                </span>
              </span>
              <textarea
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                rows={2}
                placeholder="{{year}} {{manufacturer}} {{model}}"
                className="input font-mono text-xs w-full"
              />
              <span className="mt-1 block text-[10px] text-faint dark:text-slate-600 leading-relaxed">
                {`Use {{field_name}} for this entity's own fields. Add | default: "—" for a fallback,
                or | relative on a date (e.g. {{maintenance.next_scheduled_at | relative}} → "in 6 days").
                Related data comes from providers like {{maintenance.last_performed}}.`}
              </span>
            </label>
          )}
          {type !== "computed" && rendererChoices.length > 1 && (
            <label className="block col-span-2">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                Renderer
                <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                  how this value draws on cards + detail pages
                </span>
              </span>
              <div className="flex items-center gap-2">
                <select
                  value={renderer}
                  onChange={(e) => setRenderer(e.target.value as CatalogFieldRenderer)}
                  className="input flex-1"
                >
                  {rendererChoices.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                {renderer !== "text" && (
                  <FieldRenderer
                    fieldName={name || "preview"}
                    value={RENDERER_SAMPLE[renderer]}
                    renderer={renderer}
                    size="inline"
                  />
                )}
              </div>
            </label>
          )}
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
          <div className="text-xs text-faint dark:text-slate-500 italic">
            No custom fields yet. Install a bundle or add one above.
          </div>
        )}
        {Object.entries(grouped).map(([kind, list]) => (
          <div
            key={kind}
            className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4"
          >
            <div className="font-mono text-xs text-accent dark:text-cobble-300 mb-2">
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
                      className="w-full text-left flex items-center gap-3 text-sm text-content dark:text-mortar-100 px-1 py-1.5 rounded hover:bg-subtle dark:hover:bg-slate-800/60 transition group"
                    >
                      <span className="font-mono text-xs text-faint dark:text-slate-500 w-32 truncate">
                        {f.name}
                      </span>
                      <span className="flex-1">{f.display_label}</span>
                      <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                        {f.type}
                      </span>
                      {f.bundle_id && (
                        <span className="text-[10px] font-mono uppercase tracking-widest text-accent">
                          bundled
                        </span>
                      )}
                      <ChevronRight
                        size={13}
                        className="text-faint dark:text-slate-600 group-hover:text-accent transition"
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
