// /configuration/backup — Blueprints + Backup & Restore.
//
//   • Blueprint = your workspace SETUP (modules, bundles, fields, wires,
//     views, surfaces), no data. Download it to share; install one onto this
//     workspace.
//   • Backup = Blueprint + every row + every file, as a .zip. Download a copy
//     (keep it in your Drive / NAS); restore one into a fresh workspace.
//
// See docs/architecture/blueprint-backup-export.md.

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Upload, FileArchive, Layers, Loader2, AlertTriangle, HardDrive, Play, Trash2, Plus, Clock } from "lucide-react";
import { getToken } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";

interface BlueprintPlan {
  enable_modules: string[];
  install_bundles: Array<{ id: string; version: string }>;
  create_instances: number;
  create_wires: number;
  create_field_defs: number;
  create_saved_views: number;
  create_public_surfaces: number;
}
interface RestorePlan {
  restore_rows: number;
  restore_files: number;
  restore_tables: number;
  install_bundles: number;
  target_not_empty: boolean;
}
interface Destination {
  id: string;
  driver: string;
  label: string;
  config: Record<string, unknown>;
  connected: boolean;
  schedule: "off" | "daily" | "weekly";
  retention: number;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
}
interface DriverInfo {
  id: string;
  label: string;
  available: boolean;
  configFields: Array<{ key: string; label: string; required: boolean; placeholder?: string; secret?: boolean }>;
}

/** Compact local timestamp for the "next: …" / "last: …" hints — a date, plus
 *  the time only when it's today (so a daily run reads "3:00 AM", a future run
 *  reads "Jul 14"). Bad/empty input renders nothing. */
function shortWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A backup's timestamp for the file list — full date + time (these span days,
 *  so "3:19 PM" alone isn't enough). */
function backupWhen(iso: string | null): string {
  if (!iso) return "unknown time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function BackupPage() {
  usePageTitle("Backup & Blueprints");
  const { activeSlug: slug } = useActiveOrg();
  const toast = useToast();
  const base = `/api/v1/orgs/${slug}`;
  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { authorization: `Bearer ${t}` } : {};
  };

  const [busy, setBusy] = useState<string | null>(null);
  const bpFile = useRef<HTMLInputElement>(null);
  const bkFile = useRef<HTMLInputElement>(null);
  const [bpPlan, setBpPlan] = useState<{ manifest: unknown; plan: BlueprintPlan } | null>(null);
  const [bkPlan, setBkPlan] = useState<{ file: File; plan: RestorePlan } | null>(null);

  // ── Blueprint ──────────────────────────────────────────────────────
  async function downloadBlueprint() {
    setBusy("bp-export");
    try {
      const res = await fetch(`${base}/blueprint/export`, { headers: auth() });
      if (!res.ok) throw new Error((await res.json())?.error?.message ?? `HTTP ${res.status}`);
      const { manifest } = await res.json();
      downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }), `blueprint-${slug}.json`);
      toast.success("Blueprint downloaded.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  async function pickBlueprint(file: File) {
    setBusy("bp-plan");
    try {
      const manifest = JSON.parse(await file.text());
      const res = await fetch(`${base}/blueprint/install`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ manifest, confirm: false }),
      });
      const body = await res.json();
      if (res.status === 409 && body?.error?.code === "needs_consent") {
        setBpPlan({ manifest, plan: body.error.details as BlueprintPlan });
      } else if (!res.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read blueprint");
    } finally {
      setBusy(null);
      if (bpFile.current) bpFile.current.value = "";
    }
  }

  async function confirmBlueprint() {
    if (!bpPlan) return;
    setBusy("bp-install");
    try {
      const res = await fetch(`${base}/blueprint/install`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ manifest: bpPlan.manifest, confirm: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      toast.success("Blueprint installed.");
      setBpPlan(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Install failed");
    } finally {
      setBusy(null);
    }
  }

  // ── Backup ─────────────────────────────────────────────────────────
  async function downloadBackup() {
    setBusy("bk-export");
    try {
      const res = await fetch(`${base}/backup/export`, { headers: auth() });
      if (!res.ok) throw new Error((await res.json())?.error?.message ?? `HTTP ${res.status}`);
      const cd = res.headers.get("content-disposition") ?? "";
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? `backup-${slug}.zip`;
      downloadBlob(await res.blob(), name);
      toast.success("Backup downloaded.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backup failed");
    } finally {
      setBusy(null);
    }
  }

  async function pickBackup(file: File) {
    setBusy("bk-plan");
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`${base}/backup/restore`, { method: "POST", headers: auth(), body: form });
      const body = await res.json();
      if (res.status === 409 && body?.error?.code === "needs_consent") {
        setBkPlan({ file, plan: body.error.details as RestorePlan });
      } else if (!res.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read backup");
    } finally {
      setBusy(null);
      if (bkFile.current) bkFile.current.value = "";
    }
  }

  async function confirmRestore() {
    if (!bkPlan) return;
    setBusy("bk-restore");
    try {
      const form = new FormData();
      form.set("file", bkPlan.file);
      form.set("confirm", bkPlan.plan.target_not_empty ? "replace" : "true");
      const res = await fetch(`${base}/backup/restore`, { method: "POST", headers: auth(), body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      const r = body.restored;
      toast.success(`Restored ${r?.rows ?? 0} rows, ${r?.files ?? 0} files.`);
      setBkPlan(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusy(null);
    }
  }

  const btn =
    "inline-flex items-center gap-2 rounded-lg bg-cobble-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-cobble-700 disabled:opacity-50";
  const ghost =
    "inline-flex items-center gap-2 rounded-lg border border-line dark:border-slate-600 px-3.5 py-2 text-sm font-semibold text-content dark:text-mortar-100 hover:bg-subtle disabled:opacity-50";

  return (
    <div className="space-y-6">
      {/* Blueprint */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-800/40 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-bold text-content dark:text-mortar-100">Blueprint</h2>
        </div>
        <p className="text-sm text-muted">
          Your workspace <strong>setup</strong>  - enabled modules, installed bundles, custom fields, wires, shared
          views and public surfaces. <strong>No data.</strong> Install one to reproduce the setup on a fresh workspace.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={downloadBlueprint} disabled={busy !== null}>
            {busy === "bp-export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download blueprint
          </button>
          <button className={ghost} onClick={() => bpFile.current?.click()} disabled={busy !== null}>
            <Upload className="h-4 w-4" /> Install from file
          </button>
          <input
            ref={bpFile}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && pickBlueprint(e.target.files[0])}
          />
        </div>

        {bpPlan && (
          <div className="rounded-lg border border-accent/40 bg-accent/5 p-4 space-y-2 text-sm">
            <div className="font-semibold text-content dark:text-mortar-100">This blueprint will:</div>
            <ul className="list-disc pl-5 text-muted space-y-0.5">
              {bpPlan.plan.enable_modules.length > 0 && <li>enable modules: {bpPlan.plan.enable_modules.join(", ")}</li>}
              {bpPlan.plan.install_bundles.length > 0 && <li>install {bpPlan.plan.install_bundles.length} bundle(s)</li>}
              {bpPlan.plan.create_instances > 0 && <li>create {bpPlan.plan.create_instances} instance(s)</li>}
              {bpPlan.plan.create_field_defs > 0 && <li>add {bpPlan.plan.create_field_defs} custom field(s)</li>}
              {bpPlan.plan.create_wires > 0 && <li>add {bpPlan.plan.create_wires} wire(s)</li>}
              {bpPlan.plan.create_saved_views > 0 && <li>add {bpPlan.plan.create_saved_views} saved view(s)</li>}
              {bpPlan.plan.create_public_surfaces > 0 && <li>add {bpPlan.plan.create_public_surfaces} public surface(s)</li>}
            </ul>
            <div className="flex gap-2 pt-1">
              <button className={btn} onClick={confirmBlueprint} disabled={busy !== null}>
                {busy === "bp-install" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirm &amp; install
              </button>
              <button className={ghost} onClick={() => setBpPlan(null)} disabled={busy !== null}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Backup */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-800/40 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <FileArchive className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-bold text-content dark:text-mortar-100">Backup &amp; restore</h2>
        </div>
        <p className="text-sm text-muted">
          A full copy of this workspace - the blueprint <strong>plus every row and every file</strong>, as a <code>.zip</code>.
          Download one and keep it in your Google Drive or NAS. Restore one into a <strong>fresh</strong> workspace to
          reproduce it exactly.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={downloadBackup} disabled={busy !== null}>
            {busy === "bk-export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download backup
          </button>
          <button className={ghost} onClick={() => bkFile.current?.click()} disabled={busy !== null}>
            <Upload className="h-4 w-4" /> Restore from file
          </button>
          <input
            ref={bkFile}
            type="file"
            accept="application/zip,.zip"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && pickBackup(e.target.files[0])}
          />
        </div>

        {bkPlan && (
          <div className="rounded-lg border border-amber-400/50 bg-amber-50/60 dark:bg-amber-900/15 p-4 space-y-2 text-sm">
            {bkPlan.plan.target_not_empty && (
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300 font-semibold">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                This workspace already has data - restoring REPLACES it.
              </div>
            )}
            <div className="text-muted">
              Will restore <strong>{bkPlan.plan.restore_rows}</strong> rows across {bkPlan.plan.restore_tables} tables,{" "}
              <strong>{bkPlan.plan.restore_files}</strong> files
              {bkPlan.plan.install_bundles > 0 ? `, ${bkPlan.plan.install_bundles} bundle(s)` : ""}.
            </div>
            <div className="flex gap-2 pt-1">
              <button className={btn} onClick={confirmRestore} disabled={busy !== null}>
                {busy === "bk-restore" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {bkPlan.plan.target_not_empty ? "Replace & restore" : "Confirm & restore"}
              </button>
              <button className={ghost} onClick={() => setBkPlan(null)} disabled={busy !== null}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <DestinationsSection base={base} auth={auth} />
    </div>
  );
}

// ── Destinations (Phase C) ───────────────────────────────────────────
function DestinationsSection({ base, auth }: { base: string; auth: () => Record<string, string> }) {
  const toast = useToast();
  const [dests, setDests] = useState<Destination[]>([]);
  const [drivers, setDrivers] = useState<DriverInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ driver: string; label: string; schedule: Destination["schedule"]; retention: number; config: Record<string, string> }>(
    { driver: "filesystem", label: "", schedule: "off", retention: 7, config: {} },
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/backup/destinations`, { headers: auth() });
      if (!res.ok) return;
      const j = await res.json();
      setDests(j.destinations ?? []);
      setDrivers(j.drivers ?? []);
    } catch {
      /* leave empty */
    }
  }, [base, auth]);
  useEffect(() => {
    void load();
  }, [load]);

  // Coming back from the Google OAuth round-trip the callback redirects to
  // `?google=connected`. Without this the user lands on the page with no sign
  // the connect worked (the screenshots showed exactly that confusion). Confirm
  // it, then strip the param so a refresh doesn't re-toast. The persistent
  // schedule nudge below is what actually gets them to turn on automation.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("google") === "connected") {
      toast.success("Google Drive connected - now pick how often it backs up below.");
      q.delete("google");
      const qs = q.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selDriver = drivers.find((d) => d.id === form.driver);
  // A destination is "actionable" once it can actually run — filesystem always,
  // Google only after the OAuth connect. We only nudge about scheduling once the
  // destination can run; before that the important ask is "connect it".
  const actionable = (d: Destination): boolean => d.driver !== "google_drive" || d.connected;

  // A live listing of the backups that actually exist in a destination — one
  // open at a time. Replaces the uninformative "last: ok" with the real files.
  type BackupFile = { name: string; size: number | null; created_at: string | null; ref: string };
  const [openBackupsId, setOpenBackupsId] = useState<string | null>(null);
  const [backupFiles, setBackupFiles] = useState<BackupFile[] | "loading" | "error">("loading");
  async function toggleBackups(d: Destination) {
    if (openBackupsId === d.id) {
      setOpenBackupsId(null);
      return;
    }
    setOpenBackupsId(d.id);
    setBackupFiles("loading");
    try {
      const res = await fetch(`${base}/backup/destinations/${d.id}/backups`, { headers: auth() });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      setBackupFiles(j.backups ?? []);
    } catch {
      setBackupFiles("error");
    }
  }

  async function create() {
    setBusy("create");
    try {
      const res = await fetch(`${base}/backup/destinations`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ driver: form.driver, label: form.label || selDriver?.label || form.driver, schedule: form.schedule, retention: form.retention, config: form.config }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      toast.success("Destination added.");
      setAdding(false);
      setForm({ driver: "filesystem", label: "", schedule: "off", retention: 7, config: {} });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add destination");
    } finally {
      setBusy(null);
    }
  }

  async function runNow(d: Destination) {
    setBusy(`run-${d.id}`);
    try {
      const res = await fetch(`${base}/backup/destinations/${d.id}/run`, { method: "POST", headers: auth() });
      const j = await res.json();
      if (j.ok) toast.success(`Backup pushed to ${d.label}.`);
      else toast.error(`Backup failed: ${j.error ?? "unknown"}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBusy(null);
    }
  }

  async function patch(d: Destination, body: Record<string, unknown>) {
    setBusy(`patch-${d.id}`);
    try {
      const res = await fetch(`${base}/backup/destinations/${d.id}`, { method: "PATCH", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json())?.error?.message ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove(d: Destination) {
    setBusy(`del-${d.id}`);
    try {
      await fetch(`${base}/backup/destinations/${d.id}`, { method: "DELETE", headers: auth() });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function connectGoogle() {
    setBusy("google");
    try {
      const res = await fetch(`${base}/backup/destinations/google/connect`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ label: "Google Drive" }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      window.location.href = j.url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't start Google connect");
    } finally {
      setBusy(null);
    }
  }

  const availableDrivers = drivers.filter((d) => d.available);
  const googleDriver = drivers.find((d) => d.id === "google_drive");
  const btn = "inline-flex items-center gap-2 rounded-lg bg-cobble-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-cobble-700 disabled:opacity-50";
  const ghost = "inline-flex items-center gap-2 rounded-lg border border-line dark:border-slate-600 px-3 py-1.5 text-sm font-semibold text-content dark:text-mortar-100 hover:bg-subtle disabled:opacity-50";
  const nudgeBtn =
    "inline-flex items-center gap-1 rounded-md border border-amber-400/70 px-2 py-0.5 font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-800/30 disabled:opacity-50";

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-800/40 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive className="h-5 w-5 text-accent" />
        <h2 className="font-display text-lg font-bold text-content dark:text-mortar-100">Automatic destinations</h2>
      </div>
      <p className="text-sm text-muted">
        Push a backup automatically on a schedule to a <strong>server path / NAS</strong> or <strong>Google Drive</strong>. Or hit
        <em> Back up now</em> to send one immediately.
      </p>

      {dests.length > 0 && (
        <ul className="space-y-2">
          {dests.map((d) => (
            <li key={d.id} className="rounded-lg border border-line dark:border-slate-700 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <div className="font-semibold text-content dark:text-mortar-100">{d.label}</div>
                <div className="text-faint">{drivers.find((x) => x.id === d.driver)?.label ?? d.driver}</div>
                {d.driver === "google_drive" && !d.connected && <span className="text-amber-600">not connected</span>}
                <label className="flex items-center gap-1 text-muted">
                  <Clock className="h-3.5 w-3.5" />
                  <select
                    className={`bg-transparent border rounded px-1 py-0.5 ${
                      d.schedule === "off" && actionable(d)
                        ? "border-amber-400 text-amber-700 dark:text-amber-300"
                        : "border-line dark:border-slate-600"
                    }`}
                    value={d.schedule}
                    onChange={(e) => patch(d, { schedule: e.target.value })}
                    disabled={busy !== null}
                  >
                    <option value="off">manual only</option>
                    <option value="daily">daily</option>
                    <option value="weekly">weekly</option>
                  </select>
                </label>
                {d.schedule !== "off" && d.next_run_at && (
                  <span className="text-faint">next: {shortWhen(d.next_run_at)}</span>
                )}
                {d.last_status && (
                  <span className={d.last_status === "ok" ? "text-emerald-600" : "text-red-600"}>
                    {d.last_status === "ok"
                      ? `last: ok${d.last_run_at ? ` (${shortWhen(d.last_run_at)})` : ""}`
                      : `last: ${d.last_status.slice(0, 40)}`}
                  </span>
                )}
                <div className="ml-auto flex gap-2">
                  <button
                    className={ghost}
                    onClick={() => toggleBackups(d)}
                    disabled={d.driver === "google_drive" && !d.connected}
                  >
                    <FileArchive className="h-3.5 w-3.5" /> {openBackupsId === d.id ? "Hide backups" : "View backups"}
                  </button>
                  <button className={ghost} onClick={() => runNow(d)} disabled={busy !== null || (d.driver === "google_drive" && !d.connected)}>
                    {busy === `run-${d.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Back up now
                  </button>
                  <button className={ghost} onClick={() => remove(d)} disabled={busy !== null} aria-label="Delete destination">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* The nag: a scheduled backup is the whole point, but new
                  destinations (incl. a freshly-connected Drive) default to
                  manual-only — and a manual-only backup that nobody remembers
                  to click never happens. Persistently offer one-tap scheduling
                  until they turn it on. */}
              {d.schedule === "off" && actionable(d) && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/60 dark:border-amber-700/40 bg-amber-50/70 dark:bg-amber-900/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Automatic backups are <strong>off</strong>  - this only runs when you press <em>Back up now</em>. Turn on a schedule so
                    it happens on its own:
                  </span>
                  <button className={nudgeBtn} onClick={() => patch(d, { schedule: "daily" })} disabled={busy !== null}>
                    {busy === `patch-${d.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Daily
                  </button>
                  <button className={nudgeBtn} onClick={() => patch(d, { schedule: "weekly" })} disabled={busy !== null}>
                    Weekly
                  </button>
                </div>
              )}

              {openBackupsId === d.id && (
                <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-800/30 p-2 text-xs">
                  {backupFiles === "loading" ? (
                    <div className="flex items-center gap-2 text-muted px-1 py-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Listing your backups in {d.label}…
                    </div>
                  ) : backupFiles === "error" ? (
                    <div className="text-red-600 px-1 py-2">Couldn't list backups here. The destination may be unreachable, or the connection may have expired.</div>
                  ) : backupFiles.length === 0 ? (
                    <div className="text-muted italic px-1 py-2">No backups here yet. Press <em>Back up now</em> to send one.</div>
                  ) : (
                    <>
                      <div className="text-[10px] font-mono uppercase tracking-widest text-faint px-1 pb-1">
                        {backupFiles.length} backup{backupFiles.length === 1 ? "" : "s"} in {d.label}
                      </div>
                      <ul className="divide-y divide-line/70 dark:divide-slate-700/70">
                        {backupFiles.map((f) => (
                          <li key={f.ref} className="flex items-center gap-3 px-1 py-1.5">
                            <FileArchive className="h-3.5 w-3.5 text-faint shrink-0" />
                            <span className="text-content dark:text-mortar-100">{backupWhen(f.created_at)}</span>
                            <span className="text-faint font-mono truncate">{f.name}</span>
                            {f.size != null && <span className="ml-auto text-faint font-mono shrink-0">{fmtBytes(f.size)}</span>}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!adding ? (
        <div className="flex flex-wrap gap-2">
          <button className={ghost} onClick={() => setAdding(true)} disabled={availableDrivers.length === 0}>
            <Plus className="h-4 w-4" /> Add a destination
          </button>
          {googleDriver?.available &&
            (() => {
              // Don't say "Connect Google Drive" when a Drive destination is
              // already connected — that's the confusing bit. Connected → a quiet
              // "Reconnect" link (only for re-auth); a destination that exists but
              // isn't connected → a clear "Reconnect" CTA; none → "Connect".
              const driveDest = dests.find((x) => x.driver === "google_drive");
              if (driveDest?.connected) {
                return (
                  <button
                    onClick={connectGoogle}
                    disabled={busy !== null}
                    title="Re-authorize Google Drive (only needed if the connection expires)"
                    className="self-center text-xs text-faint hover:text-accent underline underline-offset-2"
                  >
                    {busy === "google" ? "Reconnecting…" : "Reconnect Google Drive"}
                  </button>
                );
              }
              return (
                <button className={ghost} onClick={connectGoogle} disabled={busy !== null}>
                  {busy === "google" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{" "}
                  {driveDest ? "Reconnect Google Drive" : "Connect Google Drive"}
                </button>
              );
            })()}
          {googleDriver && !googleDriver.available && (
            <span className="text-xs text-faint self-center">Google Drive needs server setup (GOOGLE_OAUTH_*).</span>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-line dark:border-slate-700 p-4 space-y-3 text-sm">
          <div className="flex gap-3 flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-muted">Type</span>
              <select
                className="bg-transparent border border-line dark:border-slate-600 rounded px-2 py-1"
                value={form.driver}
                onChange={(e) => setForm((f) => ({ ...f, driver: e.target.value, config: {} }))}
              >
                {availableDrivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-[10rem]">
              <span className="text-muted">Name</span>
              <input
                className="bg-transparent border border-line dark:border-slate-600 rounded px-2 py-1"
                value={form.label}
                placeholder={selDriver?.label ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
            </label>
          </div>
          {(selDriver?.configFields ?? []).map((cf) => (
            <label key={cf.key} className="flex flex-col gap-1">
              <span className="text-muted">{cf.label}</span>
              <input
                type={cf.secret ? "password" : "text"}
                autoComplete={cf.secret ? "new-password" : "off"}
                className="bg-transparent border border-line dark:border-slate-600 rounded px-2 py-1"
                placeholder={cf.placeholder}
                value={form.config[cf.key] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, config: { ...f.config, [cf.key]: e.target.value } }))}
              />
            </label>
          ))}
          <div className="flex gap-3 flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-muted">Schedule</span>
              <select
                className="bg-transparent border border-line dark:border-slate-600 rounded px-2 py-1"
                value={form.schedule}
                onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value as Destination["schedule"] }))}
              >
                <option value="off">manual only</option>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted">Keep (retention)</span>
              <input
                type="number"
                min={1}
                max={365}
                className="w-24 bg-transparent border border-line dark:border-slate-600 rounded px-2 py-1"
                value={form.retention}
                onChange={(e) => setForm((f) => ({ ...f, retention: Number(e.target.value) || 7 }))}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button className={btn} onClick={create} disabled={busy !== null}>
              {busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Add destination
            </button>
            <button className={ghost} onClick={() => setAdding(false)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
