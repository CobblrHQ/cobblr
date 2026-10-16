import { productName } from "@cobblr/platform-web";
import { useEffect, useRef, useState } from "react";
import type { ProductionPlan, ProductionStepResult, ProductionTestResult } from "./production-test.js";
import { matchesProductionJig } from "./jig-scan.js";
import { judgeTargetRun, stepChangesHardware } from "./production-steps.js";
export interface StationAttempt {
 id: string; serial: string; unit?: { kind: string; id: string }; plan: ProductionPlan; jig_id: string | null; jig_name?: string; jig_cycle?: number | null; jig_labels?: string[]; unit_labels?: string[];
 status: "prepared" | "running" | "finished"; steps: ProductionStepResult[]; result?: ProductionTestResult;
 prompt?: { id: string; text: string; response: "pass-fail" | "number" | "text" | "scan"; image_url?: string; photo_required?: boolean };
 synced?: boolean;
}
export interface ProductionStationPort {
 read(): Promise<{ attempts: StationAttempt[] }>;
 act(operation: "start" | "abort" | "answer" | "sync", args: Record<string, unknown>): Promise<unknown>;
}
export function ProductionStation({ port, onResult }: { port: ProductionStationPort; onResult?: (attempt: StationAttempt) => void }) {
 const [attempts, setAttempts] = useState<StationAttempt[]>([]), [serial, setSerial] = useState(""), [jig, setJig] = useState(""), [selected, setSelected] = useState(""), [confirmed, setConfirmed] = useState(false), [answer, setAnswer] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [readError, setReadError] = useState(""), [photo, setPhoto] = useState<{ filename: string; mime_type: string; data_b64: string } | undefined>();
 const calls = useRef(0), issued = useRef(0), applied = useRef(0);
 const currentPort = useRef(port); currentPort.current = port;
 useEffect(() => {
  let alive = true;
  let pending = false;
  const refresh = async () => { if (pending) return; pending = true; const sequence = ++issued.current; try { const data = await currentPort.current.read(); if (alive && sequence >= applied.current) { applied.current = sequence; setAttempts(data.attempts); setReadError(""); } } catch (e) { if (alive) setReadError(e instanceof Error ? e.message : "The station could not be reached."); } finally { pending = false; } };
  void refresh(); const timer = setInterval(() => void refresh(), 1000);
  return () => { alive = false; clearInterval(timer); };
 }, []);
 const attempt = attempts.find(a => a.id === selected) ?? attempts.find(a => a.serial === serial.trim() || matchesProductionJig(serial, a.unit?.id ?? a.id, a.unit_labels ?? []));
 const running = attempts.find(a => a.status === "running");
 const needsConfirm = attempt?.plan.steps.some(stepChangesHardware) ?? false;
 async function act(operation: "start" | "abort" | "answer" | "sync", args: Record<string, unknown>) {
  calls.current++; setBusy(true); setError("");
  try { await currentPort.current.act(operation, args); const sequence = ++issued.current; const data = await currentPort.current.read(); if (sequence >= applied.current) { applied.current = sequence; setAttempts(data.attempts); } }
  catch (e) { setError(e instanceof Error ? e.message : "The station could not finish this action."); }
  finally { calls.current--; setBusy(calls.current > 0); }
 }
 const prompt = running?.prompt;
 useEffect(() => { setAnswer(""); setPhoto(undefined); }, [prompt?.id, running?.id]);
 async function takePhoto(file?: File) {
  if (!file) { setPhoto(undefined); return; }
  if (file.size > 2 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setError("Choose a PNG, JPEG or WebP photo below 2 MB."); return; }
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.onerror = () => reject(new Error("The photo could not be read.")); reader.readAsDataURL(file); });
  setPhoto({ filename: file.name, mime_type: file.type, data_b64: data });
 }
 const answerBlocked = busy || !!prompt?.photo_required && !photo;
 return <section className="production-station" aria-label="Production test station">
  <style>{`.production-station{--ps-bg:#fff;--ps-text:#17212c;--ps-line:#bac5cf;color:var(--ps-text);background:var(--ps-bg);padding:clamp(16px,3vw,36px);border-radius:12px;max-width:1100px;margin:auto;font:16px/1.5 system-ui}.dark .production-station{--ps-bg:#17212c;--ps-text:#f1f5f9;--ps-line:#637385}.production-station *{box-sizing:border-box}.production-station h2{font-size:clamp(24px,4vw,36px);margin:0 0 16px}.production-station label{display:block;margin:12px 0}.production-station input:not([type=checkbox]),.production-station select{display:block;width:100%;min-height:48px;border:1px solid var(--ps-line);border-radius:6px;padding:10px;color:inherit;background:inherit;font:inherit}.production-station button{min-height:48px;margin:6px 8px 6px 0;border:1px solid var(--ps-line);border-radius:6px;padding:10px 20px;font:inherit;color:inherit;background:inherit;cursor:pointer}.production-station button:disabled{opacity:.45;cursor:default}.production-station .ps-start{background:#25634c;color:white}.production-station .ps-stop{background:#a72c2c;color:white;font-weight:700;min-width:160px}.production-station .ps-result{padding:12px 0;border-bottom:1px solid var(--ps-line);overflow-wrap:anywhere}.production-station .ps-pass{color:#216644}.dark .production-station .ps-pass{color:#80ddb1}.production-station .ps-fail{color:#aa3030}.dark .production-station .ps-fail{color:#ffaaaa}.production-station .ps-prompt{position:fixed;inset:0;z-index:100;background:var(--ps-bg);padding:clamp(20px,6vw,80px);overflow:auto;display:flex;flex-direction:column;justify-content:center}.production-station .ps-prompt img{max-width:100%;max-height:40vh;object-fit:contain}.production-station small{display:block}.production-station .ps-summary{font-size:clamp(28px,5vw,48px);font-weight:700}`}</style>
  <h2>Production test</h2>
  <p>Scan a prepared unit and its jig, then start its saved plan.</p>
  <label>Unit serial<input value={serial} onChange={e => { setSerial(e.target.value); setSelected(""); setConfirmed(false); }} autoComplete="off" /></label>
  <label>Prepared attempt<select value={attempt?.id ?? ""} onChange={e => { setSelected(e.target.value); setConfirmed(false); }}><option value="">Choose a unit</option>{attempts.map(a => <option key={a.id} value={a.id}>{a.serial} · {a.plan.name} v{a.plan.version} · {a.status}</option>)}</select></label>
  {attempt && <><p>{attempt.plan.name} · Version {attempt.plan.version}</p>{attempt.jig_id && <label>Jig QR or asset id<input value={jig} onChange={e => setJig(e.target.value)} autoComplete="off" /><small>{attempt.jig_name ?? attempt.jig_id} · Cycle {attempt.jig_cycle ?? "pending"}</small></label>}
  {needsConfirm && <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I checked the fixture and output settings.</label>}
  <button className="ps-start" disabled={busy || !!running || attempt.status !== "prepared" || needsConfirm && !confirmed || !!attempt.jig_id && !matchesProductionJig(jig, attempt.jig_id, attempt.jig_labels ?? [])} onClick={() => void act("start", { id: attempt.id, jig_id: attempt.jig_id, confirmed })}>Start</button>
  <button className="ps-stop" disabled={!running} onClick={() => void act("abort", { id: running?.id })}>Abort test</button>
  <div aria-live="polite">{attempt.steps.map(step => { const planned = attempt.plan.steps.find(s => s.id === step.id), run = planned?.kind === "probe" && planned.action.op === "run" && typeof step.value === "string" ? judgeTargetRun(planned.action, step.value) : null; return <div className={`ps-result ps-${step.result}`} key={step.id}><strong>{step.name}: {step.result}</strong>{run ? <ul>{run.checks.map((c, n) => <li key={n} className={`ps-${c.result}`}>{c.name}: {c.result}{c.value === undefined ? "" : ` ${c.value} ${c.unit ?? ""}`}</li>)}</ul> : step.value !== undefined && <div>{String(step.value)} {step.unit ?? ""}</div>}{step.limits?.kind === "range" && <small>Limits: {step.limits.min ?? "no lower bound"} to {step.limits.max ?? "no upper bound"} {step.limits.unit}</small>}{step.reason && <p>{step.reason}</p>}</div>; })}</div>
  {attempt.result && <><p className={`ps-summary ${attempt.result.status === "passed" ? "ps-pass" : "ps-fail"}`}>{attempt.result.status}</p>{attempt.result.outputs_off.map(o => { const pins = !attempt.plan.controlled_instruments.includes(o.instrument); return <p key={o.instrument}>{pins ? `${o.instrument.slice(0, -5)} fixture` : o.instrument}: {o.confirmed ? pins ? "pins released" : "output off confirmed" : o.error || (pins ? "pins not confirmed released" : "output off not confirmed")}</p>; })}<p>{attempt.synced ? `Saved in ${productName()}` : "Saved on the bridge; ready to sync"}</p><button disabled={busy || attempt.synced} onClick={() => void act("sync", { id: attempt.id })}>Sync result</button>{onResult && <button onClick={() => onResult(attempt)}>History, rework or scrap</button>}</>}
  </>}
  {(error || readError) && <p role="alert">{error || readError}</p>}
  {prompt && <div className="ps-prompt" role="region" aria-label="Operator check"><h2>{prompt.text}</h2>{prompt.image_url && <img src={prompt.image_url} alt="Reference for this check" />}{<label>Photo{prompt.photo_required ? " (required)" : " (optional)"}{/* paste-ok: copied into the edge bridge's offline page without platform-web; the operator photo is taken at the bench */}<input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" onChange={e => void takePhoto(e.target.files?.[0]).catch(e => setError(e.message))} /></label>}{prompt.response === "pass-fail" ? <div><button disabled={answerBlocked} onClick={() => void act("answer", { id: running.id, step_id: prompt.id, photo, value: true })}>Pass</button><button disabled={answerBlocked} onClick={() => void act("answer", { id: running.id, step_id: prompt.id, photo, value: false })}>Fail</button></div> : <form onSubmit={e => { e.preventDefault(); void act("answer", { id: running.id, step_id: prompt.id, photo, value: prompt.response === "number" ? Number(answer) : answer }); setAnswer(""); }}><label>{prompt.response === "scan" ? "Scan value" : "Measured value"}<input value={answer} onChange={e => setAnswer(e.target.value)} type={prompt.response === "number" ? "number" : "text"} step="any" autoFocus required /></label><button disabled={answerBlocked}>Record value</button></form>}<button className="ps-stop" onClick={() => void act("abort", { id: running.id })}>Abort test</button></div>}
 </section>;
}
