import { jobDisplayName } from "./jobDisplayName";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Modal, usePageTitle } from "@cobblr/platform-web";
import { MAIN_ID, SkipToContent } from "../../components/a11y/shell-landmarks";
import { api, ApiError, type DigifabJobReview } from "../../lib/api";
import { ToolTemperatures } from "./ToolTemperatures";
import {StationInstall} from "./StationInstall";
import {keepStationScreenAwake} from "../../lib/station-screen";

const button = "min-h-12 rounded border border-line px-4 py-3 text-base disabled:opacity-50";
export function PrintStation({ slug, connectionId, deviceId }: { slug: string; connectionId: string; deviceId: string }) {
  usePageTitle("Printer station");
  const storageKey = `cobblr.machine-station.${slug}.${connectionId}.${deviceId}`;
  const readCredential = () => { try { return JSON.parse(localStorage.getItem(storageKey) || "null") as { id: string; token: string } | null; } catch { return null; } };
  const [credential, setCredential] = useState(readCredential);
  const [review, setReview] = useState<{ value: DigifabJobReview; context: string } | null>(null);
  const [error, setError] = useState("");
  const [reviewRefused, setReviewRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const q = useQuery({ queryKey: ["digifab-station", slug, connectionId, deviceId, ""], queryFn: () => api.digifabStation(slug, connectionId, deviceId), refetchInterval: 4000 });
  const fleet = useQuery({ queryKey: ["digifab-fleet", slug], queryFn: () => api.getDigifabFleet(slug), refetchInterval: 4000 });
  const device = fleet.data?.connections.find(c => c.connection_id === connectionId)?.devices.find(d => d.id === deviceId);
  const job = q.data?.job;
  const context = `${storageKey}:${job?.id}:${job?.status}`;
  const currentContext = useRef(context);
  currentContext.current = context;
  useEffect(() => { setCredential(readCredential()); setReview(null); }, [storageKey]);
  useEffect(() => { setReview(null); setError(""); setReviewRefused(false); }, [context]);
  const keepAwake = busy || !!job && ["sent", "printing", "paused", "assigning", "awaiting-assignment"].includes(job.status);
  useEffect(() => {
    if (keepAwake) return keepStationScreenAwake(document, navigator.wakeLock);
    return undefined;
  }, [keepAwake]);
  const operation = useMutation({ mutationFn: async (work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { working.current = false; setBusy(false); }
  } });
  const run = (work: () => Promise<void>) => operation.mutateAsync(work);
  const currentReview = review?.context === context ? review.value : null;
  return <><SkipToContent /><main id={MAIN_ID} tabIndex={-1} data-testid="machine-station" className="min-h-screen max-w-5xl mx-auto bg-surface text-content p-4 sm:p-6 space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Printer station</h1><p className="break-words text-muted">{device?.name || "Snapmaker printer"}</p></div><Link className={button} to="/digifab">Exit to the fleet</Link></header>
    {credential && <StationInstall />}
    {(!reviewRefused && error || q.error) && <p role="alert" className="rounded border border-red-500 p-4 break-words">{error || String(q.error)}</p>}
    {!credential ? <section className="rounded border border-line p-4 space-y-3"><h2 className="text-xl font-semibold uppercase tracking-wide">Set up this screen at the printer</h2><p>An owner or admin must authorize this screen before it can review and start a print. Keep it beside the machine.</p><button className={button} disabled={busy} onClick={() => void run(async () => { const result = await api.registerDigifabStation(slug, connectionId, deviceId); const next = { id: result.id, token: result.token }; localStorage.setItem(storageKey, JSON.stringify(next)); setCredential(next); })}>Authorize this machine station</button></section> : <button className={button} disabled={busy} onClick={() => void run(async () => { await api.revokeDigifabStation(slug, credential.id); localStorage.removeItem(storageKey); setCredential(null); setReview(null); })}>Revoke this screen</button>}
    <ToolTemperatures tools={device?.temps?.tools} />
    {q.data?.attention ? <section className="rounded border border-line p-4 space-y-4"><h2 className="text-xl font-semibold uppercase tracking-wide">Remove the print. Came out good?</h2><p>Clear the bed before the next print.</p><div className="flex flex-wrap gap-3">{(["good", "scrapped"] as const).map(verdict => <button key={verdict} className={button} disabled={busy} onClick={() => void run(async () => { await api.markDigifabDeviceReady(slug, connectionId, deviceId, verdict); await q.refetch(); })}>{verdict === "good" ? "Yes, came out good" : "No, scrap this print"}</button>)}</div></section> : job ? <section className="rounded border border-line p-4 space-y-4"><h2 className="text-xl font-semibold uppercase tracking-wide break-words">{jobDisplayName(job)}</h2>
      {job.status === "queued" ? <><p>Check the loaded filament, clear the bed, and confirm the 3D printing head is installed. Laser and CNC jobs cannot start here.</p><button className={`${button} bg-ember-600 text-white`} disabled={!credential || busy} onClick={() => void run(async () => { const before = currentContext.current; setReview(null); try { const result = await api.prepareDigifabJob(slug, job.id, credential!.token); if (before !== currentContext.current) throw new Error("The job changed. Review the new job before starting."); if (!result.review) throw new Error("Authorize this screen for this printer first."); setReviewRefused(false); setReview({ value: result.review, context: before }); } catch (e) { if (before === currentContext.current) setReviewRefused(true); throw e; } })}>{reviewRefused ? "Check the head again" : "Review print"}</button>{reviewRefused && error && <p role="alert" className="rounded border border-red-500 p-4 break-words">{error}</p>}</> : <><p className="text-xl">{job.status === "sent" ? "Start sent, waiting for the printer" : job.status === "paused" ? "Paused" : "Printing"}{job.progress != null ? ` · ${Math.round(job.progress * 100)}%` : ""}</p><progress aria-label="Job progress" max={100} value={job.progress == null ? undefined : Math.min(100, Math.max(0, job.progress * 100))} className="block h-6 w-full accent-ember-600" /><div className="flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => void run(async () => { await (job.status === "paused" ? api.resumeDigifabJob : api.pauseDigifabJob)(slug, job.id); await q.refetch(); })}>{job.status === "paused" ? "Resume print" : "Pause print"}</button><button className={button} disabled={busy} onClick={() => void run(async () => { await api.cancelDigifabJob(slug, job.id); await q.refetch(); })}>Stop print</button></div><p>Stay near the machine while it runs. Use the machine's emergency stop if needed.</p></>}
    </section> : <p>{q.data ? "Ready for the next queued print." : "Loading the station…"}</p>}
    {currentReview && job && <Modal open title="Review print" onClose={() => { if (!busy) setReview(null); }}><div className="space-y-4"><p className="break-words">{jobDisplayName(job)}</p><p>Check the filament and bed at the printer. Start submits this reviewed file once.</p><ToolTemperatures tools={device?.temps?.tools} /><button className={`${button} bg-ember-600 text-white w-full`} disabled={busy || !credential} onClick={() => void run(async () => { if (!credential || review?.context !== currentContext.current || job.status !== "queued") throw new Error("The job changed. Review it again."); try { await api.sendDigifabJob(slug, job.id, { fileId: currentReview.fileId, projectHash: currentReview.projectHash, stationToken: credential.token }); } finally { setReview(null); await q.refetch(); } })}>Start print</button></div></Modal>}
  </main></>;
}
