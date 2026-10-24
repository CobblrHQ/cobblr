import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { capabilityAllows, productName, QueryError, useToast, WorkspaceLink } from "@cobblr/platform-web";
import type { ArmCommand, ArmState } from "@cobblr/platform-contract/robot-arm";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { api } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import type { EntityDetailPanelCtx } from "../../panels/types";
import { Backups, Copies, ProgramControl, Updates } from "./armProgramControl";
import { SafetyBoundaryLink } from "../../pages/RobotSafetyPage";
import { addProgram, approveRun, commandArm, editProgram, endRun, readArm, refreshArm, releaseControl, revokeControl, saveCompatibility, setMaintenance, setTooling, setupArm, startRun, takeControl, type ArmCompatibility, type ArmProgram, type ArmView } from "./robot-arm-api";
import { useCan, useCapabilitiesFor, useRoleAtLeast } from "../../lib/can";
import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
const input = "input w-full min-h-11";
const WORDS: Record<string, string> = {
 online: "Answering", offline: "Not answering", unknown: "Unknown", remote: "Remote", local: "Local: the pendant has control",
 idle: "Idle", loaded: "Program loaded", running: "Running", paused: "Paused", stopped: "Stopped",
 normal: "Normal", "protective-stop": "Protective stop", "emergency-stop": "Emergency stop", fault: "Fault",
 "in-service": "In service", "down-for-repair": "Down for repair",
};
const SUPPORT = { untested: "Not tested yet", simulator: "Tested on a simulator only", hardware: "Tested on this hardware" } as const;
export function ArmPanel({ ctx }: { ctx: EntityDetailPanelCtx }) { return <ArmRecords ctx={ctx} />; }
export function ArmRecords({ ctx, station = false }: { ctx: EntityDetailPanelCtx; station?: boolean }) {
 const { slug, entityId: machine } = ctx, qc = useQueryClient(), toast = useToast(), { activeOrg } = useActiveOrg();
 const admin = roleSatisfies(activeOrg?.role, ["admin"]);
 const [offset, setOffset] = useState(0), [busy, setBusy] = useState(false), [settingUp, setSettingUp] = useState(false);
 const query = useQuery({ queryKey: ["robot-arm", slug, machine, offset], queryFn: () => readArm(slug, machine, offset), refetchInterval: station ? 3000 : 15000 });
 const unit = query.data?.unit;
 const storageKey = `arm-station:${slug}:${unit?.connection_id}:${unit?.device_id}`;
 const [credential, setCredential] = useState<{ id: string; token: string; key: string } | null>(null);
 const saved = (() => { if (!station) return null; try { return JSON.parse(localStorage.getItem(storageKey) || "null") as { id: string; token: string; key: string } | null; } catch { return null; } })();
 const screen = credential?.key === storageKey ? credential : saved;
 const caps = useCapabilitiesFor(slug);
 const can = (capability: string) => capabilityAllows(caps, capability);
 async function run(work: () => Promise<unknown>, done?: string) { setBusy(true); try { await work(); if (done) toast.success(done); } catch (e) { toast.error(e instanceof Error ? e.message : "The arm did not accept that."); } finally { setBusy(false); await qc.invalidateQueries({ queryKey: ["robot-arm", slug, machine] }); } }
 if (query.isError) return <QueryError what="The robot arm could not be loaded." onRetry={() => void query.refetch()} />;
 if (!query.data) return <p className="text-sm text-muted">Loading the robot arm…</p>;
 const data = query.data, send = (command: ArmCommand) => void run(() => commandArm(slug, machine, command, screen ? { station_token: screen.token } : {}), `Sent ${command.operation} to the arm.`);
 if (!unit && !settingUp) return <details className="text-sm"><summary className="min-h-11 cursor-pointer flex items-center">Robot arm</summary><p>Keep this arm's programs, versions and what it is known to work with, and follow its state from its controller.</p>{admin ? <button className={button} onClick={() => setSettingUp(true)}>Set up as a robot arm</button> : <p className="text-muted">An owner or admin sets up a robot arm.</p>}</details>;
 return <section data-testid="robot-arm" className="rounded-lg border border-line p-3 space-y-4 text-content">
  <header className="flex flex-wrap gap-2 items-center"><h3 className="flex-1 text-sm font-semibold">Robot arm</h3>{admin && unit && <button className={button} onClick={() => setSettingUp(!settingUp)}>Controller connection</button>}{!station && unit?.connection_id && <WorkspaceLink className={button} slug={slug} to={`/station/arm/${machine}`}>Open arm station</WorkspaceLink>}</header>
  {settingUp && <SetupForm slug={slug} current={unit ?? null} busy={busy} save={value => void run(async () => { await setupArm(slug, machine, value); setSettingUp(false); }, "Saved the arm's controller connection.")} />}
  {unit && <>
   <StatePanel state={data.state} error={data.connection_error} maintenance={unit.maintenance} note={unit.maintenance_note} connected={!!unit.connection_id} />
   {unit.connection_id && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => send({ operation: "pause" })}>Pause</button><button className={button} disabled={busy} onClick={() => send({ operation: "stop" })}>Stop program</button></div>}
   <p className="text-sm text-muted">Stop here is a program stop through the arm's controller, not an emergency stop. {productName()} never moves the arm, clears a protective or emergency stop, or changes safety settings: do those at the pendant.</p>
   <SafetyBoundaryLink slug={slug} />
   {station && unit.connection_id && unit.device_id && <StationControls slug={slug} machine={machine} title={ctx.entityTitle} unit={unit as { connection_id: string; device_id: string; tooling: string }} data={data} admin={admin} operate={can("digifab:operate")} revokes={can("digifab:revoke-station")} busy={busy} screen={screen} storageKey={storageKey} setCredential={setCredential} run={run} send={send} />}
   {unit.connection_id && <RunPanel slug={slug} data={data} operate={can("digifab:operate")} busy={busy} run={run} />}
   <InfoPanel data={data} admin={admin} busy={busy} refresh={() => void run(async () => { const r = await refreshArm(slug, machine); if (!r.programs_listed && r.detail) toast.error(r.detail); }, "Read the arm's controller.")} />
   <Programs slug={slug} data={data} admin={admin} busy={busy} run={run} machine={machine} />
   <Copies slug={slug} data={data} admin={admin} busy={busy} run={run} />
   <Updates slug={slug} machine={machine} data={data} admin={admin} busy={busy} run={run} />
   <Backups slug={slug} machine={machine} data={data} admin={admin} busy={busy} run={run} screen={station ? screen : null} />
   {admin && <ToolingForm unit={unit} busy={busy} controlled={!!data.ownership} save={t => void run(() => setTooling(slug, machine, t), "Saved the arm's tooling.")} revoke={() => void run(() => revokeControl(slug, machine), "Took control away from the station.")} />}
   {admin && <MaintenanceForm unit={unit} busy={busy} save={value => void run(() => setMaintenance(slug, machine, value), "Saved the arm's service state.")} />}
   <CompatibilityForm data={data} admin={admin} busy={busy} save={value => void run(() => saveCompatibility(slug, machine, value), "Recorded what works on this arm.")} />
   <section aria-label="Commands sent"><h4 className="font-semibold">Commands sent</h4>{data.items.length === 0 ? <p className="text-sm text-muted">No commands sent to this arm yet.</p> : <ol className="space-y-1 text-sm">{data.items.map(c => <li key={c.id} className="break-words">{new Date(c.created_at).toLocaleString()} · {c.operation} from the {c.via} · {c.ok ? "accepted" : `refused: ${c.detail}`}</li>)}</ol>}
    {data.total > 20 && <nav aria-label="Command pages" className="flex flex-wrap gap-3"><button className={button} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Newer commands</button><span className="py-3">{offset + 1}–{Math.min(offset + 20, data.total)} of {data.total}</span><button className={button} disabled={offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>Older commands</button></nav>}</section>
  </>}
 </section>;
}
function StatePanel({ state, error, maintenance, note, connected }: { state: ArmState | null; error: string | null; maintenance: string; note: string; connected: boolean }) {
 const rows: Array<[string, string]> = state ? [["Controller", WORDS[state.connectivity]!], ["Mode", WORDS[state.mode]!], ["Program", `${WORDS[state.execution]}${state.program ? `: ${state.program.name}${state.program.revision ? ` (revision ${state.program.revision})` : ""}` : ""}`], ["Safety", `${WORDS[state.safety]}${state.safety_detail ? `: ${state.safety_detail}` : ""}`]] : [["Controller", connected ? "Unknown" : "Not connected: run it at its pendant"]];
 return <div data-testid="arm-state" className="rounded bg-subtle p-3 space-y-1">
  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">{[...rows, ["Service", `${WORDS[maintenance]}${note ? `: ${note}` : ""}`] as [string, string]].map(([k, v]) => <div key={k} className="flex flex-wrap gap-2"><dt className="font-semibold">{k}</dt><dd className="break-words">{v}</dd></div>)}</dl>
  {state && <p className="text-xs text-muted">Read {new Date(state.observed_at).toLocaleTimeString()}</p>}
  {error && <p role="alert">{error}</p>}
 </div>;
}
function SetupForm({ slug, current, busy, save }: { slug: string; current: ArmView["unit"]; busy: boolean; save: (v: { connection_id: string | null; device_id: string | null }) => void }) {
 const [connection, setConnection] = useState(current?.connection_id ?? ""), [device, setDevice] = useState(current?.device_id ?? "");
 const connections = useQuery({ queryKey: ["digifab-connections", slug], queryFn: () => api.listDigifabConnections(slug) });
 const devices = useQuery({ queryKey: ["arm-devices", slug, connection], queryFn: () => api.listDigifabDevices(slug, connection), enabled: !!connection });
 return <form className="space-y-3" onSubmit={e => { e.preventDefault(); save({ connection_id: connection || null, device_id: connection ? device || null : null }); }}>
  <label className="block">Controller connection<select className={input} value={connection} onChange={e => { setConnection(e.target.value); setDevice(""); }}><option value="">No controller: records only</option>{connections.data?.items.filter(c => c.type === "edge_adapter").map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
  <p className="text-sm text-muted">An arm connects through your shop's bridge, which speaks to its controller. Set up the bridge connection in Devices, then choose the arm here.</p>
  {connection && <label className="block">Arm<select className={input} required value={device} onChange={e => setDevice(e.target.value)}><option value="">Choose the arm</option>{devices.data?.items.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select></label>}
  <button className={button} disabled={busy || !!connection && !device}>Save controller connection</button>
 </form>;
}
function StationControls({ slug, machine, title, unit, data, admin, operate, revokes, busy, screen, storageKey, setCredential, run, send }: { slug: string; machine: string; title: string; unit: { connection_id: string; device_id: string; tooling: string }; data: ArmView; admin: boolean; operate: boolean; revokes: boolean; busy: boolean; screen: { id: string; token: string } | null; storageKey: string; setCredential: (c: { id: string; token: string; key: string } | null) => void; run: (w: () => Promise<unknown>, done?: string) => Promise<void>; send: (c: ArmCommand) => void }) {
  const setsUp = useRoleAtLeast(ADMIN_TIER);
  const mayRevoke = useCan("digifab:revoke-station");
 const [program, setProgram] = useState(""), [clear, setClear] = useState(false), [tooled, setTooled] = useState(false);
 const [kind, setKind] = useState("invocation"), [label, setLabel] = useState(""), [ref, setRef] = useState(""), [target, setTarget] = useState("");
 const usable = data.programs.filter(p => !p.missing_since), chosen = usable.find(p => p.id === program), s = data.state;
 const pref = chosen ? { name: chosen.name, revision: chosen.revision } : null;
 const loadedHere = !!pref && !!s?.program && s.program.name === pref.name && s.program.revision === pref.revision;
 const approval = data.approvals.find(a => a.program_id === program);
 const mine = !!data.ownership && !!screen && data.ownership.station_id === screen.id;
 return <div className="space-y-3 rounded border border-line p-3">
  <p>Keep this screen beside {title}. Taking control, loading, approving and starting a run need an operator, an owner or an admin at this screen. The pendant always wins.</p>
  {screen ? revokes && (mayRevoke && <button className={button} disabled={busy} onClick={() => void run(async () => { await api.revokeDigifabStation(slug, screen.id); localStorage.removeItem(storageKey); setCredential(null); })}>Revoke this screen</button>) : (setsUp && <button className={button} disabled={busy || !admin} onClick={() => void run(async () => { const r = await api.registerDigifabStation(slug, unit.connection_id, unit.device_id); const next = { id: r.id, token: r.token, key: storageKey }; localStorage.setItem(storageKey, JSON.stringify(next)); setCredential(next); }, "This screen is the arm's station.")}>Authorize this arm station</button>)}
  {screen && <>
   <div className="flex flex-wrap gap-2 items-center">{!operate ? <p className="text-sm">{mine ? "This station has control of the arm." : data.ownership ? "Another station has control of this arm." : "No station has control of this arm."} Taking control needs an operator, an owner or an admin; Pause and Stop are yours.</p> : mine ? <><p className="text-sm">This station has control until {new Date(data.ownership!.expires_at).toLocaleTimeString()}.</p><button className={button} disabled={busy} onClick={() => void run(() => takeControl(slug, machine, screen.token), "Kept control of the arm.")}>Keep control</button><button className={button} disabled={busy} onClick={() => void run(() => releaseControl(slug, machine, screen.token), "Gave back control of the arm.")}>Give back control</button></> : <><p className="text-sm">{data.ownership ? "Another station has control of this arm." : "No station has control of this arm."}</p><button className={button} disabled={busy} onClick={() => void run(() => takeControl(slug, machine, screen.token), "This station has control of the arm.")}>Take control</button></>}</div>
   {mine && operate && <>
    <label className="block">Program<select className={input} value={program} onChange={e => { setProgram(e.target.value); setClear(false); setTooled(false); }}><option value="">Choose a program</option>{usable.map(p => <option key={p.id} value={p.id}>{p.name}{p.revision ? ` (revision ${p.revision})` : ""}{p.family ? ` · ${p.family}` : ""}{p.released_at ? "" : " · not released"}</option>)}</select></label>
    <div className="flex flex-wrap gap-2">
     <button className={button} disabled={busy || !pref} onClick={() => pref && send({ operation: "load", program: pref })}>Load program</button>
     {s?.execution === "paused" && <button className={button} disabled={busy} onClick={() => send({ operation: "resume" })}>Resume</button>}
    </div>
    {pref && !loadedHere && <p className="text-sm text-muted">Load this program first. A run is offered when the controller reports it loaded.</p>}
    {pref && loadedHere && !chosen?.released_at && <p className="text-sm" role="status">This revision is not released for production. An admin reviews what changed in it and releases it before it runs.</p>}
    {pref && loadedHere && !!chosen?.released_at && !approval && !data.open_run && <div role="group" aria-label="Approve a run" className="space-y-2">
     <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={tooled} onChange={e => setTooled(e.target.checked)} />The installed tooling is {unit.tooling || "none recorded"}</label>
     <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)} />I am at the cell: it is clear, guarded and ready for {pref.name}</label>
     <button className={button} disabled={busy || !clear || !tooled} onClick={() => void run(async () => { await approveRun(slug, machine, { station_token: screen.token, program_id: program, tooling: unit.tooling, cell_clear: true }); setClear(false); setTooled(false); }, "Approved one run.")}>Approve a run of {pref.name}</button>
    </div>}
    {pref && loadedHere && approval && !data.open_run && <form aria-label="Start a run" className="grid grid-cols-1 sm:grid-cols-2 gap-2" onSubmit={e => { e.preventDefault(); void run(() => startRun(slug, machine, { station_token: screen.token, approval_id: approval.id, kind, label, ref, target_cycles: target ? Number(target) : null }), "Sent Start once."); }}>
     <p className="sm:col-span-2 text-sm">Approved until {new Date(approval.expires_at).toLocaleTimeString()} for revision {approval.revision ?? "none"} with {approval.tooling || "no tooling recorded"}. It starts one run.</p>
     <label>Run<select className={input} value={kind} onChange={e => setKind(e.target.value)}>{([["invocation", "One run of the program"], ["batch", "A batch of cycles"], ["order", "An order"], ["shift", "A shift"], ["continuous", "Continuous, until the arm says it is done"]] as const).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
     <label>Name<input className={input} maxLength={200} value={label} onChange={e => setLabel(e.target.value)} /></label>
     {kind === "order" && <label>Order<input className={input} maxLength={200} value={ref} onChange={e => setRef(e.target.value)} /></label>}
     {kind === "batch" && <label>Cycles<input className={input} inputMode="numeric" value={target} onChange={e => setTarget(e.target.value.replace(/\D/g, ""))} /></label>}
     <button className={button} disabled={busy}>Start {pref.name}</button>
    </form>}
    {admin && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => send({ operation: "power", state: "on" })}>Power on controller</button><button className={button} disabled={busy} onClick={() => send({ operation: "power", state: "off" })}>Power off controller</button></div>}
   </>}
  </>}
 </div>;
}
const OUTCOME: Record<string, string> = { completed: "Completed, as the arm reported", aborted: "Aborted", unknown: "Outcome unknown", "not-started": "Did not start" };
function RunPanel({ slug, data, operate, busy, run }: { slug: string; data: ArmView; operate: boolean; busy: boolean; run: (w: () => Promise<unknown>, done?: string) => Promise<void> }) {
 const open = data.open_run, [note, setNote] = useState("");
 return <section aria-label="Runs" className="space-y-2"><h4 className="font-semibold">Runs</h4>
  {open ? <div data-testid="arm-open-run" className="rounded bg-subtle p-3 space-y-1">
   <p className="font-semibold break-words">{open.label || open.kind} · {open.status === "uncertain" ? "Start sent, not confirmed" : open.status === "starting" ? "Starting" : "Running"}</p>
   {open.status === "uncertain" && <p role="status">The arm did not confirm Start. {productName()} is reading the arm to find out what happened and will never send Start again.</p>}
   {open.link_lost && <p role="alert">{open.link_lost === "cloud" ? `${productName()} cannot reach the shop's bridge. The arm may still be running.` : "The bridge cannot reach the arm's controller. Check the arm at the cell."}</p>}
   <p>{open.cycles}{open.target_cycles ? ` of ${open.target_cycles}` : ""} cycles · {open.good} good · {open.scrap} scrap</p>
   {operate && <div className="flex flex-wrap gap-2 items-end"><label className="flex-1 min-w-0">Note<input className={input} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label>
    <button className={button} disabled={busy} onClick={() => void run(() => endRun(slug, open.id, { outcome: "unknown", note }), "Recorded the run's outcome as unknown.")}>End: outcome unknown</button>
    <button className={button} disabled={busy} onClick={() => void run(() => endRun(slug, open.id, { outcome: "aborted", note }), "Recorded the run as aborted.")}>End: aborted</button></div>}
   <p className="text-xs text-muted">A run is completed only when the arm reports it finished. Stopped or idle on the controller is not done.</p>
  </div> : <p className="text-sm text-muted">No run open.</p>}
  {data.runs.filter(r => r.status === "ended").length > 0 && <ol className="space-y-1 text-sm">{data.runs.filter(r => r.status === "ended").map(r => <li key={r.id} className="break-words">{new Date(r.started_at).toLocaleString()} · {r.label || r.kind} · {OUTCOME[r.outcome ?? ""] ?? r.outcome} · {r.cycles} cycles, {r.good} good, {r.scrap} scrap</li>)}</ol>}
 </section>;
}
function ToolingForm({ unit, busy, save, revoke, controlled }: { unit: NonNullable<ArmView["unit"]>; busy: boolean; save: (t: string) => void; revoke: () => void; controlled: boolean }) {
 const [tooling, setValue] = useState(unit.tooling);
 return <div className="space-y-2"><form className="flex flex-wrap gap-2 items-end" onSubmit={e => { e.preventDefault(); save(tooling); }}><label className="flex-1 min-w-0">Installed tooling<input className={input} maxLength={500} placeholder="vacuum gripper" value={tooling} onChange={e => setValue(e.target.value)} /></label><button className={button} disabled={busy || tooling === unit.tooling}>Save tooling</button></form>
  <p className="text-xs text-muted">Changing the tooling voids every run approval given before.</p>
  {controlled && <button className={button} disabled={busy} onClick={revoke}>Take control away from its station</button>}</div>;
}
function InfoPanel({ data, admin, busy, refresh }: { data: ArmView; admin: boolean; busy: boolean; refresh: () => void }) {
 const info = data.unit?.last_info;
 return <section aria-label="Controller" className="space-y-1"><h4 className="font-semibold">Controller</h4>
  {info ? <dl className="text-sm grid grid-cols-1 sm:grid-cols-2 gap-x-4">{([["Model", info.model], ["Serial", info.serial ?? "Not reported"], ["Generation", info.controller_generation ?? "Not reported"], ["Software", info.software_versions.map(v => `${v.name} ${v.version}`).join(", ") || "Not reported"], ["Options", info.options.join(", ") || "None reported"], ["Interfaces", info.interfaces.map(i => `${i.name}${i.enabled ? "" : " (off)"}`).join(", ") || "None reported"]] as const).map(([k, v]) => <div key={k} className="flex flex-wrap gap-2"><dt className="font-semibold">{k}</dt><dd className="break-words">{v}</dd></div>)}</dl> : <p className="text-sm text-muted">Not read from the controller yet.</p>}
  {data.unit?.info_seen_at && <p className="text-xs text-muted">Read {new Date(data.unit.info_seen_at).toLocaleString()}</p>}
  {admin && data.unit?.connection_id && <button className={button} disabled={busy} onClick={refresh}>Read the controller again</button>}
 </section>;
}
function Programs({ slug, data, admin, busy, run, machine }: { slug: string; data: ArmView; admin: boolean; busy: boolean; run: (w: () => Promise<unknown>, done?: string) => Promise<void>; machine: string }) {
 const [adding, setAdding] = useState(false);
 return <section aria-label="Programs" className="space-y-2"><h4 className="font-semibold">Programs</h4>
  {data.programs.length === 0 && <p className="text-sm text-muted">{data.unit?.connection_id ? "No programs read yet. Read the controller, or add them by hand if it cannot list them." : "Add the programs this arm runs."}</p>}
  {data.families.map(g => <div key={g.family ?? ""} className="space-y-1"><h5 className="text-sm font-semibold">{g.family ?? "No family"}</h5><ul className="space-y-1">{g.programs.map(p => <li key={p.id}><ProgramRow slug={slug} program={p} admin={admin} busy={busy} run={run} /></li>)}</ul></div>)}
  {admin && <button className={button} onClick={() => setAdding(!adding)}>Add a program by hand</button>}
  {adding && <AddProgram busy={busy} save={value => void run(async () => { await addProgram(slug, machine, value); setAdding(false); }, "Added the program.")} />}
 </section>;
}
function ProgramRow({ slug, program: p, admin, busy, run }: { slug: string; program: ArmProgram; admin: boolean; busy: boolean; run: (w: () => Promise<unknown>, done?: string) => Promise<void> }) {
 const [editing, setEditing] = useState(false), [family, setFamily] = useState(p.family ?? ""), [tool, setTool] = useState(p.tool), [installation, setInstallation] = useState(p.installation);
 return <div className="rounded border border-line p-2 text-sm space-y-1">
  <p className="break-words"><span className="font-semibold">{p.name}</span> · {p.revision ? `revision ${p.revision}` : "no revision reported"} · {p.source === "controller" ? "read from the controller" : "typed in"}{p.missing_since && <span role="status"> · the controller no longer lists it</span>}</p>
  {(p.tool || p.installation) && <p className="break-words text-muted">{[p.tool && `Tool: ${p.tool}`, p.installation && `Installation: ${p.installation}`].filter(Boolean).join(" · ")}</p>}
  <ProgramControl slug={slug} program={p} admin={admin} busy={busy} run={run} />
  {admin && !editing && <button className={button} onClick={() => setEditing(true)}>Edit {p.name}</button>}
  {editing && <form className="grid grid-cols-1 sm:grid-cols-3 gap-2" onSubmit={e => { e.preventDefault(); void run(async () => { await editProgram(slug, p.id, { family: family || null, tool, installation }); setEditing(false); }, "Updated the program."); }}><label>Family<input className={input} maxLength={200} placeholder="unload CNC 3" value={family} onChange={e => setFamily(e.target.value)} /></label><label>Tool<input className={input} maxLength={500} value={tool} onChange={e => setTool(e.target.value)} /></label><label>Installation<input className={input} maxLength={500} value={installation} onChange={e => setInstallation(e.target.value)} /></label><div className="flex flex-wrap gap-2"><button className={button} disabled={busy}>Save {p.name}</button><button type="button" className={button} onClick={() => setEditing(false)}>Cancel</button></div></form>}
 </div>;
}
function AddProgram({ busy, save }: { busy: boolean; save: (v: { name: string; revision: string | null; family: string | null; tool: string; installation: string }) => void }) {
 const [name, setName] = useState(""), [revision, setRevision] = useState(""), [family, setFamily] = useState(""), [tool, setTool] = useState(""), [installation, setInstallation] = useState("");
 return <form className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded border border-line p-2" onSubmit={e => { e.preventDefault(); save({ name, revision: revision || null, family: family || null, tool, installation }); }}>
  <label>Program name<input className={input} required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
  <label>Revision or checksum<input className={input} maxLength={200} value={revision} onChange={e => setRevision(e.target.value)} /></label>
  <label>Family<input className={input} maxLength={200} placeholder="unload CNC 3" value={family} onChange={e => setFamily(e.target.value)} /></label>
  <label>Tool<input className={input} maxLength={500} value={tool} onChange={e => setTool(e.target.value)} /></label>
  <label>Installation<input className={input} maxLength={500} value={installation} onChange={e => setInstallation(e.target.value)} /></label>
  <button className={button} disabled={busy || !name.trim()}>Save program</button>
 </form>;
}
function MaintenanceForm({ unit, busy, save }: { unit: NonNullable<ArmView["unit"]>; busy: boolean; save: (v: { maintenance: "in-service" | "down-for-repair"; note: string }) => void }) {
 const [note, setNote] = useState(unit.maintenance_note);
 const next = unit.maintenance === "in-service" ? "down-for-repair" : "in-service";
 return <form className="flex flex-wrap gap-2 items-end" onSubmit={e => { e.preventDefault(); save({ maintenance: next, note: next === "in-service" ? "" : note }); }}>
  {next === "down-for-repair" && <label className="flex-1 min-w-0">Why it is down<input className={input} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></label>}
  <button className={button} disabled={busy}>{next === "down-for-repair" ? "Mark down for repair" : "Return to service"}</button>
 </form>;
}
const blankEvidence = { tested_on: "", by: "", setup: "", notes: "" };
function CompatibilityForm({ data, admin, busy, save }: { data: ArmView; admin: boolean; busy: boolean; save: (v: ArmCompatibility) => void }) {
 const c = data.compatibility ?? { controller_generation: "", firmware: "", options: [], interfaces: [], simulator_evidence: null, hardware_evidence: null };
 const [value, setValue] = useState(c), [open, setOpen] = useState(false);
 const evidence = (key: "simulator_evidence" | "hardware_evidence", label: string) => <fieldset className="space-y-1"><legend className="font-semibold">{label}</legend>
  <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={!!value[key]} onChange={e => setValue({ ...value, [key]: e.target.checked ? { ...blankEvidence } : null })} />Tested</label>
  {value[key] && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{(["tested_on", "by", "setup", "notes"] as const).map(f => <label key={f}>{{ tested_on: "Tested on", by: "Tested by", setup: "Setup (simulator version or cell)", notes: "Notes" }[f]}<input className={input} type={f === "tested_on" ? "date" : "text"} required={f !== "notes"} value={value[key]![f]} onChange={e => setValue({ ...value, [key]: { ...value[key]!, [f]: e.target.value } })} /></label>)}</div>}
 </fieldset>;
 return <section aria-label="Compatibility" className="space-y-2"><h4 className="font-semibold">Compatibility</h4>
  <p className="text-sm">{SUPPORT[data.support]}{c.controller_generation ? ` · ${c.controller_generation}` : ""}{c.firmware ? ` · firmware ${c.firmware}` : ""}</p>
  {c.interfaces.length > 0 && <ul className="text-sm">{c.interfaces.map(i => <li key={i.name}>{i.name}: {i.enabled ? "enabled" : "off"}, {i.read && i.write ? "reads and writes" : i.read ? "reads only" : i.write ? "writes only" : "not used"}</li>)}</ul>}
  {admin && <button className={button} onClick={() => setOpen(!open)}>Record what works</button>}
  {open && <form className="space-y-2" onSubmit={e => { e.preventDefault(); save(value); setOpen(false); }}>
   <label className="block">Controller generation<input className={input} maxLength={200} value={value.controller_generation} onChange={e => setValue({ ...value, controller_generation: e.target.value })} /></label>
   <label className="block">Firmware<input className={input} maxLength={200} value={value.firmware} onChange={e => setValue({ ...value, firmware: e.target.value })} /></label>
   <label className="block">Installed options (one per line)<textarea className={input} value={value.options.join("\n")} onChange={e => setValue({ ...value, options: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })} /></label>
   <fieldset className="space-y-1"><legend className="font-semibold">Interfaces</legend>{value.interfaces.map((i, n) => <div key={n} className="flex flex-wrap gap-2 items-center"><input aria-label="Interface name" className={`${input} flex-1 min-w-0`} required value={i.name} onChange={e => setValue({ ...value, interfaces: value.interfaces.map((p, j) => j === n ? { ...p, name: e.target.value } : p) })} />{(["enabled", "read", "write"] as const).map(k => <label key={k} className="flex items-center gap-1 min-h-11"><input type="checkbox" checked={i[k]} onChange={e => setValue({ ...value, interfaces: value.interfaces.map((p, j) => j === n ? { ...p, [k]: e.target.checked } : p) })} />{{ enabled: "Enabled", read: "Reads", write: "Writes" }[k]}</label>)}<button type="button" className={button} onClick={() => setValue({ ...value, interfaces: value.interfaces.filter((_, j) => j !== n) })}>Remove {i.name || "interface"}</button></div>)}<button type="button" className={button} onClick={() => setValue({ ...value, interfaces: [...value.interfaces, { name: "", enabled: true, read: true, write: false }] })}>Add an interface</button></fieldset>
   {evidence("simulator_evidence", "Simulator")}
   {evidence("hardware_evidence", "Hardware")}
   <button className={button} disabled={busy}>Save compatibility</button>
  </form>}
 </section>;
}
