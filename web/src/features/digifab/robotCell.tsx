import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MemberSelect, productName, QueryError, RelationSelect, useToast, WorkspaceLink } from "@cobblr/platform-web";
import type { CellStep } from "@cobblr/platform-contract/robot-cell";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { api } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import type { EntityDetailPanelCtx } from "../../panels/types";
import { readArm } from "./robot-arm-api";
import { SafetyBoundaryLink } from "../../pages/RobotSafetyPage";
import { endCellJob, readCell, resumeCellJob, saveDefinition, setOperators, setOutput, setupCell, startCellJob, stopCellJob, type CellDefinition, type CellJob, type CellKind, type CellView, type MemberInput } from "./robot-cell-api";
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
const input = "input w-full min-h-11";
const STATUS: Record<string, string> = { idle: "No job", running: "Running", paused: "Paused", ended: "Ended", starting: "Starting", uncertain: "Start sent, not confirmed" };
const OUTCOME: Record<string, string> = { completed: "Completed, as the cell reported", aborted: "Stopped before it finished", unknown: "Outcome unknown", "not-started": "Did not start" };
const KIND: Record<CellKind, string> = { arm: "Robot arm", machine: "Machine", sensor: "Sensor" };
const STEP: Record<CellStep["kind"], string> = { "machine-job": "Run a file on a machine", "arm-program": "Run an arm program", "wait-machine": "Wait for a machine to be idle", "wait-input": "Wait for a sensor reading" };
const ROLE = /^[a-z][a-z0-9-]{0,39}$/;
// vocab-lint-ok: a cell's members are Machines records by definition, so "machines" is the collection's own noun here
const NO_MEMBERS = "No machines in this cell yet.";

export function CellPanel({ ctx }: { ctx: EntityDetailPanelCtx }) { return <CellRecords ctx={ctx} />; }
export function CellRecords({ ctx, station = false }: { ctx: EntityDetailPanelCtx; station?: boolean }) {
 const { slug, entityId: machine } = ctx, qc = useQueryClient(), toast = useToast(), { activeOrg } = useActiveOrg();
 const admin = roleSatisfies(activeOrg?.role, ["admin"]);
 const [offset, setOffset] = useState(0), [busy, setBusy] = useState(false), [editing, setEditing] = useState<"" | "setup" | "job">("");
 const query = useQuery({ queryKey: ["robot-cell", slug, machine, offset], queryFn: () => readCell(slug, machine, offset), refetchInterval: station ? 2000 : 10000 });
 async function run(work: () => Promise<unknown>, done?: string) { setBusy(true); try { await work(); if (done) toast.success(done); } catch (e) { toast.error(e instanceof Error ? e.message : "The cell did not accept that."); } finally { setBusy(false); await qc.invalidateQueries({ queryKey: ["robot-cell", slug, machine] }); } }
 if (query.isError) return <QueryError what="The cell could not be loaded." onRetry={() => void query.refetch()} />;
 if (!query.data) return <p className="text-sm text-muted">Loading the cell…</p>;
 const data = query.data, cell = data.cell;
 if (!cell && editing !== "setup") return <details className="text-sm"><summary className="min-h-11 cursor-pointer flex items-center">Cell</summary><p>Run machines that work together, like a CNC and the arm that unloads it, as one job on your shop's bridge.</p>{admin ? <button className={button} onClick={() => setEditing("setup")}>Set up as a cell</button> : <p className="text-muted">An owner or admin sets up a cell.</p>}</details>;
 const open = data.open_job;
 return <section data-testid="robot-cell" className="rounded-lg border border-line p-3 space-y-4 text-content">
  <header className="flex flex-wrap gap-2 items-center"><h3 className="flex-1 text-sm font-semibold">Cell</h3>
   {admin && cell && <button className={button} disabled={!!open} onClick={() => setEditing(editing === "setup" ? "" : "setup")}>Machines</button>}
   {admin && cell && <button className={button} disabled={!!open} onClick={() => setEditing(editing === "job" ? "" : "job")}>Job steps</button>}
   {!station && cell?.connection_id && <WorkspaceLink className={button} slug={slug} to={`/station/cell/${machine}`}>Open cell station</WorkspaceLink>}</header>
  {editing === "setup" && <SetupForm slug={slug} data={data} busy={busy} save={value => void run(async () => { await setupCell(slug, machine, value); setEditing(""); }, "Saved the cell's machines.")} />}
  {editing === "job" && cell && <JobForm slug={slug} data={data} busy={busy} save={value => void run(async () => { await saveDefinition(slug, machine, value); setEditing(""); }, "Saved the cell's job.")} />}
  {cell && <>
   <StatePanel data={data} />
   {cell.connection_id && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => void run(() => stopCellJob(slug, machine), "Stopped the cell's job and its machines.")}>Stop cell</button></div>}
   <p className="text-sm text-muted">Stop here stops the cell's job and the programs on its machines through your bridge. It is not an emergency stop. {productName()} never moves a machine, clears a stop or acts as an interlock: the cell's safety devices do that.</p>
   <SafetyBoundaryLink slug={slug} />
   {station && <StationControls slug={slug} machine={machine} title={ctx.entityTitle} data={data} admin={admin} busy={busy} run={run} />}
   <Steps data={data} />
   {!station && <Summary data={data} />}
   {admin && !station && <PeopleAndOutput slug={slug} machine={machine} data={data} busy={busy} run={run} />}
   <Jobs slug={slug} data={data} busy={busy} run={run} />
   <section aria-label="Commands sent"><h4 className="font-semibold">Commands sent</h4>{data.items.length === 0 ? <p className="text-sm text-muted">No commands sent to this cell yet.</p> : <ol className="space-y-1 text-sm">{data.items.map(c => <li key={c.id} className="break-words">{new Date(c.created_at).toLocaleString()} · {c.operation} from the {c.via} · {c.ok ? "accepted" : `refused: ${c.detail}`}</li>)}</ol>}
    {data.total > 20 && <nav aria-label="Command pages" className="flex flex-wrap gap-3"><button className={button} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Newer commands</button><span className="py-3">{offset + 1}–{Math.min(offset + 20, data.total)} of {data.total}</span><button className={button} disabled={offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>Older commands</button></nav>}</section>
  </>}
 </section>;
}

function StatePanel({ data }: { data: CellView }) {
 const s = data.state, open = data.open_job;
 const rows: Array<[string, string]> = s ? [["Bridge", s.connectivity === "online" ? "Answering" : "Not answering"], ["Job", STATUS[s.status] ?? s.status], ["Cycle", s.status === "idle" ? "None" : `${s.cycle}${s.step !== null ? `, step ${s.step + 1}` : ""} · ${s.cycles_done} done`]] : [["Bridge", data.cell?.connection_id ? "Unknown" : "Not on your bridge yet"]];
 return <div data-testid="cell-state" className="rounded bg-subtle p-3 space-y-1">
  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">{rows.map(([k, v]) => <div key={k} className="flex flex-wrap gap-2"><dt className="font-semibold">{k}</dt><dd className="break-words">{v}</dd></div>)}</dl>
  {s?.status === "paused" && <p role="alert" className="break-words">Paused: {s.paused_reason} {s.paused_on === "timeout" ? "It can be resumed at the cell station once you have looked." : "Clear it at the machines, then stop this job and start again."}</p>}
  {open?.status === "uncertain" && <p role="status">The bridge did not confirm Start. {productName()} is reading the cell to find out what happened and will never send Start again.</p>}
  {s && <p className="text-xs text-muted">Read {new Date(s.observed_at).toLocaleTimeString()}</p>}
  {data.connection_error && <p role="alert">{data.connection_error}</p>}
 </div>;
}

function Summary({ data }: { data: CellView }) {
 const d = data.cell!.definition;
 return <section aria-label="Machines and steps" className="space-y-2">
  <h4 className="font-semibold">Machines</h4>
  {data.members.length === 0 ? <p className="text-sm text-muted">{NO_MEMBERS}</p> : <ul className="text-sm space-y-1">{data.members.map(m => <li key={m.role} className="break-words"><span className="font-semibold">{m.role}</span> · {KIND[m.kind]}{m.title ? `: ${m.title}` : `: ${m.device_id}`}</li>)}</ul>}
  <h4 className="font-semibold">Job steps</h4>
  {d.steps.length === 0 ? <p className="text-sm text-muted">No steps yet.</p> : <ol className="text-sm space-y-1 list-decimal pl-5">{d.steps.map((s, i) => <li key={i} className="break-words">{stepWords(s)} · up to {s.timeout_s} s</li>)}</ol>}
  <p className="text-sm">{d.cycles === null ? "Runs until stopped" : `${d.cycles} cycle${d.cycles === 1 ? "" : "s"}`} · {d.parts_per_cycle} part{d.parts_per_cycle === 1 ? "" : "s"} each cycle</p>
 </section>;
}
function stepWords(s: CellStep): string {
 if (s.kind === "machine-job") return `${s.role}: run ${s.file}`;
 if (s.kind === "arm-program") return `${s.role}: run ${s.program.name}${s.program.revision ? ` (revision ${s.program.revision})` : ""}`;
 if (s.kind === "wait-machine") return `wait for ${s.role} to be idle`;
 return `wait for ${s.role} to read ${s.min !== null && s.max !== null ? `${s.min} to ${s.max}` : s.min !== null ? `at least ${s.min}` : `at most ${s.max}`}`;
}

function Steps({ data }: { data: CellView }) {
 const latest = data.jobs[0];
 if (!latest || data.steps.length === 0) return null;
 return <section aria-label="Steps of the latest job" className="space-y-1"><h4 className="font-semibold">Steps of {latest.label || "the latest job"}</h4>
  <ol className="text-sm space-y-1">{data.steps.map(s => <li key={`${s.cycle}-${s.step}`} className="break-words">Cycle {s.cycle}, step {s.step + 1} · {s.role} · {s.outcome === "done" ? `done in ${Math.round((s.duration_ms ?? 0) / 1000)} s` : s.outcome === "failed" ? `failed: ${s.detail}` : "under way"}</li>)}</ol>
 </section>;
}

function Jobs({ slug, data, busy, run }: { slug: string; data: CellView; busy: boolean; run: (w: () => Promise<unknown>, done?: string) => Promise<void> }) {
 const [note, setNote] = useState(""), open = data.open_job;
 const lost = open && (open.status === "uncertain" || (data.state && data.state.job_id !== open.id));
 return <section aria-label="Jobs" className="space-y-2"><h4 className="font-semibold">Jobs</h4>
  {open && <div data-testid="cell-open-job" className="rounded bg-subtle p-3 space-y-1"><p className="font-semibold break-words">{open.label || "Cell job"} · {STATUS[open.status]}</p><p>{open.cycles} cycles · {open.parts} parts{open.last_cycle_ms ? ` · last cycle ${Math.round(open.last_cycle_ms / 1000)} s` : ""}</p>
   {lost && <div className="flex flex-wrap gap-2 items-end"><label className="flex-1 min-w-0">What you found at the cell<input className={input} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label>
    <button className={button} disabled={busy} onClick={() => void run(() => endCellJob(slug, open.id, { outcome: "unknown", note }), "Recorded the job's outcome as unknown.")}>End: outcome unknown</button>
    <button className={button} disabled={busy} onClick={() => void run(() => endCellJob(slug, open.id, { outcome: "aborted", note }), "Recorded the job as stopped.")}>End: stopped</button></div>}
   <p className="text-xs text-muted">A job is completed only when the cell reports it finished its cycles.</p></div>}
  {data.jobs.filter(j => j.status === "ended").length === 0 && !open ? <p className="text-sm text-muted">No jobs run yet.</p> : <ol className="space-y-1 text-sm">{data.jobs.filter(j => j.status === "ended").map((j: CellJob) => <li key={j.id} className="break-words">{new Date(j.started_at).toLocaleString()} · {j.label || "Cell job"} · {OUTCOME[j.outcome ?? ""] ?? j.outcome} · {j.cycles} cycles, {j.parts} parts{j.detail ? ` · ${j.detail}` : ""}</li>)}</ol>}
 </section>;
}

function PeopleAndOutput({ slug, machine, data, busy, run }: { slug: string; machine: string; data: CellView; busy: boolean; run: (w: () => Promise<unknown>, done?: string) => Promise<void> }) {
 const [people, setPeople] = useState<string[]>(data.cell!.operators), [output, setOutputPart] = useState<string | null>(data.cell!.output_part_id);
 return <section aria-label="Operators and output" className="space-y-2">
  <h4 className="font-semibold">Operators</h4>
  <p className="text-sm text-muted">Who starts this cell at its station and is told when it pauses. With nobody named, any operator runs it and whoever started a job is told.</p>
  {people.map((p, i) => <div key={i} className="flex gap-2 items-center"><MemberSelect label={`Operator ${i + 1}`} className="flex-1 min-h-11" value={p} onChange={v => setPeople(people.map((x, j) => j === i ? v ?? "" : x))} /><button className={button} onClick={() => setPeople(people.filter((_, j) => j !== i))}>Remove</button></div>)}
  <div className="flex flex-wrap gap-2"><button className={button} onClick={() => setPeople([...people, ""])}>Add an operator</button><button className={button} disabled={busy} onClick={() => void run(() => setOperators(slug, machine, people.filter(Boolean)), "Saved who runs the cell.")}>Save operators</button></div>
  <h4 className="font-semibold">Where its parts go</h4>
  <div className="flex flex-wrap gap-2 items-center"><RelationSelect label="Output part" refKind="inventory:part" className="flex-1 min-h-11" value={output} onChange={setOutputPart} /><button className={button} disabled={busy} onClick={() => void run(() => setOutput(slug, machine, output), "Saved where the cell's parts go.")}>Save output</button></div>
  <p className="text-xs text-muted">Each finished cycle adds its parts to this part's stock, once.</p>
 </section>;
}

function SetupForm({ slug, data, busy, save }: { slug: string; data: CellView; busy: boolean; save: (v: { connection_id: string | null; device_id: string | null; members: MemberInput[] }) => void }) {
 const [connection, setConnection] = useState(data.cell?.connection_id ?? ""), [device, setDevice] = useState(data.cell?.device_id ?? "");
 const [members, setMembers] = useState<MemberInput[]>(data.members.map(m => ({ role: m.role, kind: m.kind, machine_id: m.machine_id, connection_id: m.kind === "arm" ? null : m.connection_id, device_id: m.kind === "arm" ? null : m.device_id })));
 const connections = useQuery({ queryKey: ["digifab-connections", slug], queryFn: () => api.listDigifabConnections(slug) });
 const devices = useQuery({ queryKey: ["cell-devices", slug, connection], queryFn: () => api.listDigifabDevices(slug, connection), enabled: !!connection });
 const bridges = connections.data?.items.filter(c => c.type === "edge_adapter") ?? [];
 const edit = (i: number, patch: Partial<MemberInput>) => setMembers(members.map((m, j) => j === i ? { ...m, ...patch } : m));
 const valid = members.every(m => ROLE.test(m.role) && (m.kind === "sensor" || !!m.machine_id) && (m.kind === "arm" || (!!m.connection_id && !!m.device_id))) && (!connection || !!device);
 return <form className="space-y-3" onSubmit={e => { e.preventDefault(); save({ connection_id: connection || null, device_id: connection ? device || null : null, members }); }}>
  <label className="block">The cell on your bridge<select className={input} value={connection} onChange={e => { setConnection(e.target.value); setDevice(""); }}><option value="">Not on a bridge yet</option>{bridges.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
  {connection && <label className="block">Cell<select className={input} required value={device} onChange={e => setDevice(e.target.value)}><option value="">Choose the cell</option>{devices.data?.items.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select></label>}
  <p className="text-sm text-muted">A cell runs on your shop's bridge beside its machines. Add a cell to the bridge in Devices, then choose it here. Every machine of the cell is on the same bridge.</p>
  <h4 className="font-semibold">Machines</h4>
  {members.map((m, i) => <fieldset key={i} className="rounded border border-line p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
   <legend className="text-sm font-semibold">{m.role || `Machine ${i + 1}`}</legend>
   <label>Role<input className={input} maxLength={40} placeholder="cnc" value={m.role} onChange={e => edit(i, { role: e.target.value.toLowerCase() })} /></label>
   <label>Kind<select className={input} value={m.kind} onChange={e => edit(i, { kind: e.target.value as CellKind })}>{(["machine", "arm", "sensor"] as const).map(k => <option key={k} value={k}>{KIND[k]}</option>)}</select></label>
   {m.kind !== "sensor" && <label className="sm:col-span-2">The machine<RelationSelect label={`${m.role || "Machine"} record`} refKind="machines:machine" className="w-full min-h-11" value={m.machine_id} onChange={v => edit(i, { machine_id: v })} /></label>}
   {m.kind === "arm" && <p className="sm:col-span-2 text-xs text-muted">An arm uses the bridge device of its robot arm setup.</p>}
   {m.kind !== "arm" && <MemberDevice slug={slug} bridges={bridges} value={m} onChange={patch => edit(i, patch)} />}
   <button type="button" className={button} onClick={() => setMembers(members.filter((_, j) => j !== i))}>Remove {m.role || "this machine"}</button>
  </fieldset>)}
  {!members.every(m => ROLE.test(m.role)) && <p role="alert" className="text-sm">A role is lowercase letters, digits and dashes, like cnc or unload-arm.</p>}
  <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => setMembers([...members, { role: "", kind: "machine", machine_id: null, connection_id: null, device_id: null }])}>Add a machine</button><button className={button} disabled={busy || !valid}>Save the cell's machines</button></div>
 </form>;
}
function MemberDevice({ slug, bridges, value, onChange }: { slug: string; bridges: Array<{ id: string; label: string }>; value: MemberInput; onChange: (p: Partial<MemberInput>) => void }) {
 const devices = useQuery({ queryKey: ["cell-devices", slug, value.connection_id], queryFn: () => api.listDigifabDevices(slug, value.connection_id!), enabled: !!value.connection_id });
 return <>
  <label>Its connection<select className={input} value={value.connection_id ?? ""} onChange={e => onChange({ connection_id: e.target.value || null, device_id: null })}><option value="">Choose</option>{bridges.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
  <label>Its device<select className={input} value={value.device_id ?? ""} disabled={!value.connection_id} onChange={e => onChange({ device_id: e.target.value || null })}><option value="">Choose</option>{devices.data?.items.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
 </>;
}

function JobForm({ slug, data, busy, save }: { slug: string; data: CellView; busy: boolean; save: (v: CellDefinition) => void }) {
 const d = data.cell!.definition;
 const [label, setLabel] = useState(d.label), [steps, setSteps] = useState<CellStep[]>(d.steps), [forever, setForever] = useState(d.cycles === null), [cycles, setCycles] = useState(String(d.cycles ?? 1)), [parts, setParts] = useState(String(d.parts_per_cycle));
 const roles = data.members;
 const fresh = (kind: CellStep["kind"], role: string): CellStep => kind === "machine-job" ? { kind, role, file: "", timeout_s: 3600 } : kind === "arm-program" ? { kind, role, program: { name: "", revision: null }, timeout_s: 600 } : kind === "wait-machine" ? { kind, role, timeout_s: 600 } : { kind, role, min: 1, max: null, timeout_s: 600 };
 const edit = (i: number, next: CellStep) => setSteps(steps.map((s, j) => j === i ? next : s));
 const fits = (kind: CellStep["kind"]) => roles.filter(m => m.kind === (kind === "arm-program" ? "arm" : kind === "wait-input" ? "sensor" : "machine"));
 return <form className="space-y-3" onSubmit={e => { e.preventDefault(); save({ label, steps, cycles: forever ? null : Number(cycles) || 1, parts_per_cycle: Number(parts) || 0 }); }}>
  <label className="block">Job name<input className={input} maxLength={200} placeholder="Brackets" value={label} onChange={e => setLabel(e.target.value)} /></label>
  {roles.length === 0 && <p className="text-sm text-muted">Add the cell's machines first.</p>}
  <ol className="space-y-2">{steps.map((s, i) => <li key={i} className="rounded border border-line p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
   <label>Step {i + 1}<select className={input} value={s.kind} onChange={e => { const kind = e.target.value as CellStep["kind"]; edit(i, fresh(kind, fits(kind)[0]?.role ?? "")); }}>{(Object.keys(STEP) as CellStep["kind"][]).map(k => <option key={k} value={k}>{STEP[k]}</option>)}</select></label>
   <label>Machine<select className={input} value={s.role} onChange={e => edit(i, { ...s, role: e.target.value })}><option value="">Choose</option>{fits(s.kind).map(m => <option key={m.role} value={m.role}>{m.role}</option>)}</select></label>
   {s.kind === "machine-job" && <label>File on the machine<input className={input} maxLength={300} placeholder="bracket.nc" value={s.file} onChange={e => edit(i, { ...s, file: e.target.value })} /></label>}
   {s.kind === "arm-program" && <ArmProgram slug={slug} machine={roles.find(m => m.role === s.role)?.machine_id ?? null} value={s.program} onChange={program => edit(i, { ...s, program })} />}
   {s.kind === "wait-input" && <><label>Lowest reading<input className={input} inputMode="decimal" value={s.min ?? ""} onChange={e => edit(i, { ...s, min: e.target.value === "" ? null : Number(e.target.value) })} /></label><label>Highest reading<input className={input} inputMode="decimal" value={s.max ?? ""} onChange={e => edit(i, { ...s, max: e.target.value === "" ? null : Number(e.target.value) })} /></label></>}
   <label>Longest it may take (seconds)<input className={input} inputMode="numeric" value={s.timeout_s} onChange={e => edit(i, { ...s, timeout_s: Number(e.target.value.replace(/\D/g, "")) || 1 })} /></label>
   <div className="flex flex-wrap gap-2 items-end">{i > 0 && <button type="button" className={button} onClick={() => { const n = [...steps]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; setSteps(n); }}>Move up</button>}<button type="button" className={button} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove step {i + 1}</button></div>
  </li>)}</ol>
  <button type="button" className={button} disabled={roles.length === 0} onClick={() => setSteps([...steps, fresh("machine-job", fits("machine-job")[0]?.role ?? "")])}>Add a step</button>
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
   <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={forever} onChange={e => setForever(e.target.checked)} />Run until stopped</label>
   {!forever && <label>Cycles<input className={input} inputMode="numeric" value={cycles} onChange={e => setCycles(e.target.value.replace(/\D/g, ""))} /></label>}
   <label>Parts each cycle<input className={input} inputMode="numeric" value={parts} onChange={e => setParts(e.target.value.replace(/\D/g, ""))} /></label>
  </div>
  <p className="text-sm text-muted">The bridge runs these steps in order, cycle after cycle. If a step fails or takes too long, every machine that can pause is paused and the cell's operators are told.</p>
  <button className={button} disabled={busy || steps.some(s => !s.role)}>Save the cell's job</button>
 </form>;
}
function ArmProgram({ slug, machine, value, onChange }: { slug: string; machine: string | null; value: { name: string; revision: string | null }; onChange: (p: { name: string; revision: string | null }) => void }) {
 const arm = useQuery({ queryKey: ["robot-arm", slug, machine, 0], queryFn: () => readArm(slug, machine!, 0), enabled: !!machine });
 const programs = (arm.data?.programs ?? []).filter(p => !p.missing_since);
 const key = (p: { name: string; revision: string | null }) => `${p.name}\u0000${p.revision ?? ""}`;
 return <label>Program<select className={input} value={value.name ? key(value) : ""} onChange={e => { const p = programs.find(x => key(x) === e.target.value); if (p) onChange({ name: p.name, revision: p.revision }); }}><option value="">Choose a program</option>{programs.map(p => <option key={p.id} value={key(p)}>{p.name}{p.revision ? ` (revision ${p.revision})` : ""}</option>)}</select></label>;
}

function StationControls({ slug, machine, title, data, admin, busy, run }: { slug: string; machine: string; title: string; data: CellView; admin: boolean; busy: boolean; run: (w: () => Promise<unknown>, done?: string) => Promise<void> }) {
 const cell = data.cell!, storageKey = `cell-station:${slug}:${cell.connection_id}:${cell.device_id}`;
 const [credential, setCredential] = useState<{ id: string; token: string; key: string } | null>(null), [clear, setClear] = useState(false);
 const saved = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || "null") as { id: string; token: string; key: string } | null; } catch { return null; } })();
 const screen = credential?.key === storageKey ? credential : saved;
 const s = data.state, open = data.open_job;
 if (!cell.connection_id || !cell.device_id) return <p className="text-sm">Put this cell on your bridge before running it.</p>;
 return <div className="space-y-3 rounded border border-line p-3">
  <p>Keep this screen beside {title}. Starting and resuming its job need an operator, an owner or an admin at this screen.</p>
  {screen ? <button className={button} disabled={busy} onClick={() => void run(async () => { await api.revokeDigifabStation(slug, screen.id); localStorage.removeItem(storageKey); setCredential(null); })}>Revoke this screen</button> : <button className={button} disabled={busy || !admin} onClick={() => void run(async () => { const r = await api.registerDigifabStation(slug, cell.connection_id!, cell.device_id!); const next = { id: r.id, token: r.token, key: storageKey }; localStorage.setItem(storageKey, JSON.stringify(next)); setCredential(next); }, "This screen is the cell's station.")}>Authorize this cell station</button>}
  {screen && <>
   {!open && data.hash && <div role="group" aria-label="Start the cell's job" className="space-y-2">
    <p className="text-sm">This starts {cell.definition.label || "the cell's job"}: {cell.definition.steps.length} step{cell.definition.steps.length === 1 ? "" : "s"}, {cell.definition.cycles === null ? "until stopped" : `${cell.definition.cycles} cycle${cell.definition.cycles === 1 ? "" : "s"}`}. Check {data.hash.slice(0, 8)}.</p>
    <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)} />I am at the cell: it is clear, guarded and ready to run this job</label>
    <button className={button} disabled={busy || !clear} onClick={() => void run(async () => { await startCellJob(slug, machine, { station_token: screen.token, definition_hash: data.hash!, cell_clear: true }); setClear(false); }, "Sent Start once.")}>Start the cell</button>
   </div>}
   {!open && !data.hash && <p className="text-sm text-muted">Give the cell its machines and its job steps before starting it.</p>}
   {s?.status === "paused" && s.paused_on === "timeout" && <button className={button} disabled={busy} onClick={() => void run(() => resumeCellJob(slug, machine, screen.token), "Resumed the cell's job.")}>Resume</button>}
  </>}
 </div>;
}
