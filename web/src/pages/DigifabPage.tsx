// /configuration/digifab — Digital Fabrication. Manage connections to the
// software that runs your machines (FDM Monster, OctoPrint, …): add one,
// test it, list its printers, link printers to machines, and run the job
// queue. Sending a file to be made is a deliberate action — the Send
// button is behind an explicit confirm. We send files, never drive hardware.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wifi, Printer, RefreshCw, Send, ListChecks, Boxes } from "lucide-react";
import { ApiError, api, type DigifabConnection, type DigifabJob } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, usePageTitle } from "@cobblr/platform-web";

export function DigifabPage() {
  usePageTitle("Digital Fabrication");
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [driversOpen, setDriversOpen] = useState(false);
  const [printersFor, setPrintersFor] = useState<DigifabConnection | null>(null);

  const list = useQuery({
    queryKey: ["digifab-connections", activeSlug],
    queryFn: () => api.listDigifabConnections(activeSlug),
    enabled: !!activeSlug,
  });

  const test = useMutation({
    mutationFn: (id: string) => api.testDigifabConnection(activeSlug, id),
    onSuccess: (r) => {
      toast[r.ok ? "success" : "error"](
        r.ok ? `Connected${r.capabilities?.routing ? " · routing supported" : ""}` : `Failed: ${r.detail ?? "unknown"}`,
      );
      void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteDigifabConnection(activeSlug, id),
    onSuccess: () => {
      toast.success("Connection removed");
      void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const items = list.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">Digital Fabrication</h1>
        <span className="text-sm text-muted dark:text-slate-400">{items.length} connection{items.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
        <button
          onClick={() => setDriversOpen(true)}
          className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-3 py-1.5 text-sm transition"
        >
          <Boxes size={14} /> Drivers
        </button>
        <button
          onClick={() => setCreateOpen(true)}
          className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
        >
          <Plus size={14} /> Add connection
        </button>
      </div>

      <p className="text-sm text-muted dark:text-slate-400">
        Connect to the software that runs your machines — FDM Monster, OctoPrint, and friends. Send a file to be made, map its
        printers to your machines, then queue and send print jobs that track to completion.
      </p>

      {list.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-sm text-muted dark:text-slate-400 italic">
          No connections yet. Add one to point Cobblr at your machine manager.
        </div>
      )}

      <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800">
        {items.map((c) => (
          <li key={c.id} className="px-3 py-2.5 flex items-center gap-3">
            <Printer size={16} className="text-faint shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-content dark:text-mortar-100 truncate flex items-center gap-2">
                {c.label}
                <span className="text-[10px] font-mono uppercase tracking-wider text-faint">{c.type}</span>
                {c.capabilities?.routing && (
                  <span className="text-[10px] font-mono text-moss-600 dark:text-moss-400">routing</span>
                )}
              </div>
              <div className="text-[11px] font-mono text-faint truncate">{c.base_url}</div>
              {c.last_sync_status && (
                <div className={"text-[11px] " + (c.last_sync_status === "ok" ? "text-moss-600 dark:text-moss-400" : "text-ember-500")}>
                  {c.last_sync_status === "ok" ? "✓ reachable" : c.last_sync_status}
                </div>
              )}
            </div>
            <button
              onClick={() => test.mutate(c.id)}
              disabled={test.isPending}
              title="Test connection"
              className="text-faint hover:text-accent transition p-1.5 disabled:opacity-50"
            >
              {test.isPending && test.variables === c.id ? <RefreshCw size={15} className="animate-spin" /> : <Wifi size={15} />}
            </button>
            <button
              onClick={() => setPrintersFor(c)}
              title="List printers"
              className="text-faint hover:text-accent transition p-1.5"
            >
              <Printer size={15} />
            </button>
            <button
              onClick={async () => {
                const ok = await confirm({
                  title: `Remove "${c.label}"?`,
                  message: "Deletes the connection + its stored credentials. Print history isn't sent anywhere.",
                  confirmLabel: "Remove",
                  destructive: true,
                });
                if (ok) del.mutate(c.id);
              }}
              title="Remove"
              className="text-faint hover:text-ember-500 transition p-1.5"
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>

      {items.length > 0 && <PrintQueueSection connections={items} />}

      {createOpen && (
        <CreateConnectionModal
          types={list.data?.types ?? ["fdm_monster", "mock"]}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
            setCreateOpen(false);
          }}
        />
      )}
      {printersFor && <PrintersModal connection={printersFor} onClose={() => setPrintersFor(null)} />}
      {driversOpen && <DriversModal onClose={() => setDriversOpen(false)} />}
    </div>
  );
}

// Install / list / remove machine-manager drivers. Built-ins ship in code;
// a user installs a declarative-HTTP driver by pasting a manifest — no
// deploy. Installed drivers then appear in the Add-connection dropdown.
function DriversModal({ onClose }: { onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [manifest, setManifest] = useState("");

  const list = useQuery({
    queryKey: ["digifab-drivers", activeSlug],
    queryFn: () => api.listDigifabDrivers(activeSlug),
    enabled: !!activeSlug,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["digifab-drivers", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["digifab-connections", activeSlug] });
  };
  const install = useMutation({
    mutationFn: () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifest);
      } catch {
        throw new ApiError(400, "bad_json", "Manifest isn't valid JSON");
      }
      return api.installDigifabDriver(activeSlug, parsed);
    },
    onSuccess: (d) => {
      toast.success(`Installed "${d.name}"`);
      setManifest("");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const remove = useMutation({
    mutationFn: (key: string) => api.deleteDigifabDriver(activeSlug, key),
    onSuccess: () => { toast.success("Driver removed"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const builtins = list.data?.builtins ?? [];
  const installed = list.data?.installed ?? [];
  const field = "w-full px-2 py-1.5 text-xs font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";

  return (
    <Modal open onClose={onClose} title="Drivers" size="lg">
      <p className="text-sm text-muted dark:text-slate-400 mb-3">
        A driver connects digifab to the software that runs a machine. Built-ins ship with Cobblr;
        install your own by pasting a declarative manifest — no deploy. Installed drivers appear in
        the <span className="font-medium">Add connection</span> dropdown.
      </p>

      <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Built-in</div>
      <ul className="flex flex-wrap gap-2 mb-4">
        {builtins.map((b) => (
          <li key={b.key} className="text-xs px-2 py-1 rounded border border-line dark:border-slate-700 text-content dark:text-mortar-200">
            {b.name} <span className="text-faint font-mono">{b.key}</span>
          </li>
        ))}
      </ul>

      <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Installed</div>
      {installed.length === 0 ? (
        <div className="text-[13px] text-muted italic mb-4">None yet — paste a manifest below.</div>
      ) : (
        <ul className="divide-y divide-line dark:divide-slate-800 mb-4">
          {installed.map((d) => (
            <li key={d.id} className="py-2 flex items-center gap-2 text-sm">
              <Boxes size={14} className="text-faint" />
              <span className="flex-1 text-content dark:text-mortar-100">{d.name} <span className="text-[11px] font-mono text-faint">{d.key}</span></span>
              <span className="text-[10px] font-mono text-faint">{d.kind}</span>
              <button
                onClick={async () => {
                  if (await confirm({ title: `Remove "${d.name}"?`, message: "Connections using it will stop resolving.", confirmLabel: "Remove", destructive: true })) remove.mutate(d.key);
                }}
                className="text-faint hover:text-ember-500 transition p-1"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Install a declarative driver</div>
      <textarea
        value={manifest}
        onChange={(e) => setManifest(e.target.value)}
        rows={8}
        placeholder={'{\n  "id": "octoprint",\n  "name": "OctoPrint",\n  "auth": { "kind": "header", "header": "X-Api-Key", "from": "apiKey" },\n  "test": { "method": "GET", "path": "/api/version" },\n  ...\n}'}
        className={field}
      />
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Close</button>
        <button
          onClick={() => install.mutate()}
          disabled={install.isPending || !manifest.trim()}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
        >
          {install.isPending ? "Installing…" : "Install driver"}
        </button>
      </div>
    </Modal>
  );
}

// ── status pill + which jobs can be sent / polled ──────────────────────
const JOB_STATUS_STYLE: Record<string, string> = {
  queued: "text-muted bg-subtle dark:bg-slate-800",
  "awaiting-assignment": "text-amber-600 bg-amber-50 dark:bg-amber-950/40",
  sent: "text-accent bg-cobble-50 dark:bg-cobble-950/40",
  printing: "text-accent bg-cobble-50 dark:bg-cobble-950/40",
  completed: "text-moss-600 bg-moss-50 dark:bg-moss-950/40",
  failed: "text-ember-600 bg-ember-50 dark:bg-ember-950/40",
  cancelled: "text-faint bg-subtle dark:bg-slate-800",
};
const canSend = (j: DigifabJob) => j.status === "queued" && !j.remote_job_id;
const canPoll = (j: DigifabJob) => !!j.remote_job_id && j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled";

function PrintQueueSection({ connections }: { connections: DigifabConnection[] }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [newOpen, setNewOpen] = useState(false);

  const jobs = useQuery({
    queryKey: ["digifab-jobs", activeSlug],
    queryFn: () => api.listDigifabJobs(activeSlug),
    enabled: !!activeSlug,
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["digifab-jobs", activeSlug] });
  const connById = new Map(connections.map((c) => [c.id, c]));

  const send = useMutation({
    mutationFn: (id: string) => api.sendDigifabJob(activeSlug, id),
    onSuccess: (r) => {
      const kb = r.uploaded_bytes ? ` (${(r.uploaded_bytes / 1024).toFixed(1)} KB uploaded)` : "";
      toast[r.status === "awaiting-assignment" ? "info" : "success"](
        r.status === "awaiting-assignment"
          ? "Uploaded — needs a printer assignment (target matched 0 or many)"
          : `Sent to the farm — tracking to completion${kb}`,
      );
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const poll = useMutation({
    mutationFn: (id: string) => api.pollDigifabJob(activeSlug, id),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const askSend = async (j: DigifabJob) => {
    const conn = connById.get(j.connection_id);
    const isMock = conn?.type === "mock";
    const ok = await confirm({
      title: "Start this print?",
      message: isMock
        ? `Mock connection "${conn?.label}" — no hardware is touched. Uploads + places the job through the mock driver.`
        : `This uploads the file and queues it on "${conn?.label ?? "the farm"}" — on a live farm it physically starts the print. It can't be stopped from here.`,
      confirmLabel: isMock ? "Send (mock)" : "Start print",
      destructive: !isMock,
    });
    if (ok) send.mutate(j.id);
  };

  const items = jobs.data?.items ?? [];

  return (
    <section className="space-y-2 pt-2">
      <div className="flex items-center gap-3 border-b border-line dark:border-slate-700 pb-2">
        <ListChecks size={16} className="text-accent" />
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Print queue</h2>
        <span className="text-[11px] text-faint">{items.length} job{items.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
        <button
          onClick={() => setNewOpen(true)}
          className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-2.5 py-1 text-xs transition"
        >
          <Plus size={13} /> New job
        </button>
      </div>

      {jobs.isLoading && <div className="text-sm text-muted">Loading queue…</div>}
      {items.length === 0 && !jobs.isLoading && (
        <div className="text-[13px] text-muted dark:text-slate-400 italic">
          No jobs queued. Create one — then <span className="font-medium">Send</span> it to the farm when you're ready.
        </div>
      )}

      <ul className="divide-y divide-line dark:divide-slate-800">
        {items.map((jb) => {
          const conn = connById.get(jb.connection_id);
          const target = jb.target_device
            ? `printer ${jb.target_device}`
            : jb.target_tag
              ? `#${jb.target_tag}`
              : jb.linked_machine_id
                ? "→ linked machine"
                : "file routing";
          return (
            <li key={jb.id} className="py-2.5 flex items-center gap-3 text-sm">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] text-content dark:text-mortar-100 truncate">{jb.file_ref}</span>
                  <span className={"text-[10px] px-1.5 py-0.5 rounded font-medium " + (JOB_STATUS_STYLE[jb.status] ?? "text-muted bg-subtle")}>
                    {jb.status}
                  </span>
                  {jb.status === "printing" && jb.progress != null && (
                    <span className="text-[11px] text-accent">{Math.round(jb.progress * 100)}%</span>
                  )}
                </div>
                <div className="text-[11px] text-faint truncate">
                  {conn?.label ?? "—"} · {target}
                  {jb.error && <span className="text-ember-500"> · {jb.error}</span>}
                </div>
              </div>
              {canPoll(jb) && (
                <button
                  onClick={() => poll.mutate(jb.id)}
                  disabled={poll.isPending}
                  title="Refresh status"
                  className="text-faint hover:text-accent transition p-1.5 disabled:opacity-50"
                >
                  <RefreshCw size={14} className={poll.isPending && poll.variables === jb.id ? "animate-spin" : ""} />
                </button>
              )}
              {canSend(jb) && (
                <button
                  onClick={() => askSend(jb)}
                  disabled={send.isPending}
                  className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-xs transition disabled:opacity-50"
                >
                  <Send size={12} /> Send
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {newOpen && (
        <NewJobModal
          connections={connections}
          onClose={() => setNewOpen(false)}
          onCreated={() => {
            invalidate();
            setNewOpen(false);
          }}
        />
      )}
    </section>
  );
}

function NewJobModal({
  connections,
  onClose,
  onCreated,
}: {
  connections: DigifabConnection[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [fileRef, setFileRef] = useState("");
  const [routeBy, setRouteBy] = useState<"file" | "machine" | "printer" | "tag">("file");
  const [machineId, setMachineId] = useState("");
  const [printerId, setPrinterId] = useState("");
  const [tag, setTag] = useState("");
  const [fileId, setFileId] = useState("");

  const machines = useQuery({
    queryKey: ["machines", activeSlug],
    queryFn: () => api.listMachines(activeSlug),
    enabled: !!activeSlug && routeBy === "machine",
  });
  const printers = useQuery({
    queryKey: ["digifab-printers", activeSlug, connectionId],
    queryFn: () => api.listDigifabDevices(activeSlug, connectionId),
    enabled: !!connectionId && routeBy === "printer",
  });
  // Stored files to optionally upload as the real print bytes.
  const files = useQuery({
    queryKey: ["files", activeSlug],
    queryFn: () => api.listFiles(activeSlug),
    enabled: !!activeSlug,
  });

  const save = useMutation({
    mutationFn: () =>
      api.createDigifabJob(activeSlug, {
        connection_id: connectionId,
        file_ref: fileRef.trim(),
        target_device: routeBy === "printer" ? printerId || null : null,
        target_tag: routeBy === "tag" ? tag.trim() || null : null,
        file_id: fileId || null,
        linked_machine_id: routeBy === "machine" ? machineId || null : null,
      }),
    onSuccess: () => {
      toast.success("Job queued");
      onCreated();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  const machineList = machines.data?.items ?? [];
  const printerList = printers.data?.items ?? [];
  const fileList = files.data?.items ?? [];
  const routeValid =
    routeBy === "file" ||
    (routeBy === "machine" && !!machineId) ||
    (routeBy === "printer" && !!printerId) ||
    (routeBy === "tag" && !!tag.trim());

  return (
    <Modal open onClose={onClose} title="New print job" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className={lbl}>Connection</span>
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={field}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={lbl}>File / routing ref</span>
          <input value={fileRef} onChange={(e) => setFileRef(e.target.value)} placeholder="bracket.gcode" className={field} autoFocus />
        </label>
        <label className="block">
          <span className={lbl}>Printable file (optional)</span>
          <select
            value={fileId}
            onChange={(e) => {
              const id = e.target.value;
              setFileId(id);
              // Convenience: name the routing ref after the file if blank.
              const f = fileList.find((x) => x.id === id);
              if (f && !fileRef.trim()) setFileRef(f.filename);
            }}
            className={field}
          >
            <option value="">— routing-only (no upload) —</option>
            {fileList.map((f) => (
              <option key={f.id} value={f.id}>{f.filename}</option>
            ))}
          </select>
          <span className="text-[11px] text-faint">
            Pick a stored file to upload its real bytes on send. Leave blank to send routing only.
          </span>
        </label>
        <label className="block">
          <span className={lbl}>Route by</span>
          <select value={routeBy} onChange={(e) => setRouteBy(e.target.value as typeof routeBy)} className={field}>
            <option value="file">File routing (from the filename)</option>
            <option value="machine">A linked machine</option>
            <option value="printer">A specific printer</option>
            <option value="tag">A tag (printer group)</option>
          </select>
        </label>
        {routeBy === "machine" && (
          <label className="block">
            <span className={lbl}>Machine</span>
            <select value={machineId} onChange={(e) => setMachineId(e.target.value)} className={field}>
              <option value="">— pick a machine —</option>
              {machineList.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <span className="text-[11px] text-faint">Routes to the farm printer that machine is linked to.</span>
          </label>
        )}
        {routeBy === "printer" && (
          <label className="block">
            <span className={lbl}>Printer</span>
            <select value={printerId} onChange={(e) => setPrinterId(e.target.value)} className={field}>
              <option value="">— pick a printer —</option>
              {printerList.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
        {routeBy === "tag" && (
          <label className="block">
            <span className={lbl}>Tag</span>
            <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="pla" className={field} />
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={save.isPending || !connectionId || !fileRef.trim() || !routeValid} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {save.isPending ? "Queuing…" : "Queue job"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateConnectionModal({
  types,
  onClose,
  onCreated,
}: {
  types: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [type, setType] = useState(types[0] ?? "fdm_monster");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authMode, setAuthMode] = useState<"api_key" | "login">("api_key");
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.createDigifabConnection(activeSlug, {
        type,
        label: label.trim(),
        base_url: baseUrl.trim(),
        ...(type === "mock"
          ? {}
          : authMode === "api_key"
            ? { api_key: apiKey.trim() || undefined }
            : { username: username.trim() || undefined, password: password || undefined }),
      }),
    onSuccess: () => {
      toast.success("Connection added");
      onCreated();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

  return (
    <Modal open onClose={onClose} title="Add a connection" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className={lbl}>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {types.map((t) => (
              <option key={t} value={t}>{t === "fdm_monster" ? "FDM Monster" : t === "mock" ? "Mock (test)" : t}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={lbl}>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main FDM farm" className={field} autoFocus />
        </label>
        <label className="block">
          <span className={lbl}>Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://farm.local:4000" className={field} />
        </label>
        {type !== "mock" && (
          <>
            <div className="flex gap-2 text-xs">
              {(["api_key", "login"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAuthMode(m)}
                  className={"px-2 py-1 rounded border transition " + (authMode === m ? "border-cobble-500 text-accent" : "border-line dark:border-slate-600 text-muted")}
                >
                  {m === "api_key" ? "API key" : "Username + password"}
                </button>
              ))}
            </div>
            {authMode === "api_key" ? (
              <label className="block">
                <span className={lbl}>API key</span>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="fdmm_api_…" className={field} />
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={lbl}>Username</span>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
                </label>
                <label className="block">
                  <span className={lbl}>Password</span>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
                </label>
              </div>
            )}
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={save.isPending || !label.trim() || !baseUrl.trim()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {save.isPending ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PrintersModal({ connection, onClose }: { connection: DigifabConnection; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const printers = useQuery({
    queryKey: ["digifab-printers", activeSlug, connection.id],
    queryFn: () => api.listDigifabDevices(activeSlug, connection.id),
  });
  const machines = useQuery({
    queryKey: ["machines", activeSlug],
    queryFn: () => api.listMachines(activeSlug),
    enabled: !!activeSlug,
  });
  const links = useQuery({
    queryKey: ["digifab-links", activeSlug],
    queryFn: () => api.listDigifabLinks(activeSlug),
    enabled: !!activeSlug,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["digifab-links", activeSlug] });
  const link = useMutation({
    mutationFn: (v: { remote_device_id: string; remote_device_name: string | null; machine_id: string; machine_label: string | null }) =>
      api.createDigifabLink(activeSlug, { connection_id: connection.id, ...v }),
    onSuccess: () => { toast.success("Linked to machine"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => api.deleteDigifabLink(activeSlug, id),
    onSuccess: () => { toast.success("Unlinked"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const items = printers.data?.items ?? [];
  const machineList = machines.data?.items ?? [];
  // Links for THIS connection, indexed by farm printer id.
  const linkByPrinter = new Map(
    (links.data?.items ?? []).filter((l) => l.connection_id === connection.id).map((l) => [l.remote_device_id, l]),
  );
  const field = "px-2 py-1 text-xs border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 max-w-[14rem]";

  return (
    <Modal open onClose={onClose} title={`${connection.label} — printers`} size="md">
      {printers.isLoading && <div className="text-sm text-muted">Loading printers…</div>}
      {printers.isError && <div className="text-sm text-ember-500">Couldn't reach the farm — test the connection.</div>}
      {!printers.isLoading && !printers.isError && items.length === 0 && (
        <div className="text-sm text-muted italic">No printers reported.</div>
      )}
      <ul className="divide-y divide-line dark:divide-slate-800">
        {items.map((p) => {
          const linked = linkByPrinter.get(p.id);
          return (
            <li key={p.id} className="py-2.5 flex items-center gap-2 text-sm">
              <Printer size={14} className="text-faint shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-content dark:text-mortar-100 truncate">{p.name}</span>
                  {p.state && <span className="text-[11px] text-faint">{p.state}</span>}
                  <span className={"text-[11px] " + (p.enabled ? "text-moss-600 dark:text-moss-400" : "text-faint")}>
                    {p.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                {linked && (
                  <div className="text-[11px] text-accent dark:text-cobble-400 mt-0.5">
                    → {linked.machine_label ?? "linked machine"}
                  </div>
                )}
              </div>
              <select
                className={field}
                disabled={link.isPending || unlink.isPending || machines.isLoading}
                value={linked?.machine_id ?? ""}
                onChange={(e) => {
                  const machineId = e.target.value;
                  if (!machineId) {
                    if (linked) unlink.mutate(linked.id);
                    return;
                  }
                  const m = machineList.find((mm) => mm.id === machineId);
                  link.mutate({
                    remote_device_id: p.id,
                    remote_device_name: p.name,
                    machine_id: machineId,
                    machine_label: m?.name ?? null,
                  });
                }}
              >
                <option value="">— link to machine —</option>
                {machineList.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11px] text-faint">
        Link a farm printer to one of your machines — a job linked to that machine then routes to its printer automatically.
      </p>
    </Modal>
  );
}
