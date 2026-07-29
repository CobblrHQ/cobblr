// /fields — manage custom field defs per entity kind. Mirror of
// what bundles do, but exposed as a UI so users can sketch their
// own without writing a bundle manifest.

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { ApiError, api, type CatalogFieldRenderer, type FieldScope, type PlatformFieldDef } from "../lib/api";
import { TraitScopePicker } from "../components/TraitScopePicker";
import { ChoicesInput } from "../components/ChoicesInput";
import { slugifyFieldName } from "../lib/field-key";
import { fieldFormReadiness } from "../lib/field-form";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { FieldDefDetail } from "../components/FieldDefDetail";
import { FieldRenderer, UnitInput, useToast, usePageTitle } from "@cobblr/platform-web";

// `relation` is deliberately absent: user-authored relation fields (picking a
// ref_kind in this UI) are a follow-on; today relation defs are contributed by
// modules (e.g. core-mobility's home_location) and just display here.
const TYPES: PlatformFieldDef["type"][] = ["text", "number", "boolean", "date", "url", "richtext", "computed"];

// Default renderer per field type — keeps the dropdown small and
// surfaces what the user almost always wants.
const RENDERERS_BY_TYPE: Record<PlatformFieldDef["type"], CatalogFieldRenderer[]> = {
  text: ["text", "color-hex", "image-url", "url-link", "code", "qr"],
  number: ["text", "year"],
  boolean: ["boolean"],
  date: ["text"],
  url: ["url-link", "image-url"],
  // rich text is authored + stored as Markdown, always rendered as Markdown.
  richtext: ["markdown"],
  // computed renders its template string; `url-link` makes a {{ }}-built URL
  // (e.g. a git repo link) clickable instead of plain text.
  computed: ["text", "url-link"],
  // relation values display as the referenced entity's title (resolved
  // server-side as `<name>_label`); no renderer variants to pick.
  relation: ["text"],
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
  markdown: "**Bold**, _italic_, `code`",
  qr: "https://cobblr.me",
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

  // A field is aimed at ONE kind, or at a CLASS of kinds (a trait predicate).
  const [mode, setMode] = useState<"kind" | "scope">("kind");
  const [scopeTraits, setScopeTraits] = useState<string[]>([]);
  const [entityKind, setEntityKind] = useState("");
  const [name, setName] = useState("");
  // Once the user edits the key by hand, stop overwriting it from the label.
  const [nameTouched, setNameTouched] = useState(false);
  const [label, setLabel] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [type, setType] = useState<PlatformFieldDef["type"]>("text");
  const [renderer, setRenderer] = useState<CatalogFieldRenderer>("text");
  const [template, setTemplate] = useState("");
  const [unit, setUnit] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const rendererChoices = RENDERERS_BY_TYPE[type];
  // The scope PRESETS — one-click chips above the trait grid. They're a shortcut
  // into the vocabulary, not the vocabulary: any combination of the 12 traits is a
  // valid scope, and the grid is what expresses that.
  const scopes: FieldScope[] = fields.data?.scopes ?? [];
  const scopeBy = (key: string) => scopes.find((s) => s.key === key) ?? null;

  const create = useMutation({
    mutationFn: () =>
      api.createFieldDef(slug, {
        // In scope mode the server DERIVES entity_kind from the predicate (the
        // canonical sentinel), so the two can never disagree.
        entity_kind: mode === "scope" ? "" : entityKind,
        applies_to: mode === "scope" ? { traits: scopeTraits } : undefined,
        name,
        display_label: label,
        type,
        renderer: renderer === "text" ? null : renderer,
        template: type === "computed" ? template : undefined,
        unit: type === "number" && unit.trim() ? unit.trim() : undefined,
        // Only text fields take a dropdown; the API rejects choices on any other
        // type, so don't send an empty array and trip it.
        choices: type === "text" && choices.length ? choices : undefined,
      }),
    onSuccess: (created) => {
      toast.success(
        created.scope_label
          ? `Added "${label}" to ${created.scope_label.toLowerCase()}.`
          : `Added "${label}" to ${created.entity_kind}.`,
      );
      void qc.invalidateQueries({ queryKey: ["field-defs", slug] });
      setEntityKind("");
      setScopeTraits([]);
      setName("");
      setNameTouched(false);
      setLabel("");
      setChoices([]);
      setType("text");
      setRenderer("text");
      setTemplate("");
      setUnit("");
      setErr(null);
    },
    onError: (e: unknown) => {
      const msg = e instanceof ApiError ? e.message : "Couldn't create";
      setErr(msg);
      toast.error(msg);
    },
  });

  // ONE readiness rule, shared by the button's `disabled`, the hint beside it, and
  // this guard — so they can't drift. They did: the button demanded an entityKind,
  // which a class-scoped field never has, and the form went permanently
  // unsubmittable with nothing said about why.
  const readiness = fieldFormReadiness({
    mode,
    entityKind,
    scopeTraits,
    name,
    label,
    type,
    template,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!readiness.ok) {
      setErr(readiness.reason);
      return;
    }
    create.mutate();
  }

  // Your own fields float to the top; bundle- / module-shipped ones sit below a
  // divider — so you're not scrolling past a wall of bundled fields to find the
  // one you just added. "Yours" = neither bundle-shipped nor module-contributed.
  const isMine = (f: PlatformFieldDef) => !f.bundle_id && !f.source_module;
  const groupByKind = (items: PlatformFieldDef[]) => {
    const g: Record<string, PlatformFieldDef[]> = {};
    for (const f of items) (g[f.entity_kind] ||= []).push(f);
    return g;
  };
  const allItems = fields.data?.items ?? [];
  const mine = groupByKind(allItems.filter(isMine));
  const bundled = groupByKind(allItems.filter((f) => !isMine(f)));

  const renderGroups = (groups: Record<string, PlatformFieldDef[]>) =>
    Object.entries(groups).map(([kind, list]) => (
      <div
        key={kind}
        className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4"
      >
        {list[0]?.scope_label ? (
          // A scope, not a kind. Say what it means in words — "@physical+unique"
          // is an implementation detail the user never has to learn.
          <div className="mb-2">
            <div className="font-mono text-xs text-accent dark:text-cobble-300">
              {list[0].scope_label}
            </div>
            <div className="text-[11px] text-faint dark:text-slate-500">
              {scopeBy(kind)?.hint ?? "Every kind whose traits match."} Anything you
              add later that matches gets these too.
            </div>
          </div>
        ) : (
          <div className="font-mono text-xs text-accent dark:text-cobble-300 mb-2">{kind}</div>
        )}
        <ul className="space-y-0.5">
          {list
            .sort((a, b) => a.position - b.position)
            .map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  aria-expanded={selected?.id === f.id}
                  onClick={() => setSelected(selected?.id === f.id ? null : f)}
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
                    className={
                      "text-faint dark:text-slate-600 group-hover:text-accent transition " +
                      (selected?.id === f.id ? "rotate-90" : "")
                    }
                  />
                </button>
                {selected?.id === f.id && (
                  <FieldDefDetail
                    onClose={() => setSelected(null)}
                    slug={slug}
                    fieldDef={f}
                    scopeLabel={f.scope_label ?? null}
                  />
                )}
              </li>
            ))}
        </ul>
      </div>
    ));

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
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
        {/* A field lives on ONE kind, or on a CLASS of them. "Origin: where I got
            this" belongs on everything physical you track — and on anything
            physical you add later, with nothing to re-create per kind. The class
            is a trait predicate, the same one actions use, so it isn't a short
            list of canned options: any combination of the 12 traits works. */}
        <div className="flex items-center gap-4 text-xs">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
            Applies to
          </span>
          {(["kind", "scope"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="radio"
                checked={mode === m}
                onChange={() => setMode(m)}
                className="accent-cobble-500"
              />
              <span className="text-content dark:text-mortar-100">
                {m === "kind" ? "One kind" : "A class of things"}
              </span>
            </label>
          ))}
        </div>

        {mode === "scope" && (
          <div className="rounded-lg border border-line dark:border-slate-700 p-3">
            <TraitScopePicker
              value={scopeTraits}
              onChange={setScopeTraits}
              kinds={kinds.data?.items ?? []}
              presets={scopes.map((s) => ({
                key: s.key,
                label: s.label,
                hint: s.hint,
                traits: s.traits ?? [],
                group: s.group,
              }))}
              previewVerb="lands on"
              emptyHint="lands on nothing — pick at least one trait"
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {mode === "kind" && (
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Entity kind
            </span>
            <select
              value={entityKind}
              onChange={(e) => setEntityKind(e.target.value)}
              className="input"
            >
              <option value=""> - pick one - </option>
              {kinds.data?.items.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.display_name} ({k.id})
                </option>
              ))}
            </select>
          </label>
          )}
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
              Label
              <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                what you'd call it
              </span>
            </span>
            <input
              value={label}
              onChange={(e) => {
                const next = e.target.value;
                setLabel(next);
                // Keep the key in lockstep until the user takes it over by hand.
                if (!nameTouched) setName(slugifyFieldName(next));
              }}
              placeholder="e.g. Acquired from"
              className="input"
            />
          </label>
          <label className="block">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
              Key
              <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                auto - how templates + the API refer to it
              </span>
            </span>
            <input
              value={name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              placeholder="acquired_from"
              className="input font-mono text-xs"
            />
          </label>
          {/* Choices + Renderer share one row: the choice LIST is the big input and
              the renderer is a small dropdown, so 2/3 + 1/3 rather than two
              full-width bands stacked. A text field with choices renders as a
              DROPDOWN on the record (with a "+ add new" option) — that control has
              existed for ages; there was simply no way to SET the choices here. */}
          {(type === "text" || rendererChoices.length > 1) && (
            <div className="col-span-2 grid grid-cols-3 gap-3">
              {type === "text" && (
                <div className="col-span-2">
                  <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                    Choices
                    <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                      optional - makes it a dropdown
                    </span>
                  </span>
                  <ChoicesInput
                    value={choices}
                    onChange={setChoices}
                    placeholder="e.g. FB Marketplace, Gift, Bought new"
                  />
                </div>
              )}
              {rendererChoices.length > 1 && (
                <label className="block">
                  <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                    Renderer
                    <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                      how it draws
                    </span>
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      value={renderer}
                      onChange={(e) => setRenderer(e.target.value as CatalogFieldRenderer)}
                      className="input flex-1 min-w-0"
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
          )}
          {type === "computed" && (
            <label className="block col-span-2">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                Template
                <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                  read-only - rendered from the entity's fields
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
          {type === "number" && (
            <label className="block">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
                Unit
                <span className="ml-2 normal-case tracking-normal text-faint dark:text-slate-600">
                  optional - what the number measures ("mm", "g")
                </span>
              </span>
              <UnitInput value={unit} onCommit={setUnit} placeholder="none" />
            </label>
          )}
        </div>
        {err && <div className="text-xs text-ember-500">{err}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!readiness.ok || create.isPending}
            className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50 flex items-center gap-1.5"
          >
            <Plus size={14} /> Add field
          </button>
          {/* A greyed-out button with no reason is a dead end the user can't
              debug — and it's exactly how a drifted rule hides. Say what it's
              waiting for. */}
          {!readiness.ok && readiness.reason && (
            <span className="text-xs text-faint dark:text-slate-500">
              {readiness.reason}
            </span>
          )}
        </div>
      </form>

      <div className="space-y-3">
        {allItems.length === 0 && (
          <div className="text-xs text-faint dark:text-slate-500 italic">
            No custom fields yet. Install a bundle or add one above.
          </div>
        )}

        {Object.keys(mine).length > 0 && (
          <>
            <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
              // your fields
            </div>
            {renderGroups(mine)}
          </>
        )}

        {Object.keys(bundled).length > 0 && (
          <>
            <div
              className={`text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 ${
                Object.keys(mine).length > 0 ? "pt-3 mt-1 border-t border-line dark:border-slate-700" : ""
              }`}
            >
              // from bundles &amp; modules
            </div>
            {renderGroups(bundled)}
          </>
        )}
      </div>

    </div>
  );
}
