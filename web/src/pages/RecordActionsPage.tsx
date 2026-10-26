import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ACTION_GROUPS, type RecordActionLayout } from "@cobblr/platform-contract/action-groups";
import { firstActionSentence, usePageTitle, useRunAction, useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, type PlatformEntityKind } from "../lib/api";
import { arrangePanels, type RecordPanelLayout } from "@cobblr/platform-contract/record-panel-layout";
import { randomId } from "@cobblr/platform-contract/random-id";

export function RecordActionsPage() {
  usePageTitle("Record actions and panels");
  const { activeSlug } = useActiveOrg();
  const kinds = useQuery({ queryKey: ["entity-kinds", activeSlug], queryFn: () => api.listEntityKinds(activeSlug) });
  const [kind, setKind] = useState("");
  return <div className="space-y-6">
    <p className="text-sm text-muted">Personal pins belong to each person and follow them across devices.</p>
    <label className="block space-y-1"><span className="text-sm text-content">Kind of record</span><select className="w-full rounded-lg border border-line bg-surface p-2 text-content" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Choose a kind</option>{kinds.data?.items.map((k) => <option key={k.id} value={k.id}>{k.display_name_plural ?? k.display_name}</option>)}</select></label>
    {kind && kinds.data && <PanelArrangement key={`panels:${activeSlug}:${kind}`} kind={kind} kinds={kinds.data.items} />}
    {kind && <LayoutEditor key={`${activeSlug}:${kind}`} kind={kind} />}
  </div>;
}

/** The panels on this kind of record: hide the ones it does not need and put
 *  the rest in order (#6337). Lists the panels that can apply to it: aimed at
 *  its kind (or its collection's base kind, or every kind), and, when a panel
 *  names its collections, this one among them or shown where its data is. */
function PanelArrangement({ kind, kinds }: { kind: string; kinds: PlatformEntityKind[] }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  // PRESS-ARGS: the editor supplies the kind, the complete arrangement and the revision it opened.
  const run = useRunAction();
  const k = kinds.find((x) => x.id === kind);
  // registry-filter-ok: a collection's panels aim at its module's own kinds, the ones without an instance.
  const targets = new Set(["*", kind, ...(k?.instance_name ? kinds.filter((x) => x.module_name === k.module_name && !x.instance_name).map((x) => x.id) : [])]);
  const modules = useQuery({ queryKey: ["org-modules", activeSlug], queryFn: () => api.orgModules(activeSlug) });
  const current = useQuery({ queryKey: ["record-panel-layout", activeSlug, kind], queryFn: () => api.recordPanelLayout(activeSlug, kind) });
  const [draft, setDraft] = useState<RecordPanelLayout | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (current.data && !draft) { setDraft(structuredClone(current.data.layout)); setRevision(current.data.revision); } }, [current.data, draft]);
  if (current.isError || modules.isError) return <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">Panels could not be loaded. Refresh to try again.</p>;
  if (!draft || !modules.data) return <p className="text-sm text-muted">Loading panels…</p>;
  // registry-filter-ok: a panel that names collections applies to this kind only when it is one of them.
  const applies = modules.data.items
    .filter((m) => m.enabled)
    .flatMap((m) => m.panels ?? [])
    .filter((p) => p.surface === "entity-detail-panel" && targets.has(p.target))
    .filter((p) => !p.collections?.length || p.presence || (k?.instance_name ? p.collections.includes(k.instance_name) : false));
  const ordered = arrangePanels(applies, { panels: Object.fromEntries(Object.entries(draft.panels).map(([id, c]) => [id, { order: c.order }])) });
  const move = (index: number, by: number) => {
    const ids = ordered.map((p) => p.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id!);
    const panels = { ...draft.panels };
    ids.forEach((pid, i) => { panels[pid] = { ...panels[pid], order: i }; });
    setDraft({ panels });
  };
  const setHidden = (id: string, hidden: boolean) => setDraft({ panels: { ...draft.panels, [id]: { ...draft.panels[id], hidden } } });
  const save = async () => {
    setBusy(true);
    try {
      const response = await run({ actionId: "platform:arrange-record-panels", args: { kind, layout: draft, expected_revision: revision } }, { undo: "shown-here" });
      const result = response.result as { ok?: boolean; error?: string; data?: { revision: number; before: RecordPanelLayout } };
      if (!result.ok) throw new Error(result.error ?? "The panels could not be saved.");
      setRevision(result.data!.revision);
      await qc.invalidateQueries({ queryKey: ["record-panel-layout", activeSlug] });
      toast.action("Panels saved.", { actionLabel: "Undo", onAction: async () => {
        // OWN-WAY-BACK: expected_revision refuses it once anyone saved the panels since, this Undo included.
        const undone = await run({ actionId: "platform:arrange-record-panels", args: { kind, layout: result.data!.before, expected_revision: result.data!.revision } }, { undo: "is-undo" });
        const back = undone.result as { ok?: boolean; error?: string; data?: { revision: number } };
        if (!back.ok) { toast.error(back.error ?? "The panels could not be restored."); return; }
        setDraft(result.data!.before); setRevision(back.data!.revision);
        await qc.invalidateQueries({ queryKey: ["record-panel-layout", activeSlug] });
      } });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return <section className="space-y-3" data-testid="record-panels">
    <h2 className="text-sm font-semibold text-content">Panels</h2>
    <p className="text-xs text-muted">The panels under a record's details. Hide the ones this kind does not need and put the rest in the order you want them.</p>
    {applies.length === 0 ? <p className="text-sm text-muted">No panels apply to this kind of record.</p> : <ul className="space-y-2">{ordered.map((p, index) => <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
      <span className="min-w-0 flex-1 text-sm text-content">{p.title}</span>
      <label className="flex min-h-11 items-center gap-2 text-sm text-content"><input type="checkbox" checked={draft.panels[p.id]?.hidden ?? false} onChange={(e) => setHidden(p.id, e.target.checked)} />Hide</label>
      <button type="button" aria-label={`Move ${p.title} up`} disabled={!index} className="min-h-11 min-w-11 rounded border border-line px-3 text-sm disabled:opacity-30" onClick={() => move(index, -1)}>↑</button>
      <button type="button" aria-label={`Move ${p.title} down`} disabled={index === ordered.length - 1} className="min-h-11 min-w-11 rounded border border-line px-3 text-sm disabled:opacity-30" onClick={() => move(index, 1)}>↓</button>
    </li>)}</ul>}
    <button type="button" disabled={busy || applies.length === 0} onClick={() => void save()} className="min-h-11 rounded-lg bg-cobble-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? "Saving…" : "Save panels"}</button>
  </section>;
}
function LayoutEditor({ kind }: { kind: string }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  // PRESS-ARGS: the editor supplies the kind, complete layout and the revision it opened.
  const run = useRunAction();
  const current = useQuery({ queryKey: ["record-action-layout", activeSlug, kind], queryFn: () => api.recordActionLayout(activeSlug, kind) });
  const actions = useQuery({ queryKey: ["platform-actions", activeSlug, kind], queryFn: () => api.listActions(activeSlug, kind) });
  const [draft, setDraft] = useState<RecordActionLayout | null>(null);
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (current.data && !draft) { setDraft(structuredClone(current.data.layout)); setRevision(current.data.revision); } }, [current.data, draft]);
  if (current.isError || actions.isError) return <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">Record actions could not be loaded. Refresh to try again.</p>;
  if (!draft || !actions.data) return <p className="text-sm text-muted">Loading record actions…</p>;
  const groups = new Map<string, { id: string; label: string; order: number }>(ACTION_GROUPS.map((g) => [g.id, g]));
  for (const g of draft.groups) groups.set(g.id, g);
  const ordered = [...groups.values()].sort((a, b) => a.order - b.order);
  const setGroup = (id: string, change: { label?: string; order?: number }) => setDraft({ ...draft, groups: [...draft.groups.filter((g) => g.id !== id), { ...groups.get(id)!, ...change }] });
  const setAction = (id: string, change: { group?: string; hidden?: boolean; primary?: boolean }) => setDraft({ ...draft, actions: { ...draft.actions, [id]: { ...draft.actions[id], ...change } } });
  const bound = new Set(actions.data.bindings.map((a) => a.action_id));
  const entries = [...actions.data.bindings.map((a) => ({ ...a, id: a.action_id })), ...actions.data.items.filter((a) => !bound.has(a.id) && a.user_invokable !== false), ...(actions.data.dormant ?? [])];
  const platformItems = [
    { id: "record:share-with", label: "Share with…", description: "Choose who can see this record.", group: "share", primary: false },
    { id: "record:public", label: "Public pages", description: "See which public pages show this record.", group: "share", primary: false },
    { id: "record:send-back", label: "Send back", description: "Return a received thing to its previous owner.", group: "share", primary: false },
    ...(actions.data.lifecycle ? [
      { id: "record:mark-gone", label: "No longer mine…", description: "Record how it left your things.", group: "lifecycle", primary: false },
      { id: "record:bring-back", label: "Bring back", description: "Return it to your active things.", group: "lifecycle", primary: false },
      { id: "record:give-to", label: "Give to…", description: "Offer it to someone else.", group: "share", primary: false },
      { id: "record:withdraw-offer", label: "Withdraw offer", description: "Cancel before they take it.", group: "share", primary: false },
    ] : []),
  ];
  const save = async () => {
    setBusy(true);
    try {
      const response = await run({ actionId: "platform:edit-record-actions", args: { kind, layout: draft, expected_revision: revision } }, { undo: "shown-here" });
      const result = response.result as { ok?: boolean; error?: string; data?: { revision: number; before: RecordActionLayout } };
      if (!result.ok) throw new Error(result.error ?? "The arrangement could not be saved.");
      setRevision(result.data!.revision);
      await qc.invalidateQueries({ queryKey: ["platform-actions", activeSlug, kind] });
      await qc.invalidateQueries({ queryKey: ["record-action-layout", activeSlug, kind] });
      toast.action("Record actions saved.", { actionLabel: "Undo", onAction: async () => {
        // OWN-WAY-BACK: expected_revision refuses it once anyone saved the actions since, this Undo included.
        const undone = await run({ actionId: "platform:edit-record-actions", args: { kind, layout: result.data!.before, expected_revision: result.data!.revision } }, { undo: "is-undo" });
        const back = undone.result as { ok?: boolean; error?: string; data?: { revision: number } };
        if (!back.ok) { toast.error(back.error ?? "The arrangement could not be restored."); return; }
        setDraft(result.data!.before); setRevision(back.data!.revision);
        await qc.invalidateQueries({ queryKey: ["platform-actions", activeSlug, kind] });
        await qc.invalidateQueries({ queryKey: ["record-action-layout", activeSlug, kind] });
      } });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="space-y-6">
    <section className="space-y-3"><h2 className="text-sm font-semibold text-content">Groups</h2>{ordered.map((g, index) => <div key={g.id} className="flex items-center gap-2">
      <input aria-label={`Name for ${g.label}`} className="min-w-0 flex-1 rounded border border-line bg-surface p-2 text-sm text-content" value={g.label} onChange={(e) => setGroup(g.id, { label: e.target.value })} />
      <button type="button" aria-label={`Move ${g.label} up`} disabled={!index} className="rounded border border-line px-3 py-2 text-sm disabled:opacity-30" onClick={() => { setDraft({ ...draft, groups: ordered.map((item, n) => ({ ...item, order: n === index ? index - 1 : n === index - 1 ? index : n })) }); }}>↑</button>
      <button type="button" aria-label={`Move ${g.label} down`} disabled={index === ordered.length - 1} className="rounded border border-line px-3 py-2 text-sm disabled:opacity-30" onClick={() => setDraft({ ...draft, groups: ordered.map((item, n) => ({ ...item, order: n === index ? index + 1 : n === index + 1 ? index : n })) })}>↓</button>
    </div>)}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const label = name.trim(); if (!label) return; const id = `workspace:${randomId()}`; setDraft({ ...draft, groups: [...draft.groups, { id, label, order: ordered.length + 100 }] }); setName(""); }}><input aria-label="New group name" placeholder="Show prep" className="min-w-0 flex-1 rounded border border-line bg-surface p-2 text-sm text-content" value={name} onChange={(e) => setName(e.target.value)} /><button type="submit" className="rounded border border-line px-3 py-2 text-sm text-content">Add group</button></form>
    </section>
    <section className="space-y-3"><h2 className="text-sm font-semibold text-content">Actions</h2><p className="text-xs text-muted">Up to four primary actions stay on the bar. Extra primaries stay in their menus. Actions appear only when they apply to the record.</p>{[...entries, ...platformItems].map((a) => <fieldset key={a.id} className="min-w-0 space-y-2 rounded-lg border border-line p-3"><legend className="px-1 text-sm font-medium text-content">{a.label}</legend><p className="text-xs text-muted">{firstActionSentence(a.description ?? "")}</p><label className="block"><span className="text-xs text-muted">Group</span><select aria-label={`Group for ${a.label}`} className="ml-2 max-w-full rounded border border-line bg-surface p-2 text-sm text-content" value={draft.actions[a.id]?.group ?? a.group ?? "more"} onChange={(e) => setAction(a.id, { group: e.target.value })}>{ordered.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label><div className="flex flex-wrap gap-4"><label className="flex items-center gap-2 text-sm text-content"><input type="checkbox" checked={draft.actions[a.id]?.primary ?? a.primary ?? false} onChange={(e) => setAction(a.id, { primary: e.target.checked })} />Primary</label><label className="flex items-center gap-2 text-sm text-content"><input type="checkbox" checked={draft.actions[a.id]?.hidden ?? false} onChange={(e) => setAction(a.id, { hidden: e.target.checked })} />Hide</label></div></fieldset>)}</section>
    <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-cobble-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? "Saving…" : "Save record actions"}</button>
  </div>;
}
