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
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">backup &amp; blueprints</h1>
        <span className="page-subtitle">share a setup, or keep a full copy of your workspace</span>
      </div>

      {/* Blueprint */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-800/40 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-bold text-content dark:text-mortar-100">Blueprint</h2>
        </div>
        <p className="text-sm text-muted">
          Your workspace <strong>setup</strong> — enabled modules, installed bundles, custom fields, wires, shared
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
          A full copy of this workspace — the blueprint <strong>plus every row and every file</strong>, as a <code>.zip</code>.
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
                This workspace already has data — restoring REPLACES it.
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
      const res = await fetch(`${base}/destinations`, { headers: auth() });
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

  const selDriver = drivers.find((d) => d.id === form.driver);

  async function create() {
    setBusy("create");
    try {
      const res = await fetch(`${base}/destinations`, {
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
      const res = await fetch(`${base}/destinations/${d.id}/run`, { method: "POST", headers: auth() });
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
      const res = await fetch(`${base}/destinations/${d.id}`, { method: "PATCH", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body) });
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
      await fetch(`${base}/destinations/${d.id}`, { method: "DELETE", headers: auth() });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function connectGoogle() {
    setBusy("google");
    try {
      const res = await fetch(`${base}/destinations/google/connect`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ label: "Google Drive" }) });
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
            <li key={d.id} className="rounded-lg border border-line dark:border-slate-700 p-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <div className="font-semibold text-content dark:text-mortar-100">{d.label}</div>
              <div className="text-faint">{drivers.find((x) => x.id === d.driver)?.label ?? d.driver}</div>
              {d.driver === "google_drive" && !d.connected && <span className="text-amber-600">not connected</span>}
              <label className="flex items-center gap-1 text-muted">
                <Clock className="h-3.5 w-3.5" />
                <select
                  className="bg-transparent border border-line dark:border-slate-600 rounded px-1 py-0.5"
                  value={d.schedule}
                  onChange={(e) => patch(d, { schedule: e.target.value })}
                  disabled={busy !== null}
                >
                  <option value="off">manual</option>
                  <option value="daily">daily</option>
                  <option value="weekly">weekly</option>
                </select>
              </label>
              {d.last_status && (
                <span className={d.last_status === "ok" ? "text-emerald-600" : "text-red-600"}>
                  {d.last_status === "ok" ? "last: ok" : `last: ${d.last_status.slice(0, 40)}`}
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <button className={ghost} onClick={() => runNow(d)} disabled={busy !== null || (d.driver === "google_drive" && !d.connected)}>
                  {busy === `run-${d.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Back up now
                </button>
                <button className={ghost} onClick={() => remove(d)} disabled={busy !== null} aria-label="Delete destination">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!adding ? (
        <div className="flex flex-wrap gap-2">
          <button className={ghost} onClick={() => setAdding(true)} disabled={availableDrivers.length === 0}>
            <Plus className="h-4 w-4" /> Add a destination
          </button>
          {googleDriver?.available && (
            <button className={ghost} onClick={connectGoogle} disabled={busy !== null}>
              {busy === "google" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Connect Google Drive
            </button>
          )}
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
