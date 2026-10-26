// What a share shows: which records (the scope) and what of them (the
// visibility), the same two definitions a public page reads
// (@cobblr/platform-contract/share-scope). Every "what's shared" toggle starts
// off; the count under the rules is the live answer to "which records".

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useToast, SegmentedChoice, QueryError } from "@cobblr/platform-web";
import { EMPTY_SCOPE, VISIBILITY_NONE, type ScopeDef, type ScopeRule, type VisibilityDef } from "@cobblr/platform-contract/share-scope";
import { api, type ShareEditMode } from "../lib/api";

const TOGGLES: Array<{ key: "prices" | "private_notes" | "places"; label: string; hint: string }> = [
  { key: "prices", label: "Prices and costs", hint: "What things cost, sold for or are worth." },
  { key: "private_notes", label: "Private notes", hint: "Notes, and every field you marked private." },
  { key: "places", label: "Places", hint: "Where things are, as places they can browse. Off: the place is shown as text." },
];

const EDIT_MODES: Array<{ key: ShareEditMode; label: string; hint: (who: string) => string }> = [
  { key: "suggest", label: "You review it first", hint: (who) => `${who}'s edits wait for you to accept or reject them.` },
  { key: "direct", label: "It changes your record", hint: (who) => `For someone you trust: ${who}'s edits apply at once, in your history under their name, and you can undo each one.` },
];

/** What a share shows. */
export function ShareWhatEditor({ slug, linkId, who, onDone }: { slug: string; linkId: string; who: string; onDone: () => void }) {
  return (
    <ScopeEditor
      slug={slug}
      who={who}
      onDone={onDone}
      source={{
        key: ["share-what", slug, linkId],
        load: () => api.getShareWhat(slug, linkId),
        save: async (b) => (await api.putShareWhat(slug, linkId, b)).preview.count,
        previewLinkId: linkId,
        editMode: true,
        saved: (n) => `Sharing ${n} thing${n === 1 ? "" : "s"} with ${who}.`,
        refresh: [["share-links", slug]],
      }}
    />
  );
}

export interface ScopeEditorSource {
  key: unknown[];
  load: () => Promise<{ scope: ScopeDef; visibility: VisibilityDef; gated_fields: Array<{ name: string; label: string }>; person?: { id: string; name: string } | null; edit_mode?: ShareEditMode }>;
  /** Save, answering how many records it now selects. */
  save: (b: { scope: ScopeDef; visibility: VisibilityDef; edit_mode: ShareEditMode }) => Promise<number>;
  previewLinkId?: string;
  /** A share asks how the other person's edits come back; a page has none. */
  editMode: boolean;
  saved: (count: number) => string;
  refresh: unknown[][];
}

/** Which records and what of them: one editor for a share and a public
 *  page, because they are one definition (share-scope.md). */
export function ScopeEditor({ slug, who, onDone, source }: { slug: string; who: string; onDone: () => void; source: ScopeEditorSource }) {
  const qc = useQueryClient();
  const toast = useToast();
  const what = useQuery({ queryKey: source.key, queryFn: source.load });
  const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), staleTime: 60_000 });
  const [scope, setScope] = useState<ScopeDef>(EMPTY_SCOPE);
  const [vis, setVis] = useState<VisibilityDef>(VISIBILITY_NONE);
  const [mode, setMode] = useState<ShareEditMode>("suggest");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (what.data && !loaded) {
      setScope(what.data.scope);
      setVis(what.data.visibility);
      setMode(what.data.edit_mode ?? "suggest");
      setLoaded(true);
    }
  }, [what.data, loaded]);
  const scopeKey = useMemo(() => JSON.stringify(scope), [scope]);
  const preview = useQuery({
    queryKey: ["scope-preview", slug, scopeKey],
    queryFn: () => api.previewScope(slug, scope, source.previewLinkId),
    enabled: loaded,
    staleTime: 10_000,
  });
  const save = useMutation({
    mutationFn: () => source.save({ scope, visibility: vis, edit_mode: mode }),
    onSuccess: (count) => {
      toast.success(source.saved(count));
      void qc.invalidateQueries({ queryKey: source.key });
      for (const k of source.refresh) void qc.invalidateQueries({ queryKey: k });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const kindName = (id: string) => kinds.data?.items.find((k) => k.id === id)?.display_name_plural ?? kinds.data?.items.find((k) => k.id === id)?.display_name ?? id;
  const setRules = (rules: ScopeRule[]) => setScope({ ...scope, rules });

  if (what.isError) return <QueryError what="what's shared" onRetry={() => void what.refetch()} />;
  if (!what.data) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="space-y-4" data-testid="share-what">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-content">Which things</h3>
        {scope.rules.length === 0 && scope.picks.length === 0 && <p className="text-sm text-muted">Nothing yet. Add a collection, or things whose field says something.</p>}
        <ul className="space-y-1">
          {scope.rules.map((r, i) => (
            <li key={i} className="flex items-center gap-2 rounded border border-line px-2 py-1 text-sm dark:border-slate-600" data-testid="share-rule">
              <span className="min-w-0 flex-1">{r.type === "collection" ? `All ${kindName(r.entity_kind)}` : `${kindName(r.entity_kind)} whose ${r.field} is "${r.equals}"`}</span>
              <button title="Remove" type="button" aria-label="Remove" onClick={() => setRules(scope.rules.filter((_, j) => j !== i))} className="text-muted hover:text-ember-600">
                <X size={14} />
              </button>
            </li>
          ))}
          {scope.picks.length > 0 && (
            <li className="flex items-center gap-2 rounded border border-line px-2 py-1 text-sm dark:border-slate-600">
              <span className="min-w-0 flex-1">{scope.picks.length} picked one by one</span>
              <button title="Remove" type="button" aria-label="Remove" onClick={() => setScope({ ...scope, picks: [] })} className="text-muted hover:text-ember-600">
                <X size={14} />
              </button>
            </li>
          )}
        </ul>
        <AddRule kinds={kinds.data?.items ?? []} onAdd={(r) => setRules([...scope.rules, r])} slug={slug} />
        {what.data.person && (
          <label className="flex items-start gap-2 text-sm text-content">
            <input type="checkbox" data-testid="share-lent" checked={scope.lent_to_them} onChange={(e) => setScope({ ...scope, lent_to_them: e.target.checked })} className="mt-1 accent-cobble-500" />
            <span>
              What you lend to {what.data.person.name}
              <span className="block text-xs text-muted">A thing you lend them is shared until it comes back.</span>
            </span>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm text-content">
          <input type="checkbox" checked={scope.with_contents} onChange={(e) => setScope({ ...scope, with_contents: e.target.checked })} className="accent-cobble-500" />
          With what is inside them
        </label>
        {preview.isError ? <QueryError what="the matching things" onRetry={() => void preview.refetch()} /> : (
          <p className="text-sm text-content" data-testid="share-what-count">
            {!preview.data ? "Counting…" : `${preview.data.count}${!preview.data.complete ? "+" : ""} thing${preview.data.count === 1 ? "" : "s"} match`}
            {preview.data?.sample.length ? <span className="text-muted">: {preview.data.sample.map((x) => x.title).join(", ")}{(preview.data.count ?? 0) > preview.data.sample.length ? ", …" : ""}</span> : null}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-content">What {who} sees of them</h3>
        <p className="text-xs text-muted">Names, photos and the other fields are always shared. These stay off until you turn them on.</p>
        {TOGGLES.map((t) => (
          <label key={t.key} className="flex items-start gap-2 text-sm text-content">
            <input type="checkbox" data-testid={`share-show-${t.key}`} checked={vis[t.key]} onChange={(e) => setVis({ ...vis, [t.key]: e.target.checked })} className="mt-1 accent-cobble-500" />
            <span>
              {t.label}
              <span className="block text-xs text-muted">{t.hint}</span>
            </span>
          </label>
        ))}
        {what.data.gated_fields.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm text-content">Restricted fields, one by one</p>
            {what.data.gated_fields.map((f) => (
              <label key={f.name} className="flex items-center gap-2 text-sm text-content">
                <input
                  type="checkbox"
                  checked={vis.restricted.includes(f.name)}
                  onChange={(e) => setVis({ ...vis, restricted: e.target.checked ? [...vis.restricted, f.name] : vis.restricted.filter((x) => x !== f.name) })}
                  className="accent-cobble-500"
                />
                {f.label}
              </label>
            ))}
          </div>
        )}
      </section>

      {source.editMode && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-content">When {who} changes something</h3>
          <SegmentedChoice
            stack
            label={`When ${who} changes something`}
            value={mode}
            onChange={setMode}
            options={EDIT_MODES.map((m) => ({ value: m.key, label: m.label, hint: m.hint(who), testId: `share-edit-${m.key}` }))}
          />
        </section>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-lg px-3 py-2 text-sm text-muted hover:text-content">
          Cancel
        </button>
        <button type="button" data-testid="share-what-save" disabled={save.isPending} onClick={() => save.mutate()} className="rounded-lg bg-cobble-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function AddRule({ kinds, slug, onAdd }: { kinds: Array<{ id: string; display_name: string; display_name_plural: string | null }>; slug: string; onAdd: (r: ScopeRule) => void }) {
  const [kind, setKind] = useState("");
  const [field, setField] = useState("");
  const [equals, setEquals] = useState("");
  const defs = useQuery({ queryKey: ["platform-field-defs", slug, kind, "effective"], queryFn: () => api.listFieldDefs(slug, kind, true), enabled: !!kind });
  const box = "rounded-lg border border-line bg-surface px-2 py-1.5 text-base sm:text-sm text-content dark:border-slate-600";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Collection" data-testid="share-rule-kind" value={kind} onChange={(e) => { setKind(e.target.value); setField(""); }} className={box}>
        <option value="">Choose a collection…</option>
        {kinds.map((k) => (
          <option key={k.id} value={k.id}>
            {k.display_name_plural ?? k.display_name}
          </option>
        ))}
      </select>
      {kind && (
        <>
          <select aria-label="Only where" value={field} onChange={(e) => setField(e.target.value)} className={box}>
            <option value="">all of them</option>
            {(defs.data?.items ?? []).map((d) => (
              <option key={d.name} value={d.name}>
                where {d.display_label} is
              </option>
            ))}
          </select>
          {field && <input aria-label="Value" value={equals} onChange={(e) => setEquals(e.target.value)} placeholder="a value" className={box} />}
          <button
            type="button"
            data-testid="share-rule-add"
            disabled={!!field && !equals.trim()}
            onClick={() => {
              onAdd(field ? { type: "field", entity_kind: kind, field, equals: equals.trim() } : { type: "collection", entity_kind: kind });
              setKind("");
              setField("");
              setEquals("");
            }}
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-sm text-muted hover:text-accent dark:border-slate-600 disabled:opacity-50"
          >
            <Plus size={14} /> Add
          </button>
        </>
      )}
    </div>
  );
}
