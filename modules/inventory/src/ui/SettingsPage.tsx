// Settings — categories management. Locations used to live here too
// but have graduated to the foundational core-locations module — the
// canonical UI for them is /configuration/locations in the host app.

import { useState, type FormEvent } from "react";
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
      <CategoriesCard />
    </div>
  );
}

/** Lists the instance's fields and lets the user edit the dropdown options
 *  (add / remove) — a discoverable "config area" for a list's options.
 *  Scoped to the active entity kind, so on the Yarn instance it shows the
 *  yarn fields. */
function FieldsCard() {
  const { api, orgSlug, entityKind } = useInventory();
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
        // fields &amp; options
      </div>
      <p className="text-[11px] text-faint dark:text-slate-500 mb-3 leading-snug">
        Edit the dropdown options for this list. New options also appear the next
        time you add an item.
      </p>
      <ul className="space-y-3">
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
      <div className="text-sm text-content dark:text-mortar-100 font-medium">{def.display_label}</div>
      {!hasChoices ? (
        <div className="text-[11px] text-faint dark:text-slate-500 italic">
          {def.renderer === "color-hex" ? "colour" : def.type} field — no dropdown options
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

function CategoriesCard() {
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
    onError: (e: unknown) => {
      setError(e instanceof InventoryApiError ? e.message : "Couldn't create");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent mb-3">
        // categories
      </div>
      <ul className="space-y-1 mb-3">
        {list.data?.items.map((c) => (
          <li key={c.id} className="flex items-baseline gap-2 text-sm">
            <span className="text-content dark:text-mortar-100">{c.name}</span>
            <span className="text-[10px] font-mono text-faint dark:text-slate-500">{c.slug}</span>
          </li>
        ))}
        {list.data && list.data.items.length === 0 && (
          <li className="text-xs text-faint dark:text-slate-500 italic">No categories yet.</li>
        )}
      </ul>
      <form onSubmit={submit} className="flex gap-2 border-t border-line dark:border-slate-700 pt-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new category…"
          className="input flex-1 text-sm"
        />
        <button
          type="submit"
          disabled={create.isPending || !name.trim()}
          className="rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-3 transition disabled:opacity-50 flex items-center gap-1"
        >
          <Plus size={12} /> Add
        </button>
      </form>
      {error && <div className="text-xs text-ember-500 mt-2">{error}</div>}
    </div>
  );
}

