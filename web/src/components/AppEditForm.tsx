import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FieldPack, FieldValueEditor, SearchInput, fieldControl, fieldNeed, useRunAction, useToast, type PlatformFieldDef } from "@cobblr/platform-web";
import { withArticle } from "@cobblr/platform-contract/plural";
import { api, type AppTheme } from "../lib/api";
import { btnStyle } from "../lib/appTheme";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The App Player's `form` block in edit mode: pick a record, see its values,
 *  change some, save. Only the fields this member can see and the kind takes
 *  are offered (GET /editable-fields), and the save is the one verb every
 *  door edits a record through (platform:update-fields), so the app can do no
 *  more than the member's own screen. */
export function AppEditForm({ slug, kind, only, theme }: { slug: string; kind: string; only?: string[]; theme?: AppTheme | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  // PRESS-ARGS: the picker and the field inputs below are the arguments; there is nothing else to ask.
  const run = useRunAction();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noun = kind.split(":")[1] ?? kind;

  const options = useQuery({ queryKey: ["app-editable-fields", slug, kind], queryFn: () => api.listEditableFields(slug, kind) });
  const found = useQuery({
    queryKey: ["app-edit-pick", slug, kind, q],
    queryFn: () => api.listEntities(slug, kind, q || undefined),
    enabled: !!options.data?.can_edit && !picked,
  });
  const record = useQuery({
    queryKey: ["app-record", slug, kind, picked],
    queryFn: () => api.lookupEntity(slug, kind, picked!),
    enabled: !!picked,
  });

  if (options.isLoading || !options.data?.can_edit) return null;
  const fields = options.data.fields.filter((f) => !only?.length || only.includes(f.name));
  if (!fields.length) return null;

  const current = (name: string) => (name in draft ? draft[name] : record.data?.fields[name]);
  const changed = fields.filter((f) => f.name in draft && !same(draft[f.name], record.data?.fields[f.name]));

  const save = async () => {
    if (!picked || busy) return;
    if (!changed.length) { setError("Change a field first."); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await run(
        { actionId: "platform:update-fields", entityKind: "", entityId: "", args: { kind, id: picked, fields: Object.fromEntries(changed.map((f) => [f.name, draft[f.name]])) } },
        { done: "Saved." },
      );
      const result = out.result as { ok?: boolean; error?: string; summary?: string };
      if (!result?.ok) throw new Error(result?.error ?? "That did not save.");
      toast.success(result.summary ?? "Saved.");
      setDraft({});
      void qc.invalidateQueries({ queryKey: ["app-record", slug, kind, picked] });
      void qc.invalidateQueries({ queryKey: ["app-view-data", slug] });
      void qc.invalidateQueries({ queryKey: ["app-stat-data", slug] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  };

  if (!picked) {
    return (
      <div className="space-y-2" data-testid="app-edit-form">
        <label className="block text-sm font-medium">
          Change {withArticle(noun)}
          <SearchInput
            value={q}
            onChange={setQ}
            size="lg"
            wrapperClassName="mt-1 w-full"
            placeholder={`Find ${withArticle(noun)}`}
            aria-label={`Find ${withArticle(noun)}`}
          />
        </label>
        <ul className="divide-y divide-line dark:divide-slate-800 rounded-md border border-line dark:border-slate-700">
          {(found.data?.items ?? []).slice(0, 8).map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => { setPicked(e.id); setDraft({}); setError(null); }} className="block min-h-[44px] w-full px-3 py-2 text-left text-sm hover:bg-subtle dark:hover:bg-slate-800">
                {e.title}
              </button>
            </li>
          ))}
          {found.isSuccess && found.data.items.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Nothing found.</li>}
        </ul>
      </div>
    );
  }

  if (record.isLoading || !record.data) return <p className="text-sm text-slate-500">Loading…</p>;
  const defs: PlatformFieldDef[] = fields.map((f) => ({ ...f, id: f.name, entity_kind: kind, position: 0, bundle_id: null }));
  return (
    <form
      className="space-y-3"
      data-testid="app-edit-form"
      onSubmit={(e) => { e.preventDefault(); void save(); }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{record.data.title}</h3>
        <button type="button" onClick={() => { setPicked(null); setDraft({}); setError(null); }} className="min-h-[44px] px-2 text-sm underline">
          Pick another
        </button>
      </div>
      <FieldPack
        items={defs.map((def) => ({
          need: fieldNeed(def.id, { control: fieldControl(def), label: def.display_label, choices: def.choices }),
          node: (
            <FieldValueEditor
              key={`${picked}:${def.name}`}
              draftOnly
              def={def}
              kind={kind}
              value={current(def.name)}
              onCommit={(v) => setDraft((d) => ({ ...d, [def.name]: v }))}
            />
          ),
        }))}
      />
      {error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="inline-flex min-h-[44px] items-center rounded-md bg-slate-700 px-4 text-sm font-medium text-mortar-50 transition hover:bg-slate-600 disabled:opacity-50"
        style={btnStyle(theme)}
      >
        {busy ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
