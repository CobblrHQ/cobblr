import {LargeFormatStation} from "../features/digifab/LargeFormatStation";
import { jobDisplayName } from "../features/digifab/jobDisplayName";
import { countOf } from "@cobblr/platform-contract/plural";
import { CutterStation } from "../features/digifab/CutterStation";
import { fabricationMachineName, fabricationBridgeName, fabricationFullName } from "../lib/fabrication-display";
import { LaserDrawing } from "../features/digifab/LaserLayout";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { EntityPhoto, Modal, SearchInput, useImageSrc, usePageTitle, useRunAction } from "@cobblr/platform-web";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api, ApiError, type DigifabJobReview, type LaserMaterialTag } from "../lib/api";
import { resolveScannedThing, useScanTarget } from "../lib/scanTarget";
import { GlobalScanWedge } from "../components/GlobalScanWedge";
import { ScanOneSheet } from "../components/ScanOneSheet";
import type {GalvoSetupMemory} from "../features/digifab/GalvoSetupFields";
import { LaserSetupPanel } from "../features/digifab/LaserSetupPanel";
import { DirectLaserControls } from "../features/digifab/DirectLaserControls";
import { LightBurnReview } from "../features/digifab/startReview";
import { LaserMaterialForm } from "../features/digifab/laserMaterial";

import { ResinStation } from "../features/digifab/ResinStation";
import { PrintStation } from "../features/digifab/PrintStation";

const button = "min-h-12 rounded border border-line px-4 py-3 text-base disabled:opacity-50";
const errorText = (e: unknown) => e instanceof ApiError ? e.message : String(e);

export function MachineStationPage() {
  const { activeSlug: slug } = useActiveOrg();
  const { connectionId = "", deviceId = "" } = useParams();
  const q = useQuery({ queryKey: ["digifab-station", slug, connectionId, deviceId, ""], queryFn: () => api.digifabStation(slug, connectionId, deviceId), refetchInterval: 4000 });
  if (!q.data && !q.error) return <p>Loading the station…</p>;
  if (q.error && !q.data) return <UnavailableMachineStation error={q.error} />;
  const screenKind = q.data?.screen_kind === undefined ? q.data?.kind : q.data.screen_kind;
  switch (screenKind === q.data?.kind ? screenKind : null) {
    case "laser": return <LaserMachineStationPage />;
    case "cutter": return <CutterStation slug={slug} connectionId={connectionId} deviceId={deviceId} />;
    case "resin": return <ResinStation slug={slug} connectionId={connectionId} deviceId={deviceId} />;
    case "print": return <PrintStation slug={slug} connectionId={connectionId} deviceId={deviceId} />;
    case "large-format": return <LargeFormatStation slug={slug} connectionId={connectionId} deviceId={deviceId} />;
    default: return <UnavailableMachineStation kind={q.data?.kind} />;
  }
}

const stationTitles: Readonly<Record<string, string>> = {
  laser: "Laser station", print: "Printer station", cutter: "Cutter station", resin: "Resin station",
  kiln: "Kiln station", cnc: "CNC station", embroidery: "Embroidery station", "large-format": "Large format station",
};
function UnavailableMachineStation({ kind, error }: { kind?: string | null; error?: unknown }) {
  const title = kind && Object.hasOwn(stationTitles, kind) ? stationTitles[kind]! : "Machine station";
  usePageTitle(title);
  return <><SkipToContent /><main id={MAIN_ID} className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
    <h1 className="text-2xl font-semibold">{title}</h1>
    {error ? <p role="alert">{errorText(error)}</p> : <p>This machine has no station screen yet.</p>}
    <Link className={button} to="/digifab">Exit to the fleet</Link>
  </main></>;
}

function LaserMachineStationPage() {
  const { activeSlug: slug } = useActiveOrg();
  usePageTitle("Laser station");
  // PRESS-ARGS: The confirmed sheet supplies the label target; this action has no other inputs.
  const runAction = useRunAction();
  const { connectionId = "", deviceId = "" } = useParams();
  const storageKey = `cobblr.machine-station.${slug}.${connectionId}.${deviceId}`;
  const [credential, setCredential] = useState<{ id: string; token: string } | null>(() => { try { return JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { return null; } });
  const [error, setError] = useState("");
  const operation = useMutation({ mutationKey: ["machine-station", slug, connectionId, deviceId], mutationFn: (work: () => Promise<void>) => work() });
  const busy = operation.isPending;
  const working = useRef(false);
  const [setupEpoch,setSetupEpoch]=useState(0);
  const [review, setReview] = useState<DigifabJobReview | null>(null);
  const [confirmed, setConfirmed] = useState<{ id: string; name: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pick, setPick] = useState("");
  const [search, setSearch] = useState("");
  const [editSheet, setEditSheet] = useState(false);
  const [editFile, setEditFile] = useState(false);
  const [labelNag, setLabelNag] = useState(false);
  const [suggestion, setSuggestion] = useState<Partial<LaserMaterialTag> | undefined>();
  const q = useQuery({ queryKey: ["digifab-station", slug, connectionId, deviceId, search], queryFn: () => api.digifabStation(slug, connectionId, deviceId, search), refetchInterval: 4000 });
  const fleet = useQuery({ queryKey: ["digifab-fleet", slug], queryFn: () => api.getDigifabFleet(slug) });
  const bridges = useQuery({ queryKey: ["edge-bridges", slug], queryFn: () => api.listEdgeBridges(slug) });
  const connection = fleet.data?.connections.find(c => c.connection_id === connectionId);
  const device = connection?.devices.find(d => d.id === deviceId);
  const direct = !!device?.laser_backend;
  const galvo = device?.laser_backend === "galvo";
  const profileScope=useRef(storageKey);
  const galvoMemory=useRef<GalvoSetupMemory>({draft:{},correction:null});
  if(profileScope.current!==storageKey){profileScope.current=storageKey;galvoMemory.current={draft:{},correction:null};}
  const screens = useQuery({ queryKey: ["digifab-station-screens", slug], queryFn: () => api.listDigifabStations(slug) });
  const inventoryKinds = useQuery({ queryKey: ["entity-kinds", slug], queryFn: () => api.listEntityKinds(slug), staleTime: 300_000 });
  const data = q.data;
  const job = data?.job;
  const library = data?.library;
  const material = library?.metadata?.laser_material;
  const layout = library?.metadata?.laser_layout;
  const currentContext = useRef("");
  currentContext.current = `${storageKey}:${job?.id}:${job?.status}:${JSON.stringify(material)}`;
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!job || job.status === "queued") return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [job?.id, job?.status]);
  const elapsed = job?.sent_at ? Math.max(0, Math.floor((now - new Date(job.sent_at).getTime()) / 1000)) : null;
  const startNeedsAttention = job?.status === "sent" && job.sent_at && Date.now() - new Date(job.sent_at).getTime() > 15_000;
  const thumb = useImageSrc(library?.thumbnail_file_id ? api.fileRawUrl(slug, library.thumbnail_file_id) : null);
  const stationPath = `/station/machine/${connectionId}/${encodeURIComponent(deviceId)}`;

  useEffect(() => { try { setCredential(JSON.parse(localStorage.getItem(storageKey) || "null")); } catch { setCredential(null); } setConfirmed(null); setReview(null); setPick(""); }, [storageKey]);
  useEffect(() => { setConfirmed(null); setReview(null); setSuggestion(undefined); setError(""); }, [job?.id, job?.status, JSON.stringify(material)]);
  useEffect(() => {
    let stopped = false;
    let lock: WakeLockSentinel | undefined;
    const acquire = async () => { if (document.visibilityState !== "visible" || !navigator.wakeLock) return; try { const next = await navigator.wakeLock.request("screen"); if (stopped) await next.release(); else lock = next; } catch { /* the tablet can deny staying awake */ } };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => { stopped = true; document.removeEventListener("visibilitychange", acquire); void lock?.release(); };
  }, []);

  const run = async (work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setError("");
    try { await operation.mutateAsync(work); } catch (e) { setError(errorText(e)); } finally { working.current = false; }
  };
  const confirmSheet = async (id: string, manual: boolean): Promise<string> => {
    setConfirmed(null);
    if (!job || !credential) throw new Error("Set up this screen and choose a queued job first.");
    const context = currentContext.current;
    const result = await api.confirmLaserSheet(slug, connectionId, deviceId, job.id, id, credential.token);
    if (context !== currentContext.current) throw new Error("The job changed. Confirm the loaded sheet for this job again.");
    setConfirmed(result); setPick(id); setError("");
    if (manual) {
      const key = `cobblr.sheet-label-reminder.${slug}.${id}`;
      if (!localStorage.getItem(key)) { localStorage.setItem(key, "seen"); setLabelNag(true); }
    }
    return `${result.name}: material matches. ${galvo?"Place it within the confirmed lens field and check it with the red guide.":"Load it against the corner stop."}`;
  };
  // The station keeps every sheet scan, ready or not, and says why one cannot
  // load yet, rather than the app-wide wedge opening the sheet's record and
  // taking the person off the station (review of #4880).
  useScanTarget({
    takes: kind => kind === "inventory:part" || inventoryKinds.data?.items.some(k => k.id === kind && k.module_name === "inventory") === true,
    take: async thing => {
      if (!credential) throw new Error("Authorize this station before loading a sheet.");
      if (job?.status !== "queued") throw new Error("No job is waiting for a sheet at this station.");
      try { return await confirmSheet(thing.id, false); } catch (e) { setError(errorText(e)); throw e; }
    },
  });
  const scanned = async (code: string) => {
    setScanning(false);
    await run(async () => {
      const thing = await resolveScannedThing(slug, code);
      if (!thing || thing.kind !== "inventory:part") throw new Error("That code is not a sheet in this workspace.");
      await confirmSheet(thing.id, false);
    });
  };
  const saveFile = (tag: LaserMaterialTag) => run(async () => { if (!library) return; await api.renameDigifabLibrary(slug, library.id, { laser_material: tag }); setEditFile(false); await q.refetch(); });

  return <><SkipToContent /><main id={MAIN_ID} tabIndex={-1} className="min-h-screen bg-surface text-content p-4 sm:p-6 max-w-5xl mx-auto space-y-5" data-testid="machine-station">
    <GlobalScanWedge activeSlug={slug} />
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Laser station</h1><p className="text-muted break-all">{connection && device ? fabricationFullName(fabricationMachineName(connection, device), fabricationBridgeName(connection, bridges.data?.bridges ?? [])) : "Laser"}</p></div><details className="text-sm"><summary className="cursor-pointer min-h-11 flex items-center">Station settings</summary><div className="space-y-3 py-3"><Link to="/digifab" className="block">Exit to the fleet</Link><button className={button} onClick={() => void run(async () => { await navigator.clipboard.writeText(`${window.location.origin}/w/${slug}${stationPath}`); })}>Copy station link</button>{credential && <button className={button} disabled={busy} onClick={() => void run(async () => { await api.revokeDigifabStation(slug, credential.id); localStorage.removeItem(storageKey); setCredential(null); setReview(null); setConfirmed(null); await screens.refetch(); })}>Revoke this screen</button>}{screens.data?.items.filter(s => s.connection_id === connectionId && s.remote_device_id === deviceId && !s.revoked_at).map(s => <div key={s.id} className="flex flex-wrap gap-2 items-center"><span>{s.label} · {s.id.slice(0, 8)}</span><button className={button} disabled={busy} onClick={() => void run(async () => { await api.revokeDigifabStation(slug, s.id); if (credential?.id === s.id) { localStorage.removeItem(storageKey); setCredential(null); setReview(null); setConfirmed(null); } await screens.refetch(); })}>Revoke screen</button></div>)}</div></details></header>
    {(error || q.error) && <p role="alert" className="rounded border border-red-500 bg-red-50 dark:bg-red-950 p-4 break-words">{error || errorText(q.error)}</p>}
    {startNeedsAttention && !direct && <p role="alert" className="rounded border border-line p-4">LightBurn needs attention on its screen. Start was sent, but running has not been reported. Check the screen and machine before continuing.</p>}
    {direct && !review && <DirectLaserControls atStation slug={slug} connectionId={connectionId} deviceId={deviceId} status={job?.status} onAccepted={() => {setSetupEpoch(v=>v+1);void q.refetch();}} />}
    {device?.laser_setup && !review && <LaserSetupPanel galvoMemory={galvoMemory} key={`${storageKey}:${job?.status}:${setupEpoch}`} slug={slug} connectionId={connectionId} deviceId={deviceId} stationToken={credential?.token} blocked={busy||!!data?.attention||!!(job&&job.status!=="queued")} />}
    {!credential && <section className="rounded border border-line p-4 space-y-3"><h2 className="text-xl font-semibold font-mono uppercase tracking-wide">Set this screen up at the laser</h2><p>Keep this tablet beside the machine. An owner or admin must be signed in to approve and start jobs here.</p><button className={button} disabled={busy} onClick={() => void run(async () => { const result = await api.registerDigifabStation(slug, connectionId, deviceId); const next = { id: result.id, token: result.token }; localStorage.setItem(storageKey, JSON.stringify(next)); setCredential(next); await screens.refetch(); })}>Authorize this machine station</button></section>}
    {credential && !data && !q.error && <p>Loading the station…</p>}
    {data?.attention ? <section className="rounded border border-line p-5 space-y-4"><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide">Take out the pieces. Came out good?</h2><p>Leave the machine clear for the next job.</p><div className="flex flex-wrap gap-3"><button className={`${button} bg-ember-600 text-white`} disabled={busy} onClick={() => void run(async () => { await api.markDigifabDeviceReady(slug, connectionId, deviceId, "good"); await q.refetch(); })}>Yes, came out good</button><button className={button} disabled={busy} onClick={() => void run(async () => { await api.markDigifabDeviceReady(slug, connectionId, deviceId, "scrapped"); await q.refetch(); })}>No, scrap these pieces</button></div></section> : job ? <>
      <section className="grid md:grid-cols-2 gap-5 rounded border border-line p-4">
        <div className="space-y-4"><h2 className="text-xl font-semibold font-mono uppercase tracking-wide break-words">{jobDisplayName(job)}</h2>{layout && material ? <LaserDrawing design={layout.design} parts={layout.parts} width={material.width_mm} height={material.height_mm} /> : thumb ? <EntityPhoto src={thumb} alt="Design to cut" fit="contain" aspect="16/9" /> : <p className="rounded bg-subtle p-4">No design thumbnail was saved in this file.</p>}
        {job.status !== "queued" ? <><p className="text-xl">{job.status === "sent" ? direct ? "Start sent, waiting for the laser to report running" : "Start sent, waiting for LightBurn to report running" : job.status === "paused" ? "Paused" : "Running"}{job.progress != null ? ` · ${Math.round(job.progress * 100)}%` : ""}</p><progress aria-label="Job progress" max={100} value={job.progress == null ? undefined : Math.min(100, Math.max(0, job.progress * 100))} className="block h-6 w-full accent-ember-600" /><p>{direct ? "Keep the machine supervised. Use Stop laser here or the stop at the machine." : "Keep the machine supervised. Stop it in LightBurn or at the machine."}</p></> : <>
          <h3 className="text-lg font-semibold font-mono uppercase tracking-wide">What to load</h3>{material ? <><p className="text-2xl">{material.thickness_mm} mm {material.material}</p><p className="text-lg">At least {material.width_mm} × {material.height_mm} mm</p>{!layout && <button className={button} onClick={() => setEditFile(true)}>Edit file material</button>}</> : <><p>Save the material and sheet size this prepared file needs.</p><button className={button} disabled={!credential || busy} onClick={() => void run(async () => { const context = currentContext.current; const result = await api.prepareDigifabJob(slug, job.id, credential!.token); if (context !== currentContext.current) throw new Error("The job changed. Review this job again."); if (!result.review) throw new Error("Authorize this screen for this laser first."); const match = result.review.materialSuggestion; if (!match) throw new Error("No unique material library entry matches these settings. Enter the material yourself."); setSuggestion(match); })}>Read material from LightBurn</button><LaserMaterialForm key={JSON.stringify(suggestion)} initial={suggestion} onSave={saveFile} busy={busy} /></>}
        </>}</div>
        {job.status !== "queued" && <section aria-label="Running job facts" className="space-y-4 min-w-0"><h3 className="text-xl font-semibold font-mono uppercase tracking-wide">Job facts</h3><dl className="space-y-3"><div><dt className="text-muted">Material</dt><dd className="text-2xl">{material ? `${material.thickness_mm} mm ${material.material}` : "Not reported"}</dd></div><div><dt className="text-muted">Elapsed since Start</dt><dd className="text-2xl">{elapsed == null ? "Not reported" : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}</dd></div></dl><h4 className="font-semibold">Settings summary</h4>{layout?.expected?.length ? layout.expected.map(settings => <p key={settings.index} className="break-words">{settings.operation} · {settings.speed} mm/s · {settings.min_power}% to {settings.max_power}% power · {countOf(settings.passes, "pass")} · Air assist {settings.air_assist ? "on" : "off"} · Focus offset {settings.focus_offset} mm</p>) : <p>No saved settings summary is available for this file.</p>}</section>}
        {job.status === "queued" && <div className="space-y-4"><h3 className="text-lg font-semibold font-mono uppercase tracking-wide">{galvo?"Within the lens field":"Against the corner stop"}</h3>{galvo?<svg viewBox="0 0 300 200" role="img" aria-label="Place the sheet within the confirmed lens field" className="w-full max-h-48"><rect x="20" y="10" width="270" height="180" fill="none" stroke="currentColor" /><rect x="55" y="45" width="190" height="110" fill="currentColor" opacity="0.15" /><rect x="80" y="60" width="100" height="70" fill="none" stroke="red" strokeDasharray="5 5" /></svg>:<svg viewBox="0 0 300 200" role="img" aria-label="Load the sheet against the lower left corner stop" className="w-full max-h-48"><rect x="20" y="10" width="270" height="180" fill="none" stroke="currentColor" /><path d="M25 125 V185 H85" fill="none" stroke="currentColor" strokeWidth="6" /><rect x="30" y="55" width="180" height="125" fill="currentColor" opacity="0.15" /><path d="M120 90 L45 163 M45 140 V163 H68" fill="none" stroke="currentColor" strokeWidth="3" /></svg>}
          {layout && <p>Load the sheet chosen for this layout. This sheet makes {countOf(layout.quantity, "part")}.</p>}
          <p>{galvo?"Place the sheet within the confirmed lens field. Keep the saved lower left origin and sheet orientation. Set focus at the machine, then check the bounds with the red guide.":"Load the sheet at the machine’s corner stop. Keep the saved origin and sheet orientation."}</p>
          <button className={button} disabled={!credential || busy || !material} onClick={() => setScanning(true)}>Scan sheet QR</button>
          <label className="block">Find a sheet<SearchInput value={search} onChange={setSearch} placeholder="Search your inventory" aria-label="Find a sheet" /></label>
          <label className="block">Sheet without a label<select className="block min-h-12 w-full rounded border border-line bg-surface px-3" value={pick} onChange={e => { setPick(e.target.value); setConfirmed(null); }}><option value="">Choose a sheet</option>{data.sheets.map(s => <option key={s.id} value={s.id}>{s.name}{s.material ? ` · ${s.material.thickness_mm} mm ${s.material.material}` : " · needs sheet details"}</option>)}</select></label>
          {pick && <div className="flex flex-wrap gap-3"><button className={button} disabled={!credential || !material || busy} onClick={() => void run(async () => { await confirmSheet(pick, true); })}>Confirm loaded sheet</button><button className={button} onClick={() => setEditSheet(true)}>Edit sheet details</button></div>}
          {confirmed && <p role="status" className="rounded border border-green-600 p-3">{confirmed.name}: material matches.</p>}
          <button className={`${button} bg-ember-600 text-white w-full`} disabled={!credential || !confirmed || !material || busy} onClick={() => void run(async () => { const context = currentContext.current; const result = await api.prepareDigifabJob(slug, job.id, credential!.token); if (context !== currentContext.current) throw new Error("The job changed. Review this job again."); if (!result.review) throw new Error("This station's approval was revoked. Set the screen up again."); setReview({ ...result.review, thumbnailFileId: library?.thumbnail_file_id }); })}>Review and start</button>
        </div>}
      </section>
    </> : data ? <section className="rounded border border-line p-6"><h2 className="text-2xl font-semibold font-mono uppercase tracking-wide">Ready for the next job</h2><p className="mt-2">Upload an SVG or DXF in the library and prepare a batch with a material profile and physical sheet. You can also queue a prepared LightBurn file.</p><Link className="inline-block mt-4 underline" to="/digifab">Open the file library</Link></section> : null}
    {labelNag && confirmed && <section className="rounded border border-line p-4 space-y-3"><p>Queue a QR label for this sheet so next time you can scan it.</p><div className="flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => void run(async () => { await runAction({ actionId: "labels:print", entityKind: "inventory:part", entityId: confirmed.id }); setLabelNag(false); })}>Queue sheet label</button><Link className={`${button} inline-flex items-center`} to="/labels">Open labels</Link><button className={button} onClick={() => setLabelNag(false)}>Later</button></div></section>}
    {review && job && <LightBurnReview slug={slug} review={review} library={library ?? undefined} starting={busy} error={error} controls={direct ? <DirectLaserControls atStation slug={slug} connectionId={connectionId} deviceId={deviceId} status={job.status} onAccepted={() => {setSetupEpoch(v=>v+1);void q.refetch();}} /> : undefined} atStation onFrame={direct ? () => void run(async () => { await api.runDigifabControl(slug, connectionId, deviceId, "frame", { fileId: review.fileId, jobId: job.id }); }) : undefined} onClose={() => { if (!busy) setReview(null); }} onStart={() => void run(async () => { if (!credential || !confirmed) throw new Error("Confirm the loaded sheet first."); try { await api.sendDigifabJob(slug, job.id, { fileId: review.fileId, projectHash: review.projectHash, stationToken: credential.token, sheetId: confirmed.id }); } finally { setReview(null); setConfirmed(null); await q.refetch(); } })} />}
    {editFile && library && <Modal open title="File material" onClose={() => setEditFile(false)}><LaserMaterialForm initial={material ?? review?.materialSuggestion ?? undefined} onSave={saveFile} busy={busy} /></Modal>}
    {editSheet && pick && <Modal open title="Sheet details" onClose={() => setEditSheet(false)}><LaserMaterialForm initial={data?.sheets.find(s => s.id === pick)?.material ?? undefined} busy={busy} onSave={tag => run(async () => { await api.saveLaserSheet(slug, pick, tag); setEditSheet(false); setConfirmed(null); await q.refetch(); })} /></Modal>}
    {scanning && <ScanOneSheet open title="Scan sheet QR" hint={galvo?"Scan the sheet placed within the lens field.":"Scan the sheet you have loaded against the corner stop."} onCode={code => void scanned(code)} onClose={() => setScanning(false)} />}
  </main></>;
}
