// Settings — categories management. Locations used to live here too
// but have graduated to the foundational core-locations module — the
// canonical UI for them is /locations in the host app.

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useInventory } from "./context";
import { InventoryApiError, type InvFieldDef } from "./api";
import { usePageTitle } from "@cobblr/platform-web";

export function SettingsPage() {
  usePageTitle("Inventory settings");
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <FieldsCard />
      <NounCard />
      <StockTrackingCard />
    </div>
  );
}

/** What this instance calls its items. Defaulted from the collection name at
 *  creation ("Films" → "Film" / "films"), editable here for the odd case a
 *  plural doesn't singularize cleanly ("Series", "Equipment"). Drives the whole
 *  UI — "New Film", "search films", "No films yet". Only a named instance has
 *  its own noun; the default Inventory keeps "part". See one-record-substrate.md. */
function NounCard() {
  const { api, orgSlug, instance } = useInventory();
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ["inv-nouns", orgSlug, instance],
    queryFn: () => api.getNouns(),
    enabled: !!instance,
  });
  const [singular, setSingular] = useState<string | null>(null);
  const [plural, setPlural] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.setNouns(singular ?? current.data?.singular ?? "", plural ?? current.data?.plural ?? ""),
    onSuccess: () => {
      setSingular(null);
      setPlural(null);
      void qc.invalidateQueries({ queryKey: ["inv-nouns", orgSlug, instance] });
      void qc.invalidateQueries({ queryKey: ["entity-kind-overrides"] });
    },
  });
  if (!instance) return null;
  const sVal = singular ?? current.data?.singular ?? "";
  const pVal = plural ?? current.data?.plural ?? "";
  const dirty = singular !== null || plural !== null;
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <h3 className="font-display text-sm font-bold text-content dark:text-mortar-100">What do you call these?</h3>
      <p className="mt-1 text-xs text-muted dark:text-slate-400">
        The word for one item and many. Drives the whole list - the add button, search, empty state.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block">
          <div className="text-[11px] text-faint mb-1">One</div>
          <input className="input !w-full" value={sVal} placeholder="film" onChange={(e) => setSingular(e.target.value)} />
        </label>
        <label className="block">
          <div className="text-[11px] text-faint mb-1">Many</div>
          <input className="input !w-full" value={pVal} placeholder="films" onChange={(e) => setPlural(e.target.value)} />
        </label>
      </div>
      <button
        className="mt-3 rounded-md bg-cobble-600 hover:bg-cobble-500 text-white text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
        disabled={!dirty || save.isPending || !sVal.trim() || !pVal.trim()}
        onClick={() => save.mutate()}
      >
        {save.isPending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

/** The sticky stock-vs-catalog override for a named instance. The platform
 *  derives this automatically from the data (a catalog with no quantities stays
 *  lean; anything you count/reorder shows stock), so "Auto" is the right default
 *  and almost always correct. This is the escape hatch for the rare miss. Only
 *  shown on a named instance — the default Inventory is always stock.
 *  See docs/design-decisions/one-record-substrate.md. */
function StockTrackingCard() {
  const { api, orgSlug, instance } = useInventory();
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ["inv-stock-override", orgSlug, instance],
    queryFn: () => api.getStockOverride(),
    enabled: !!instance,
  });
  const save = useMutation({
    mutationFn: (v: boolean | null) => api.setStockOverride(v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inv-stock-override", orgSlug, instance] });
      void qc.invalidateQueries({ queryKey: ["inv-disclosure", orgSlug, instance ?? "inventory"] });
    },
  });
  // Only a named instance can be a catalog; the default Inventory is always stock.
  if (!instance) return null;
  const value = current.data === undefined ? "auto" : current.data ? "stock" : "catalog";
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
      <h3 className="font-display text-sm font-bold text-content dark:text-mortar-100">Stock tracking</h3>
      <p className="mt-1 text-xs text-muted dark:text-slate-400">
        Whether this list shows quantities, reorder points, and allocations, or stays a lean
        catalog. <span className="text-content dark:text-mortar-200">Auto</span> lets the platform
        decide from your data - the right choice almost always.
      </p>
      <select
        className="input mt-3 !w-auto"
        value={value}
        disabled={current.isLoading || save.isPending}
        onChange={(e) => {
          const v = e.target.value;
          save.mutate(v === "auto" ? null : v === "stock");
        }}
      >
        <option value="auto">Auto (recommended)</option>
        <option value="stock">Always track stock</option>
        <option value="catalog">Catalog only (no stock)</option>
      </select>
    </div>
  );
}

/** Lists the instance's fields and lets the user edit the dropdown options
 *  (add / remove) — a discoverable "config area" for a list's options.
 *  Scoped to the active entity kind, so on the Yarn instance it shows the
 *  yarn fields. */
function FieldsCard() {
  const { api, orgSlug, entityKind, itemNoun } = useInventory();
  const defs = useQuery({
    queryKey: ["platform-field-defs", orgSlug, entityKind],
    queryFn: () => api.listFieldDefs(entityKind),
    staleTime: 60_000,
  });
  const fields = (defs.data?.items ?? [])
    .filter((d) => d.type !== "computed")
    .sort((a, b) => a.position - b.position);

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-1">
        // fields
      </div>
      {/* Say what CAN be done here. The old copy promised only "edit the
          dropdown options" while the heading read "fields & options", so a
          field with no options showed "text field - no dropdown options" and
          no way to act on it: "how do I actually edit it in here?" (the author,
          2026-08-01). Renaming works inline now; the rest is one link away. */}
      <p className="text-[11px] text-faint dark:text-slate-500 mb-3 leading-snug">
        What each {itemNoun} records. Click a name to rename it, and manage its
        dropdown options below. To add or remove fields, change a type, or
        reorder them, open the{" "}
        <Link to="/fields" className="text-accent hover:underline">field builder</Link>.
      </p>
      <ul className="space-y-3">
        {/* Categories sit IN this list, not in a card of their own: they are the
            Category field's options as far as anyone using this page is
            concerned, and two panels for one idea read as two ideas (the author,
            2026-08-01). They keep their own API + slugs underneath. */}
        <CategoryRow />
        {fields.map((f) => (
          <FieldRow key={f.id} def={f} />
        ))}
        {defs.data && fields.length === 0 && (
          <li className="text-xs text-faint dark:text-slate-500 italic">No custom fields on this list.</li>
        )}
      </ul>
    </div>
  );
}

function FieldRow({ def }: { def: InvFieldDef }) {
  const { api, orgSlug, entityKind } = useInventory();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hasChoices = (def.choices?.length ?? 0) > 0;

  const save = useMutation({
    mutationFn: (choices: string[]) => api.updateFieldDef(def.id, { choices }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["platform-field-defs", orgSlug, entityKind] });
      setDraft("");
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof InventoryApiError ? e.message : "Couldn't save"),
  });
  // Rename in place. The PATCH already accepted display_label; only this typed
  // client narrowed it away, which is a large part of why the panel looked
  // read-only. Type changes stay in the field builder - they have data
  // consequences this row can't explain.
  const rename = useMutation({
    mutationFn: (display_label: string) => api.updateFieldDef(def.id, { display_label }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["platform-field-defs", orgSlug, entityKind] });
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof InventoryApiError ? e.message : "Couldn't rename"),
  });

  function add(e: FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    if (!v) return;
    if ((def.choices ?? []).some((c) => c.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    save.mutate([...(def.choices ?? []), v]);
  }
  function remove(c: string) {
    save.mutate((def.choices ?? []).filter((x) => x !== c));
  }

  return (
    <li>
      <input
        defaultValue={def.display_label}
        aria-label={`Rename ${def.display_label}`}
        title="Click to rename this field"
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (!v) { e.target.value = def.display_label; return; }
          if (v !== def.display_label) rename.mutate(v);
        }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className="w-full bg-transparent border border-transparent hover:border-line dark:hover:border-slate-700 focus:border-accent rounded px-1 -mx-1 text-sm text-content dark:text-mortar-100 font-medium focus:outline-none transition"
      />
      {def.type === "boolean" ? (
        // A yes/no field: edit the two state labels (shown instead of true/false
        // everywhere). Stored as `choices` = [off-label, on-label]; blank → Yes/No.
        <div className="mt-1.5">
          <div className="text-[11px] text-faint dark:text-slate-500 mb-1">Labels shown instead of true/false:</div>
          <div className="flex items-center gap-2">
            <input
              defaultValue={def.choices?.[0] ?? ""}
              placeholder="No"
              aria-label={`${def.display_label} — label when off`}
              onBlur={(e) => save.mutate([e.target.value.trim() || "No", (def.choices?.[1] ?? "").trim() || "Yes"])}
              className="input text-sm w-28"
            />
            <span className="text-faint">/</span>
            <input
              defaultValue={def.choices?.[1] ?? ""}
              placeholder="Yes"
              aria-label={`${def.display_label} — label when on`}
              onBlur={(e) => save.mutate([(def.choices?.[0] ?? "").trim() || "No", e.target.value.trim() || "Yes"])}
              className="input text-sm w-28"
            />
          </div>
        </div>
      ) : !hasChoices ? (
        <div className="text-[11px] text-faint dark:text-slate-500 italic">
          {def.renderer === "color-hex" ? "colour" : def.type} field - no dropdown options
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {(def.choices ?? []).map((c) => (
              <span
                key={c}
                className="inline-flex items-center gap-1 rounded-full bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 pl-2.5 pr-1 py-0.5 text-xs text-content dark:text-mortar-100"
              >
                {c}
                <button
                  type="button"
                  onClick={() => remove(c)}
                  disabled={save.isPending}
                  className="rounded-full p-0.5 text-faint hover:text-ember-500 hover:bg-ember-50 dark:hover:bg-slate-700 transition"
                  aria-label={`Remove ${c}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <form onSubmit={add} className="flex gap-2 mt-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="add an option…"
              className="input flex-1 text-sm"
            />
            <button
              type="submit"
              disabled={save.isPending || !draft.trim()}
              className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 transition disabled:opacity-50 flex items-center gap-1"
            >
              <Plus size={12} /> Add
            </button>
          </form>
        </>
      )}
      {error && <div className="text-xs text-ember-500 mt-1">{error}</div>}
    </li>
  );
}

/** Categories, rendered as a field row. They have their own table + slugs
 *  underneath, but on this page they are simply the Category options. */
function CategoryRow() {
  const { api } = useInventory();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createCategory({ name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-categories"] });
      setName("");
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof InventoryApiError ? e.message : "Couldn't create"),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }
  const items = list.data?.items ?? [];
  return (
    <li>
      <div className="text-sm text-content dark:text-mortar-100 font-medium">Category</div>
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {items.map((c) => (
          <span
            key={c.id}
            title={c.slug}
            className="inline-flex items-center gap-1 rounded-full bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 px-2.5 py-0.5 text-xs text-content dark:text-mortar-100"
          >
            {c.name}
          </span>
        ))}
        {list.data && items.length === 0 && (
          <span className="text-[11px] text-faint dark:text-slate-500 italic">No categories yet.</span>
        )}
      </div>
      <form onSubmit={submit} className="mt-1.5 flex gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="add a category…"
          className="input flex-1 !py-1 text-xs"
        />
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-2.5 transition disabled:opacity-50 flex items-center gap-1"
        >
          <Plus size={11} /> Add
        </button>
      </form>
      {error && <div className="text-xs text-ember-500 mt-1">{error}</div>}
    </li>
  );
}

