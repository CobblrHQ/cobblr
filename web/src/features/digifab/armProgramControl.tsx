import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RelationSelect } from "@cobblr/platform-web";
import { countOf } from "@cobblr/platform-contract/plural";
import { cancelUpdate, checkUpdateStep, startUpdate, verifyUpdate } from "./robot-arm-api";
import { cancelCopy, checkCopy, copyProgram, programChanges, releaseProgram, restoreBackup, setBackupSchedule, takeBackup, testRestore, type ArmProgram, type ArmView, type ProgramChanges } from "./robot-arm-api";
const button = "min-h-11 rounded border border-line px-3 py-2 text-sm disabled:opacity-50";
const input = "input w-full min-h-11";
type Run = (w: () => Promise<unknown>, done?: string) => Promise<void>;

/** A revision's standing: released for production, or not yet, with what
 *  changed since the last released one and, for an admin, Release and Copy. */
export function ProgramControl({ slug, program, admin, busy, run }: { slug: string; program: ArmProgram; admin: boolean; busy: boolean; run: Run }) {
 const [open, setOpen] = useState(false), [copying, setCopying] = useState(false), [target, setTarget] = useState<string | null>(null);
 const released = !!program.released_at;
 return <div className="space-y-1">
  <p className="text-sm" role="status">{released ? `Released for production ${new Date(program.released_at!).toLocaleDateString()}` : "Not released for production: it cannot run until someone reviews it and releases it."}{program.text === "unread" && program.source === "controller" ? " Its text could not be read from the controller." : ""}</p>
  <div className="flex flex-wrap gap-2">
   <button className={button} onClick={() => setOpen(!open)}>{open ? "Hide changes" : "Review changes"}</button>
   {admin && !released && !program.missing_since && <button className={button} disabled={busy} onClick={() => void run(() => releaseProgram(slug, program.id), `Released ${program.name} for production.`)}>Release this revision</button>}
   {admin && !program.missing_since && <button className={button} onClick={() => setCopying(!copying)}>Copy to another arm</button>}
  </div>
  {open && <ProgramDiff slug={slug} program={program.id} />}
  {copying && <div className="flex flex-wrap gap-2 items-center"><RelationSelect label="Arm to copy to" refKind="machines:machine" className="flex-1 min-h-11" value={target} onChange={setTarget} /><button className={button} disabled={busy || !target} onClick={() => void run(async () => { const r = await copyProgram(slug, program.id, target!); setCopying(false); if (r.detail) throw new Error(`Opened its re-teach checklist. ${r.detail}`); }, "Copied onto the other arm. Its re-teach checklist releases it there.")}>Copy with a re-teach checklist</button></div>}
 </div>;
}

export function ProgramDiff({ slug, program }: { slug: string; program: string }) {
 const q = useQuery({ queryKey: ["arm-program-changes", slug, program], queryFn: () => programChanges(slug, program) });
 if (q.isError) return <p role="alert" className="text-sm">The changes could not be read.</p>;
 if (!q.data) return <p className="text-sm text-muted">Reading the changes…</p>;
 const d: ProgramChanges = q.data;
 if (d.text === "unread") return <p className="text-sm">The controller did not give its text, so nothing can be compared. Check it at the pendant before releasing it.</p>;
 return <div data-testid="arm-program-diff" className="space-y-2 text-sm">
  <p>{d.released_before ? `Compared with revision ${d.released_before.revision ?? "none"}, released ${new Date(d.released_before.released_at).toLocaleDateString()}.` : "No earlier revision of this program was released on this arm: all of it is new."}</p>
  {d.files.filter(f => f.status !== "same").length === 0 && <p>No file changed.</p>}
  {d.files.filter(f => f.status !== "same").map(f => <div key={f.path} className="rounded border border-line">
   <p className="px-2 py-1 font-semibold break-words">{f.path} · {f.status === "binary-changed" ? "changed (not text, so not shown line by line)" : f.status}{f.diff ? ` · ${f.diff.added} added, ${f.diff.removed} removed` : ""}</p>
   {f.diff?.tooLarge && <p className="px-2">Too large to compare line by line here.</p>}
   {f.diff?.hunks.map((h, i) => <pre key={i} className="overflow-x-auto text-xs border-t border-line p-2">{h.lines.map((l, j) => <div key={j} className={l.op === "add" ? "bg-green-100 dark:bg-green-900/40" : l.op === "del" ? "bg-red-100 dark:bg-red-900/40" : ""}>{l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}{l.text}</div>)}</pre>)}
  </div>)}
 </div>;
}

/** Copies onto this arm waiting for their re-teach checklist. */
export function Copies({ slug, data, admin, busy, run }: { slug: string; data: ArmView; admin: boolean; busy: boolean; run: Run }) {
 const copies = data.copies ?? [];
 if (!copies.length && !(data.outgoing ?? []).length) return null;
 return <section aria-label="Program copies" className="space-y-2"><h4 className="font-semibold">Copied programs to re-teach</h4>
  {copies.map(c => <div key={c.id} data-testid="arm-copy" className="rounded border border-line p-2 space-y-1">
   <p className="font-semibold break-words">{c.name}{c.target_revision ? ` (revision ${c.target_revision} here)` : ""} · {c.uploaded ? "put on this controller by the bridge" : "copy it at the pendant"}</p>
   <p className="text-sm text-muted">A copied program runs only once every check is ticked. Ticking the last releases it on this arm.</p>
   {c.checklist.map((item, i) => <label key={i} className="flex items-center gap-2 min-h-11"><input type="checkbox" disabled={!admin || busy} checked={!!item.done_by} onChange={e => void run(() => checkCopy(slug, c.id, i, e.target.checked))} />{item.item}</label>)}
   {admin && <button className={button} disabled={busy} onClick={() => void run(() => cancelCopy(slug, c.id), "Cancelled the copy.")}>Cancel this copy</button>}
  </div>)}
  {(data.outgoing ?? []).map(c => <p key={c.id} className="text-sm break-words">{c.name} is being re-taught on another arm: {c.checklist.filter(i => i.done_by).length} of {countOf(c.checklist.length, "check")} done.</p>)}
 </section>;
}

/** Backups: take one, keep a number of them, and prove each by restoring it
 *  onto a spare arm. At the station, restore the arm's own programs. */
export function Backups({ slug, machine, data, admin, busy, run, screen }: { slug: string; machine: string; data: ArmView; admin: boolean; busy: boolean; run: Run; screen: { token: string } | null }) {
 const unit = data.unit!, backups = data.backups ?? [];
 const [every, setEvery] = useState(unit.backup_every_hours ? String(unit.backup_every_hours) : ""), [keep, setKeep] = useState(String(unit.backup_keep ?? 10));
 const [spare, setSpare] = useState<string | null>(null), [stopped, setStopped] = useState(false);
 return <section aria-label="Backups" className="space-y-2"><h4 className="font-semibold">Backups</h4>
  <p className="text-sm text-muted">A backup keeps every program and the installation they depend on. It is proven only once it has been restored onto a spare arm or a simulator and read back. Restoring writes programs only: the installation and its safety settings are restored at the pendant.</p>
  {admin && <div className="flex flex-wrap gap-2 items-end">
   <button className={button} disabled={busy || !unit.connection_id} onClick={() => void run(() => takeBackup(slug, machine), "Backed up the arm.")}>Back up now</button>
   <label>Every (hours, blank for never)<input className={input} inputMode="numeric" value={every} onChange={e => setEvery(e.target.value.replace(/\D/g, ""))} /></label>
   <label>Keep<input className={input} inputMode="numeric" value={keep} onChange={e => setKeep(e.target.value.replace(/\D/g, ""))} /></label>
   <button className={button} disabled={busy} onClick={() => void run(() => setBackupSchedule(slug, machine, { every_hours: every ? Number(every) : null, keep: Number(keep) || 10 }), "Saved the backup schedule.")}>Save schedule</button>
  </div>}
  {backups.length === 0 ? <p className="text-sm text-muted">No backups yet.</p> : <ol className="space-y-2">{backups.map(b => <li key={b.id} data-testid="arm-backup" className="rounded border border-line p-2 text-sm space-y-1">
   <p className="break-words">{new Date(b.taken_at).toLocaleString()} · {countOf(b.programs.length, "program")} · {countOf(b.installation_files, "installation file")} · {Math.round(b.size_bytes / 1024)} KB</p>
   {b.missing.length > 0 && <p className="break-words">Not in it: {b.missing.join(" ")}</p>}
   <p role="status" className="break-words">{b.restore_tested_at ? `${b.restore_ok ? "Restore tested" : "Restore test failed"} ${new Date(b.restore_tested_at).toLocaleString()}: ${b.restore_detail}` : "Not restore tested yet: not proven."}</p>
   {admin && <div className="flex flex-wrap gap-2 items-center"><RelationSelect label="Spare arm or simulator" refKind="machines:machine" className="flex-1 min-h-11" value={spare} onChange={setSpare} /><button className={button} disabled={busy || !spare || spare === machine} onClick={() => void run(() => testRestore(slug, b.id, spare!), "Ran the restore test.")}>Test restore there</button></div>}
   {screen && <div className="flex flex-wrap gap-2 items-center"><label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={stopped} onChange={e => setStopped(e.target.checked)} />The arm is stopped and nobody is in the cell</label><button className={button} disabled={busy || !stopped} onClick={() => void run(async () => { await restoreBackup(slug, machine, { station_token: screen.token, backup_id: b.id, arm_stopped: true }); setStopped(false); }, "Restored the arm's programs from this backup.")}>Restore these programs onto this arm</button></div>}
  </li>)}</ol>}
 </section>;
}

/** A guided update: the file in Files with its checksum, the vendor's steps
 *  ticked at the arm, and the version the controller reports afterwards.
 *  Cobblr never installs software on the controller. */
export function Updates({ slug, machine, data, admin, busy, run }: { slug: string; machine: string; data: ArmView; admin: boolean; busy: boolean; run: Run }) {
 const guide = data.guide, updates = data.updates ?? [], open = updates.find(u => u.status === "open");
 const [file, setFile] = useState<string | null>(null), [target, setTarget] = useState("");
 if (!guide) return null;
 const now = (data.unit?.last_info?.software_versions ?? []).map(v => `${v.name} ${v.version}`).join(", ") || "not read yet";
 return <section aria-label="Software updates" className="space-y-2"><h4 className="font-semibold">Software updates</h4>
  <p className="text-sm">The controller reports {now}. {guide.label}: {guide.remote}</p>
  <p className="text-sm text-muted">Going back: {guide.rollback}</p>
  {open ? <div data-testid="arm-update" className="rounded border border-line p-2 space-y-1 text-sm">
   <p className="font-semibold">Updating to {open.target_version}{open.file_sha256 ? ` · file checksum ${open.file_sha256.slice(0, 12)}` : ""}</p>
   {open.steps.map((s, i) => <label key={i} className="flex items-center gap-2 min-h-11"><input type="checkbox" disabled={!admin || busy} checked={!!s.done_by} onChange={e => void run(() => checkUpdateStep(slug, open.id, i, e.target.checked))} />{s.step}</label>)}
   {admin && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || open.steps.some(s => !s.done_by)} onClick={() => void run(() => verifyUpdate(slug, open.id), "Read the controller's version back.")}>Read the version back</button><button className={button} disabled={busy} onClick={() => void run(() => cancelUpdate(slug, open.id), "Cancelled the update.")}>Cancel this update</button></div>}
  </div> : admin && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
   <label>Version to update to<input className={input} maxLength={100} placeholder="5.15.2" value={target} onChange={e => setTarget(e.target.value)} /></label>
   <div className="flex gap-2 items-center"><RelationSelect label="Update file in Files" refKind="core-files:file" className="flex-1 min-h-11" value={file} onChange={setFile} /></div>
   <button className={button} disabled={busy || !target.trim()} onClick={() => void run(async () => { await startUpdate(slug, machine, { file_id: file, target_version: target.trim() }); setTarget(""); setFile(null); }, "Started a guided update. Follow its steps at the arm.")}>Start a guided update</button>
  </div>}
  {updates.filter(u => u.status !== "open").map(u => <p key={u.id} role="status" className="text-sm break-words">{new Date(u.created_at).toLocaleDateString()} · to {u.target_version} · {u.status === "verified" ? "verified" : u.status === "failed" ? "did not take" : "cancelled"}{u.detail ? `: ${u.detail}` : ""}</p>)}
 </section>;
}
