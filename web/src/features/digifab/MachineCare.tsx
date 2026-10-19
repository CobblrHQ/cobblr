import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MemberSelect, QueryError, RelationSelect, useRunAction, useToast, WorkspaceLink } from "@cobblr/platform-web";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { countOf } from "@cobblr/platform-contract/plural";
import { dayLabel } from "@cobblr/platform-contract/day";
import { fieldDay } from "@cobblr/platform-contract/field-day";
import { api } from "../../lib/api";
import { useDetailRoute } from "../../lib/useDetailRoute";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import type { EntityDetailPanelCtx } from "../../panels/types";
import { acknowledgeAlarm, readCare, readEscalation, saveEscalation, setReorderLevel, type Alarm, type Escalation, type Utilisation } from "./machine-care-api";
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
const input = "input w-full min-h-11";
const LEVEL = ["operators", "supervisors", "integrators"] as const;
const WINDOWS = [{ hours: 24, label: "Day" }, { hours: 7 * 24, label: "Week" }, { hours: 30 * 24, label: "Month" }] as const;
type Run = (w: () => Promise<unknown>, done?: string) => Promise<void>;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const hm = (s: number) => (s >= 3600 ? `${Math.round(s / 360) / 10} h` : `${Math.round(s / 60)} min`);

/** Any machine's alarms with their escalation, its observed use, the tools
 *  installed in it with their wear, and its spare parts. */
export function MachineCarePanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
 const { slug, entityId: machine } = ctx, qc = useQueryClient(), toast = useToast(), { activeOrg } = useActiveOrg();
 const admin = roleSatisfies(activeOrg?.role, ["admin"]);
 const [hours, setHours] = useState(24), [offset, setOffset] = useState(0), [busy, setBusy] = useState(false);
 const care = useQuery({ queryKey: ["machine-care", slug, machine, hours, offset], queryFn: () => readCare(slug, machine, hours, offset), refetchInterval: 30_000 });
 const run: Run = async (work, done) => { setBusy(true); try { await work(); if (done) toast.success(done); } catch (e) { toast.error(e instanceof Error ? e.message : "That did not go through."); } finally { setBusy(false); await qc.invalidateQueries({ queryKey: ["machine-care", slug, machine] }); await qc.invalidateQueries({ queryKey: ["machine-tools", slug, machine] }); } };
 if (care.isError) return <QueryError what="This machine's alarms and use could not be loaded." onRetry={() => void care.refetch()} />;
 if (!care.data) return <p className="text-sm text-muted">Loading alarms and use…</p>;
 return <section data-testid="machine-care" className="space-y-4 text-content">
  <Use u={care.data.utilisation} hours={hours} setHours={setHours} />
  <Alarms slug={slug} alarms={care.data.items} total={care.data.total} offset={offset} setOffset={setOffset} busy={busy} run={run} />
  {admin && <WhoIsTold slug={slug} busy={busy} run={run} />}
  <Tools slug={slug} machine={machine} admin={admin} busy={busy} run={run} />
  <Spares slug={slug} machine={machine} admin={admin} busy={busy} run={run} />
  <Licences slug={slug} machine={machine} admin={admin} busy={busy} run={run} />
 </section>;
}

function Use({ u, hours, setHours }: { u: Utilisation; hours: number; setHours: (h: number) => void }) {
 const seen = u.run_s + u.idle_s + u.fault_s + u.unknown_s;
 const parts = [["Running", u.run_s, "bg-green-500"], ["Idle", u.idle_s, "bg-slate-400"], ["In fault", u.fault_s, "bg-red-500"], ["State not said", u.unknown_s, "bg-amber-400"]] as const;
 return <section aria-label="Observed use" className="space-y-2"><div className="flex flex-wrap gap-2 items-center"><h4 className="flex-1 font-semibold">Observed use</h4>
  {WINDOWS.map(w => <button key={w.hours} className={button} aria-pressed={hours === w.hours} onClick={() => setHours(w.hours)}>{w.label}</button>)}</div>
  {seen === 0 ? <p className="text-sm text-muted">Not seen yet. It is sampled every minute while its bridge answers.</p> : <>
   <div className="flex h-4 w-full overflow-hidden rounded" role="img" aria-label={parts.map(([l, s]) => `${l} ${pct(s, seen)}%`).join(", ")}>{parts.map(([l, s, c]) => s > 0 && <div key={l} className={c} style={{ width: `${pct(s, seen)}%` }} />)}</div>
   <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">{parts.map(([l, s]) => <div key={l}><dt className="text-muted">{l}</dt><dd>{hm(s)} · {pct(s, seen)}%</dd></div>)}</dl>
  </>}
  <p className="text-sm" role="status">Seen {pct(seen, u.window_s)}% of the time since {new Date(u.since).toLocaleString()}{u.now ? `; now ${u.now.detail}` : ""}. Time it was not seen is left out, never guessed.</p>
  <p className="text-xs text-muted">OEE is not shown: it needs {u.oee.needs.join(", ")}, which are not kept yet.</p>
 </section>;
}

function Alarms({ slug, alarms, total, offset, setOffset, busy, run }: { slug: string; alarms: Alarm[]; total: number; offset: number; setOffset: (n: number) => void; busy: boolean; run: Run }) {
 const [note, setNote] = useState("");
 return <section aria-label="Alarms" className="space-y-2"><h4 className="font-semibold">Alarms</h4>
  {alarms.length === 0 ? <p className="text-sm text-muted">No alarms.</p> : <ol className="space-y-2">{alarms.map(a => <li key={a.id} data-testid="machine-alarm" className="rounded border border-line p-2 text-sm space-y-1">
   <p className="break-words"><span className="font-semibold">{a.code}</span> {a.text}</p>
   <p className="text-muted break-words">{new Date(a.occurred_at).toLocaleString()}{a.program ? ` · ${a.program}` : ""}{a.step ? ` · ${a.step}` : ""}</p>
   {a.camera_file_id && <WorkspaceLink className="text-accent" slug={slug} to={`/files/${a.camera_file_id}`}>What the camera saw</WorkspaceLink>}
   {a.acknowledged_at ? <p role="status">Acknowledged {new Date(a.acknowledged_at).toLocaleString()}{a.note ? `: ${a.note}` : ""}</p> : a.severity === "info" ? null : <div className="flex flex-wrap gap-2 items-end">
    <p role="status" className="w-full">Not acknowledged: the {LEVEL[a.escalation_level] ?? "integrators"} have been told.</p>
    <label className="flex-1 min-w-0">What you are doing<input className={input} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label>
    <button className={button} disabled={busy} onClick={() => void run(async () => { await acknowledgeAlarm(slug, a.id, note); setNote(""); }, "Acknowledged. No one further is told.")}>I have it</button></div>}
  </li>)}</ol>}
  {total > 20 && <nav aria-label="Alarm pages" className="flex flex-wrap gap-3"><button className={button} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Newer alarms</button><span className="py-3">{offset + 1}–{Math.min(offset + 20, total)} of {total}</span><button className={button} disabled={offset + 20 >= total} onClick={() => setOffset(offset + 20)}>Older alarms</button></nav>}
 </section>;
}

function WhoIsTold({ slug, busy, run }: { slug: string; busy: boolean; run: Run }) {
 const q = useQuery({ queryKey: ["alarm-escalation", slug], queryFn: () => readEscalation(slug) });
 const [draft, setDraft] = useState<Escalation | null>(null);
 const e = draft ?? q.data;
 if (!e) return null;
 const set = (patch: Partial<Escalation>) => setDraft({ ...e, ...patch });
 return <details className="text-sm"><summary className="min-h-11 cursor-pointer flex items-center font-semibold">Who is told about alarms, for every machine</summary>
  <div className="space-y-3 pt-2">
   {LEVEL.map(level => <div key={level} className="space-y-1"><p className="font-semibold capitalize">{level}</p>
    {e[level].map((p, i) => <div key={i} className="flex gap-2 items-center"><MemberSelect label={`${level} ${i + 1}`} className="flex-1 min-h-11" value={p} onChange={v => set({ [level]: e[level].map((x, j) => (j === i ? v ?? "" : x)) } as Partial<Escalation>)} /><button className={button} onClick={() => set({ [level]: e[level].filter((_, j) => j !== i) } as Partial<Escalation>)}>Remove</button></div>)}
    <button className={button} onClick={() => set({ [level]: [...e[level], ""] } as Partial<Escalation>)}>Add to the {level}</button></div>)}
   <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
    <label>Supervisors after (minutes)<input className={input} inputMode="numeric" value={e.supervisor_after_minutes} onChange={ev => set({ supervisor_after_minutes: Number(ev.target.value.replace(/\D/g, "")) || 1 })} /></label>
    <label>Integrators after (minutes)<input className={input} inputMode="numeric" value={e.integrator_after_minutes} onChange={ev => set({ integrator_after_minutes: Number(ev.target.value.replace(/\D/g, "")) || 1 })} /></label>
   </div>
   <button className={button} disabled={busy || !draft} onClick={() => void run(async () => { await saveEscalation(slug, { ...e, operators: e.operators.filter(Boolean), supervisors: e.supervisors.filter(Boolean), integrators: e.integrators.filter(Boolean) }); setDraft(null); }, "Saved who is told about alarms.")}>Save who is told</button>
  </div>
 </details>;
}

function Tools({ slug, machine, admin, busy, run }: { slug: string; machine: string; admin: boolean; busy: boolean; run: Run }) {
 const q = useQuery({ queryKey: ["machine-tools", slug, machine], queryFn: () => api.placementContents(slug, "machines:machine", machine) });
 // PRESS-ARGS: Take off needs only the tool, and Install names the container kind and id itself
 const [tool, setTool] = useState<string | null>(null), route = useDetailRoute(slug), runAction = useRunAction();
 const tools = (q.data?.items ?? []).filter(t => t.kind === "assets:asset");
 return <section aria-label="Tools in this machine" className="space-y-2"><h4 className="font-semibold">Tools in this machine</h4>
  <p className="text-sm text-muted">A gripper, suction cups or a nozzle installed here counts this machine's cycles, prints and hours as its own wear. Set a service by its use on the tool's own page (replace the suction cups every 200,000 cycles in use).</p>
  {tools.length === 0 ? <p className="text-sm text-muted">No tools installed.</p> : <ul className="space-y-1">{tools.map(t => {
   const m = ((t.fields?.metadata ?? {}) as Record<string, unknown>);
   const used = [["used_cycles", "cycle"], ["used_prints", "print"], ["used_hours", "hour"]].filter(([k]) => Number(m[k!] ?? 0) > 0).map(([k, w]) => countOf(Math.round(Number(m[k!])), w!)).join(", ");
   return <li key={t.id} className="flex flex-wrap gap-2 items-center text-sm"><WorkspaceLink slug={slug} to={route(t.kind, t.id) ?? "/assets"} className="underline">{t.title}</WorkspaceLink><span className="text-muted">{used ? `${used} in use` : "no use counted yet"}</span>
    {admin && <button className={button} disabled={busy} onClick={() => void run(() => runAction({ actionId: "core-placement:remove", entityKind: t.kind, entityId: t.id, args: {} }), `Took ${t.title} off this machine.`)}>Take off</button>}</li>;
  })}</ul>}
  {admin && <div className="flex flex-wrap gap-2 items-center"><RelationSelect label="Tool to install" refKind="assets:asset" className="flex-1 min-h-11" value={tool} onChange={setTool} />
   <button className={button} disabled={busy || !tool} onClick={() => void run(async () => {
    // action-press-asks-first: core-placement:place takes the container's kind and id, both given here
    await runAction({ actionId: "core-placement:place", entityKind: "assets:asset", entityId: tool!, args: { container_kind: "machines:machine", container_id: machine } }); setTool(null);
   }, "Installed the tool on this machine.")}>Install on this machine</button></div>}
 </section>;
}

function Spares({ slug, machine, admin, busy, run }: { slug: string; machine: string; admin: boolean; busy: boolean; run: Run }) {
 const links = useQuery({ queryKey: ["machine-spares", slug, machine], queryFn: () => api.recordLinks(slug, "machines:machine", machine) });
 const spares = (links.data?.items ?? []).filter(l => l.relationship_kind === "spare-for" && l.source_kind === "inventory:part");
 const [part, setPart] = useState<string | null>(null);
 return <section aria-label="Spare parts" className="space-y-2"><h4 className="font-semibold">Spare parts</h4>
  {spares.length === 0 ? <p className="text-sm text-muted">No spare parts linked.</p> : <ul className="space-y-2">{spares.map(l => <Spare key={l.id} slug={slug} link={l} admin={admin} busy={busy} run={run} />)}</ul>}
  {admin && <div className="flex flex-wrap gap-2 items-center"><RelationSelect label="Spare part to link" refKind="inventory:part" className="flex-1 min-h-11" value={part} onChange={setPart} />
   <button className={button} disabled={busy || !part} onClick={() => void run(async () => { await api.createPairing(slug, { source_kind: "inventory:part", source_id: part!, target_kind: "machines:machine", target_id: machine, relationship_kind: "spare-for" }); setPart(null); await links.refetch(); }, "Linked the spare part.")}>Link as a spare</button></div>}
 </section>;
}
function Spare({ slug, link, admin, busy, run }: { slug: string; link: { id: string; source_id: string }; admin: boolean; busy: boolean; run: Run }) {
 const q = useQuery({ queryKey: ["spare-part", slug, link.source_id], queryFn: () => api.lookupEntity(slug, "inventory:part", link.source_id) });
 const f = (q.data?.fields ?? {}) as { qty?: unknown; min_qty?: unknown };
 const qty = Number(f.qty ?? 0), min = f.min_qty == null ? null : Number(f.min_qty);
 const [level, setLevel] = useState<string>(min == null ? "" : String(min)), route = useDetailRoute(slug);
 const low = min !== null && qty <= min;
 return <li className="rounded border border-line p-2 text-sm space-y-1">
  <p className="break-words"><WorkspaceLink slug={slug} to={route("inventory:part", link.source_id) ?? "/inventory"} className="underline">{q.data?.title ?? "A part"}</WorkspaceLink> · {qty} on hand{min !== null ? ` · reorder at ${min}` : ""}{low ? " · low: it goes on the shopping list" : ""}</p>
  {admin && <div className="flex flex-wrap gap-2 items-end"><label>Reorder when at or below<input className={input} inputMode="decimal" value={level} onChange={e => setLevel(e.target.value.replace(/[^\d.]/g, ""))} /></label>
   <button className={button} disabled={busy} onClick={() => void run(async () => { await setReorderLevel(slug, link.source_id, level === "" ? null : Number(level)); await q.refetch(); }, "Saved the reorder level.")}>Save reorder level</button>
   <button className={button} disabled={busy} onClick={() => void run(() => api.deletePairing(slug, link.id), "Unlinked the spare part.")}>Unlink</button></div>}
 </li>;
}

/** Licences and controller options on this machine (a FANUC option, a
 *  URCap): records of Licences & subscriptions linked as installed on it. */
function Licences({ slug, machine, admin, busy, run }: { slug: string; machine: string; admin: boolean; busy: boolean; run: Run }) {
 const links = useQuery({ queryKey: ["machine-licences", slug, machine], queryFn: () => api.recordLinks(slug, "machines:machine", machine) });
 const licences = (links.data?.items ?? []).filter(l => l.relationship_kind === "installed-on" && l.target_id === machine && l.source_kind.startsWith(LICENCES));
 const [licence, setLicence] = useState<string | null>(null);
 return <section aria-label="Licences and options" className="space-y-2"><h4 className="font-semibold">Licences and options</h4>
  {licences.length === 0 ? <p className="text-sm text-muted">No licences linked. Link a licence, a controller option or a software add-on kept in Licences and subscriptions.</p> : <ul className="space-y-1">{licences.map(l => <Licence key={l.id} slug={slug} id={l.source_id} kind={l.source_kind} link={l.id} admin={admin} busy={busy} run={run} />)}</ul>}
  {admin && <div className="flex flex-wrap gap-2 items-center"><RelationSelect label="Licence to link" refKind={`${LICENCES}:item`} className="flex-1 min-h-11" value={licence} onChange={setLicence} />
   <button className={button} disabled={busy || !licence} onClick={() => void run(async () => { await api.createPairing(slug, { source_kind: `${LICENCES}:item`, source_id: licence!, target_kind: "machines:machine", target_id: machine, relationship_kind: "installed-on" }); setLicence(null); await links.refetch(); }, "Linked the licence to this machine.")}>Link to this machine</button></div>}
 </section>;
}
const LICENCES = "subscriptions";
function Licence({ slug, id, kind, link, admin, busy, run }: { slug: string; id: string; kind: string; link: string; admin: boolean; busy: boolean; run: Run }) {
 const q = useQuery({ queryKey: ["licence", slug, id], queryFn: () => api.lookupEntity(slug, kind, id) });
 const route = useDetailRoute(slug);
 const renews = fieldDay((q.data?.fields as { renewal_date?: unknown } | undefined)?.renewal_date);
 return <li className="flex flex-wrap gap-2 items-center text-sm"><WorkspaceLink slug={slug} to={route(kind, id) ?? "/"} className="underline">{q.data?.title ?? "A licence"}</WorkspaceLink>{renews ? <span className="text-muted">renews {dayLabel(renews)}</span> : null}
  {admin && <button className={button} disabled={busy} onClick={() => void run(() => api.deletePairing(slug, link), "Unlinked the licence.")}>Unlink</button>}</li>;
}
