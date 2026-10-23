import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { capabilityAllows, NumberField, QueryError, SearchInput, useToast, WorkspaceLink } from "@cobblr/platform-web";
import { randomId } from "@cobblr/platform-contract/random-id";
import { api, type PlatformResolvedEntity } from "../../lib/api";
import { useEnabledModules } from "../../lib/useEnabledModules";
import type { EntityDetailPanelCtx } from "../../panels/types";
import { readKiln, saveKiln, createFiring, finishFiring, controlFiring, type KilnProfile, type Segment, type FiringLog, type Piece } from "./kiln-api";
import { useCapabilitiesFor } from "../../lib/can";
import { countOf } from "@cobblr/platform-contract/plural";
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
const input = "input w-full min-h-11";
const emptyProfile: KilnProfile = { connection_id: null, device_id: null, components: [], schedules: [] };
export function KilnPanel({ ctx }: { ctx: EntityDetailPanelCtx }) { return <KilnRecords ctx={ctx} />; }
export function KilnRecords({ ctx, station = false }: { ctx: EntityDetailPanelCtx; station?: boolean }) {
 const { slug, entityId: machine } = ctx, qc = useQueryClient(), toast = useToast();
 const [offset, setOffset] = useState(0), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false), [adding, setAdding] = useState(false);
 const query = useQuery({ queryKey: ["kiln", slug, machine, offset], queryFn: () => readKiln(slug, machine, offset), refetchInterval: station ? 15000 : false });
 const caps = useCapabilitiesFor(slug);
 const canRecord = capabilityAllows(caps, "digifab:kiln-log"), canOperate = capabilityAllows(caps, "digifab:operate");
 const canAuthorize = caps?.all === true, canRevoke = capabilityAllows(caps, "digifab:revoke-station");
 const stationPath = `/station/kiln/${machine}`;
 const storageKey = `kiln-station:${slug}:${query.data?.profile?.connection_id}:${query.data?.profile?.device_id}`;
 const [credential, setCredential] = useState<{ id: string; token: string; key: string } | null>(() => null);
 const saved = (() => { if (!station) return null; try { return JSON.parse(localStorage.getItem(storageKey) || "null") as { id: string; token: string; key: string } | null; } catch { return null; } })();
 const screen = credential?.key === storageKey ? credential : saved;
 async function run(work: () => Promise<unknown>) { setBusy(true); try { await work(); await qc.invalidateQueries({ queryKey: ["kiln", slug, machine] }); } catch(e) { toast.error(e instanceof Error ? e.message : "The firing log could not be saved."); } finally { setBusy(false); } }
 if (query.isError) return <QueryError what="Firing logs could not be loaded." onRetry={() => void query.refetch()} />;
 if (!query.data) return <p className="text-sm text-muted">Loading firing logs…</p>;
 const data = query.data, profile = data.profile, t = data.telemetry;
 if (!profile && !editing) return <details className="text-sm"><summary className="min-h-11 cursor-pointer flex items-center">Firing logs for a kiln</summary><p>Keep schedules, pieces and firing hours here, even without a connected controller.</p>{canRecord && <button className={button} disabled={busy} onClick={() => setEditing(true)}>Set up firing logs</button>}</details>;
 return <section data-testid="kiln-records" className="rounded-lg border border-line p-3 space-y-4 text-content">
  <header className="flex flex-wrap gap-2 items-center"><h3 className="flex-1 text-sm font-semibold">Firing logs</h3>{canRecord && profile && <button className={button} onClick={() => setEditing(!editing)}>Kiln settings</button>}{profile && !station && <WorkspaceLink className={button} slug={slug} to={`${stationPath}`}>Open kiln station</WorkspaceLink>}</header>
  {canRecord && editing && <ProfileForm slug={slug} profile={profile ?? emptyProfile} hours={data.firing_hours} busy={busy} save={p => void run(async () => { await saveKiln(slug, machine, p); setEditing(false); })} />}
  {profile && <>
   <p className="text-sm">{data.firing_hours.toFixed(1)} firing hours recorded</p>
   {data.reminders.map(r => <p role="status" key={r.name} className="rounded bg-amber-50 dark:bg-amber-950 p-3 text-amber-900 dark:text-amber-100">{r.name} needs replacement: {r.hours_used.toFixed(1)} hours used, due at {r.interval_hours}.</p>)}
   {data.connection_error && <p role="alert">{data.connection_error}</p>}
   {t && <div data-testid="kiln-telemetry" className="rounded bg-subtle p-3 space-y-1"><p className="text-xl font-semibold">{t.temperature_c.toFixed(1)} °C</p><p>{t.running ? `${t.schedule_name} · segment ${t.segment} of ${t.segments}` : "Controller idle"}</p><p>{(t.elapsed_sec / 3600).toFixed(1)} hours elapsed · {t.remaining_sec === null ? "Time remaining unavailable" : `${Math.ceil(t.remaining_sec / 60)} minutes remaining`}</p><p>{t.progress === null ? "Progress percentage unavailable" : `${Math.round(t.progress * 100)}% complete`} · {t.errors === null ? "Controller does not report faults" : t.errors.join(", ") || "No controller faults"}</p></div>}
   {!profile.connection_id && <p className="text-sm text-muted">Manual log. Start and stop the firing on the kiln's controller.</p>}
   <details><summary className="min-h-11 cursor-pointer flex items-center">Cone charts</summary><p className="text-sm">Cones measure heatwork. The equivalent temperature depends on heating rate, cone type and hold time. Keep the observed cone alongside the measured peak.</p><a className="text-accent min-h-11 inline-flex items-center" href="https://www.ortonceramic.com/pyrometric-cones-resources" target="_blank" rel="noreferrer">Open Orton's Celsius and Fahrenheit cone charts</a></details>
   {station && profile.connection_id && profile.device_id && <div className="space-y-2">
    <p>Keep this screen beside {ctx.entityTitle}. Start and Stop need permission to run machines and this screen's authorization.</p>
    {screen ? canRevoke && <button className={button} disabled={busy} onClick={() => void run(async () => { await api.revokeDigifabStation(slug, screen.id); localStorage.removeItem(storageKey); setCredential(null); })}>Revoke this screen</button> : canAuthorize && <button className={button} disabled={busy} onClick={() => void run(async () => { const result = await api.registerDigifabStation(slug, profile.connection_id!, profile.device_id!); const next = { id: result.id, token: result.token, key: storageKey }; localStorage.setItem(storageKey, JSON.stringify(next)); setCredential(next); })}>Authorize this kiln station</button>}
   </div>}
   {canRecord && <button className={button} disabled={busy} onClick={() => setAdding(!adding)}>New firing log</button>}
   {canRecord && adding && <NewFiring slug={slug} profile={profile} busy={busy} save={(id, recipe) => void run(async () => { await createFiring(slug, machine, id, recipe); setAdding(false); setOffset(0); })} saveSchedule={(name, segments) => void run(() => saveKiln(slug, machine, { ...profile, schedules: [...profile.schedules.filter(s => s.name !== name), { name, segments }] }))} />}
   <ol className="space-y-3">{data.items.map(log => <li key={log.id}><LogCard slug={slug} log={log} busy={busy} telemetryRunning={!!t?.running} finish={canRecord ? value => void run(() => finishFiring(slug, log.id, value)) : undefined} control={canOperate && station && screen && profile.connection_id ? operation => void run(() => controlFiring(slug, log.id, operation, screen.token)) : undefined} /></li>)}</ol>
   {data.total > 20 && <nav aria-label="Firing log pages" className="flex flex-wrap gap-3"><button className={button} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous firings</button><span className="py-3">{offset + 1}–{Math.min(offset + 20, data.total)} of {data.total}</span><button className={button} disabled={offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>Next firings</button></nav>}
  </>}
 </section>;
}
function ProfileForm({ slug, profile, hours, busy, save }: { slug: string; profile: KilnProfile; hours: number; busy: boolean; save: (p: KilnProfile) => void }) {
 const [value, setValue] = useState(profile);
 const connections = useQuery({ queryKey: ["digifab-connections", slug], queryFn: () => api.listDigifabConnections(slug) });
 const devices = useQuery({ queryKey: ["kiln-devices", slug, value.connection_id], queryFn: () => api.listDigifabDevices(slug, value.connection_id!), enabled: !!value.connection_id });
 return <form className="space-y-3" onSubmit={e => { e.preventDefault(); save(value); }}>
  <label className="block">Controller connection<select className={input} value={value.connection_id ?? ""} onChange={e => setValue({ ...value, connection_id: e.target.value || null, device_id: null })}><option value="">Manual log</option>{connections.data?.items.filter(c => c.type === "edge_adapter").map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
  <p className="text-sm text-muted">Networked kilns share one shop bridge. Set up an ESPHome kiln connection in Devices, then choose it here.</p>
  {value.connection_id && <label className="block">Kiln<select className={input} required value={value.device_id ?? ""} onChange={e => setValue({ ...value, device_id: e.target.value || null })}><option value="">Choose the kiln</option>{devices.data?.items.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select></label>}
  <h4 className="font-semibold">Elements and thermocouples</h4>
  {value.components.map((c, i) => <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" key={i}><label>Component<input className={input} required value={c.name} onChange={e => setValue({ ...value, components: value.components.map((p, j) => j === i ? { ...p, name: e.target.value } : p) })} /></label><label>Replace every (hours)<NumberField min={0.1} required className={input} value={c.interval_hours} onChange={n => setValue({ ...value, components: value.components.map((p, j) => j === i ? { ...p, interval_hours: n } : p) })} /></label><div className="text-sm space-y-1"><p>{Math.max(0, hours - c.replaced_at_hours).toFixed(1)} hours since replacement</p><button type="button" className={button} onClick={() => setValue({ ...value, components: value.components.map((p, j) => j === i ? { ...p, replaced_at_hours: hours } : p) })}>Replaced now</button><button type="button" className={button} onClick={() => setValue({ ...value, components: value.components.filter((_, j) => j !== i) })}>Remove component</button></div></div>)}
  <button type="button" className={button} onClick={() => setValue({ ...value, components: [...value.components, { name: value.components.length ? "Thermocouple" : "Elements", interval_hours: 200, replaced_at_hours: hours }] })}>Add wearing component</button>
  <button className={button} disabled={busy || !!value.connection_id && !value.device_id}>Save kiln settings</button>
 </form>;
}
function NewFiring({ slug, profile, busy, save, saveSchedule }: { slug: string; profile: KilnProfile; busy: boolean; save: (id: string, recipe: { name: string; cone: string; schedule: Segment[]; pieces: Piece[]; glazes: Array<{ part_id: string; kind?: string; ml: number }>; notes: string }) => void; saveSchedule: (name: string, segments: Segment[]) => void }) {
 const [id] = useState(() => randomId()), [name, setName] = useState(""), [cone, setCone] = useState(""), [notes, setNotes] = useState("");
 const [savedSchedule, setSavedSchedule] = useState(""), [schedule, setSchedule] = useState<Segment[]>([{ ramp_c_per_hour: 100, target_c: 1000, hold_minutes: 0 }]);
 const [pieces, setPieces] = useState<Piece[]>([]), [glazes, setGlazes] = useState<Array<{ part_id: string; kind?: string; title: string; ml: number }>>([]);
 return <form data-testid="new-firing" className="space-y-3 rounded border border-line p-3" onSubmit={e => { e.preventDefault(); save(id, { name, cone, schedule, pieces, glazes, notes }); }}>
  <label className="block">Firing name<input className={input} required maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
  <label className="block">Cone (optional)<input className={input} maxLength={20} placeholder="04, 6, or glass firing" value={cone} onChange={e => setCone(e.target.value)} /></label>
  <label className="block">Saved schedule<select className={input} value={savedSchedule} onChange={e => { setSavedSchedule(e.target.value); const s = profile.schedules.find(s => s.name === e.target.value); if (s) setSchedule(s.segments); }}><option value="">Custom schedule</option>{profile.schedules.map(s => <option key={s.name}>{s.name}</option>)}</select></label>
  <p className="text-sm text-muted">All schedule temperatures are Celsius. A cooling segment uses a positive ramp rate and a lower target.</p>
  {schedule.map((s, i) => <fieldset key={i} className="grid grid-cols-1 sm:grid-cols-3 gap-2"><legend className="text-sm">Segment {i + 1}</legend>{([['ramp_c_per_hour', 'Ramp (°C/hour)', 1, 999999], ['target_c', 'Target (°C)', 0, 1500], ['hold_minutes', 'Hold (minutes)', 0, 1440]] as const).map(([key, label, min, max]) => <label key={key}>{label}<NumberField integer required min={min} max={max} className={input} value={s[key]} onChange={n => setSchedule(schedule.map((p, j) => i === j ? { ...p, [key]: n } : p))} /></label>)}{schedule.length > 1 && <button type="button" className={button} onClick={() => setSchedule(schedule.filter((_, j) => j !== i))}>Remove segment {i + 1}</button>}</fieldset>)}
  <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={schedule.length >= 32} onClick={() => setSchedule([...schedule, { ramp_c_per_hour: 100, target_c: 1000, hold_minutes: 0 }])}>Add segment</button><button type="button" className={button} disabled={busy || !name.trim()} onClick={() => saveSchedule(name, schedule)}>Save this schedule</button></div>
  <h4 className="font-semibold">Pieces in the load</h4><ThingPicker slug={slug} label="Find a piece" onPick={p => { if (!pieces.some(s => s.id === p.id && s.kind === p.kind)) setPieces([...pieces, { kind: p.kind, id: p.id, title: p.title }]); }} />
  <ul className="space-y-1">{pieces.map(p => <li key={`${p.kind}:${p.id}`} className="flex flex-wrap gap-2 items-center"><span className="flex-1 break-words">{p.title}</span><button type="button" className={button} onClick={() => setPieces(pieces.filter(s => s !== p))}>Remove {p.title}</button></li>)}</ul>
  <h4 className="font-semibold">Glaze used</h4><p className="text-sm text-muted">Choose a record configured as liquid workshop stock. Finishing this log takes off the recorded amount once, including failed firings.</p><GlazePicker slug={slug} onPick={p => { if (!glazes.some(g => g.part_id === p.id)) setGlazes([...glazes, { part_id: p.id, kind: p.kind, title: p.name, ml: 1 }]); }} />
  {glazes.map(g => <div key={g.part_id} className="flex flex-wrap gap-2 items-center"><label className="flex-1 min-w-0">{g.title} used (ml)<NumberField required min={0.01} className={input} value={g.ml} onChange={n => setGlazes(glazes.map(p => p === g ? { ...p, ml: n } : p))} /></label><button type="button" className={button} onClick={() => setGlazes(glazes.filter(p => p !== g))}>Remove glaze</button></div>)}
  <label className="block">Load notes<textarea className={input} maxLength={10000} value={notes} onChange={e => setNotes(e.target.value)} /></label>
  <button className={button} disabled={busy || !name.trim()}>Save firing log</button>
 </form>;
}
function GlazePicker({ slug, onPick }: { slug: string; onPick: (p: { id: string; kind: string; name: string }) => void }) {
 const [text, setText] = useState("");
 // Glazes are Inventory's liquid stock: with it off the picker asks nothing.
 const inventoryOn = !!useEnabledModules(slug)?.has("inventory");
 const found = useInfiniteQuery({ queryKey: ["kiln-glaze-stock", slug, text], initialPageParam: 0, enabled: inventoryOn,
  queryFn: ({ pageParam }) => api.listWorkshopStock(slug, { q: text, shape: "liquid", offset: pageParam }),
  getNextPageParam: (last, pages) => { const count = pages.reduce((n, p) => n + p.items.length, 0); return last.total !== null && count < last.total ? count : undefined; },
 });
 return <div className="space-y-2"><SearchInput aria-label="Find a glaze" placeholder="Find a glaze" value={text} onChange={setText} />
  {found.isError && <QueryError what="Liquid stock could not be found." onRetry={() => void found.refetch()} />}
  <ul className="max-h-48 overflow-auto">{found.data?.pages.flatMap(p => p.items).map(p => <li key={p.id}><button type="button" className={`${button} w-full text-left`} onClick={() => onPick(p)}>{p.name} · {p.remaining} ml left</button></li>)}</ul>
  {found.hasNextPage && <button type="button" className={button} disabled={found.isFetchingNextPage} onClick={() => void found.fetchNextPage()}>More liquid stock</button>}
  {found.data && !found.data.pages.some(p => p.items.length > 0) && <p className="text-sm text-muted">No liquid stock found. Set the glaze's workshop stock shape to Liquid on its record.</p>}
 </div>;
}
function ThingPicker({ slug, label, onPick }: { slug: string; label: string; onPick: (p: PlatformResolvedEntity) => void }) {
 const [kind, setKind] = useState("inventory:part"), [text, setText] = useState("");
 const kinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug) });
 const found = useQuery({ queryKey: ["kiln-piece-picker", slug, kind, text], queryFn: () => api.listEntities(slug, kind, text), enabled: text.trim().length > 0 });
 return <div className="space-y-2"><label className="block">Piece collection<select className={input} value={kind} onChange={e => setKind(e.target.value)}>{kinds.data?.items.filter(k => k.id !== "digifab:firing").map(k => <option key={k.id} value={k.id}>{k.display_name_plural ?? k.display_name}</option>)}</select></label><SearchInput aria-label={label} placeholder={label} value={text} onChange={setText} />{found.isError && <QueryError what="The records could not be found." onRetry={() => void found.refetch()} />}<ul className="max-h-48 overflow-auto">{found.data?.items.map(p => <li key={p.id}><button type="button" className={`${button} w-full text-left`} onClick={() => { onPick(p); setText(""); }}>{p.title}</button></li>)}</ul></div>;
}
function LogCard({ slug, log, busy, telemetryRunning, finish, control }: { slug: string; log: FiringLog; busy: boolean; telemetryRunning: boolean; finish?: (p: { peak_c: number; duration_hours: number; outcome: string }) => void; control?: (operation: "start" | "stop") => void }) {
 const [edited, setEdited] = useState(false);
 const [hours, setHours] = useState(log.duration_hours ?? 0), [peak, setPeak] = useState(log.peak_c ?? 0), [outcome, setOutcome] = useState("completed"), [confirm, setConfirm] = useState<"start" | "stop" | null>(null);
 useEffect(() => { if (!edited) { setHours(log.duration_hours ?? 0); setPeak(log.peak_c ?? 0); } }, [edited, log.duration_hours, log.peak_c]);
 return <article className="rounded border border-line p-3 space-y-2"><h4 className="font-semibold break-words">{log.name}</h4><p>{log.status} · {log.recipe.cone ? `cone ${log.recipe.cone}` : "No cone recorded"}</p>
  <details><summary className="min-h-11 cursor-pointer flex items-center">Schedule and load ({countOf(log.recipe.pieces.length, "piece")})</summary><ol>{log.recipe.schedule.map((s, i) => <li key={i}>Segment {i + 1}: {s.ramp_c_per_hour} °C/hour to {s.target_c} °C, hold {s.hold_minutes} minutes.</li>)}</ol><ul>{log.recipe.pieces.map(p => <li key={`${p.kind}:${p.id}`}><PieceLink slug={slug} piece={p} /></li>)}</ul><p className="whitespace-pre-wrap break-words">{log.recipe.notes}</p>{log.recipe.glazes.map(g => <p key={g.part_id}>{g.ml} ml of glaze recorded</p>)}</details>
  {log.ended_at ? <p>{log.peak_c} °C peak · {log.duration_hours} hours · {new Date(log.ended_at).toLocaleDateString()}</p> : <>
   {control && <div className="flex flex-wrap gap-2">{log.status === "planned" && <button className={button} disabled={busy || telemetryRunning} onClick={() => setConfirm("start")}>Start this firing</button>}<button className={button} disabled={busy} onClick={() => setConfirm("stop")}>Stop kiln</button></div>}
   {confirm && <div role="alert" className="rounded border border-line p-3 space-y-2"><p>{confirm === "start" ? "Check the load, lid, ventilation and schedule at the kiln before starting." : "Stop the kiln's heating now?"}</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => { control?.(confirm); setConfirm(null); }}>{confirm === "start" ? "Confirm Start at this station" : "Confirm Stop at this station"}</button><button className={button} onClick={() => setConfirm(null)}>Cancel</button></div></div>}
   {finish && <form className="grid grid-cols-1 sm:grid-cols-3 gap-2" onSubmit={e => { e.preventDefault(); finish({ duration_hours: hours, peak_c: peak, outcome }); }}><label>Firing duration (hours)<NumberField className={input} min={0.01} max={1000} required value={hours} onChange={n => { setEdited(true); setHours(n); }} /></label><label>Measured peak (°C)<NumberField className={input} min={0} max={1500} required value={peak} onChange={n => { setEdited(true); setPeak(n); }} /></label><label>Outcome<select className={input} value={outcome} onChange={e => setOutcome(e.target.value)}><option value="completed">Completed</option><option value="failed">Failed</option><option value="stopped">Stopped</option></select></label><button className={button} disabled={busy || telemetryRunning || hours <= 0}>Finish firing log</button></form>}
  </>}
 </article>;
}
function PieceLink({ slug, piece }: { slug: string; piece: Piece }) {
 const q = useQuery({ queryKey: ["kiln-piece", slug, piece.kind, piece.id], queryFn: () => api.lookupEntity(slug, piece.kind, piece.id) });
 const label = q.data?.title ?? piece.title ?? "Piece in this load";
 return q.data?.detailUrl ? <WorkspaceLink className="inline-flex min-h-11 items-center text-accent" slug={slug} to={`${q.data.detailUrl}`}>{label}</WorkspaceLink> : <span>{label}</span>;
}
