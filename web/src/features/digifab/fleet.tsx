// The digifab FLEET feature — the floor's card grid (FleetView), the
// per-device cockpit (PrinterDetailModal + controls/files/camera panels),
// connection setup (CreateConnectionModal, EdgeBridgeSetup), and the batch
// bar. Extracted from pages/DigifabPage.tsx (which was 5,700 lines and the
// only source of these components) so that:
//   1. no page imports another page's internals (lint-page-imports), and
//   2. the machines page can host the Fleet tab through the panel registry
//      (web/src/panels/registry.tsx) — a manifest-declared seam, not a
//      hardcoded import. See machines-digifab-unification.md §5.
// DigifabPage renders these same components on /digifab (Floor + Setup).

import { useState, useMemo, useEffect, useRef, Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Wifi, Printer, RefreshCw, AlertTriangle, Layers, X, Ban, Camera, Pause, Play, Thermometer, Sliders, ShieldCheck } from "lucide-react";
import { ApiError, api, fetchAuthBlobUrl, type DigifabFleet, type DigifabFleetDevice, type DigifabDeviceClass, type DigifabHistory, type DigifabDeviceDetail, type DigifabFileInfo } from "../../lib/api";
import { deviceBucket, fleetStatusChip } from "../../lib/fleet-status";
import { BambuConnectWizard } from "../../components/BambuConnectWizard";
import { BridgePicker } from "../../components/BridgePicker";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { Modal, useToast, useConfirm, useImageSrc, useOverlayOpenFlag } from "@cobblr/platform-web";
import { Combobox } from "../../components/Combobox";
import type { ModulePageTabCtx, EntityDetailPanelCtx } from "../../panels/types";

export type LinkableMachine = { id: string; name: string; instLabel: string | null; image: string | null };

/** A print history row is reprintable unless it's the task-derived kind. */
export const isReprintable = (r: { id: string }) => !r.id.startsWith("task:");

/** Every linkable machine across the machines module's instances (+ the
 *  default), tagged with its instance for clarity in pickers. */
export async function fetchAllMachines(slug: string): Promise<{ items: LinkableMachine[] }> {
  let insts: { instance_name: string; display_name: string; is_default: boolean }[] = [];
  try {
    insts = (await api.listInstances(slug, "machines")).items.map((i) => ({ instance_name: i.instance_name, display_name: i.display_name, is_default: i.is_default }));
  } catch {
    /* module may be single-instance — fall back to the default collection */
  }
  const sources: { name: string | undefined; label: string | null }[] = insts.length
    ? insts.map((i) => ({ name: i.is_default ? undefined : i.instance_name, label: i.is_default ? null : i.display_name }))
    : [{ name: undefined, label: null }];
  const lists = await Promise.all(
    sources.map((s) =>
      api.listMachines(slug, s.name).then((r) => r.items.map((m) => ({ id: m.id, name: m.name, instLabel: s.label, image: m.image_path ?? null }))).catch(() => [] as LinkableMachine[]),
    ),
  );
  const seen = new Set<string>();
  const items: LinkableMachine[] = [];
  for (const m of lists.flat()) if (!seen.has(m.id)) { seen.add(m.id); items.push(m); }
  return { items };
}

export function CreateConnectionModal({
  types,
  onClose,
  onCreated,
  presetType,
  presetName,
  presetDriver,
}: {
  types: string[];
  onClose: () => void;
  /** Receives the new connection's id (when known) so the caller can auto-select it. */
  onCreated: (connectionId?: string) => void;
  /** Pre-select the connection TYPE (e.g. "edge_adapter" when launched from a
   *  printer, so the user skips the type pick). */
  presetType?: string;
  /** Pre-fill the first machine's name (carry the printer's name over). */
  presetName?: string;
  /** Pre-select the first machine's driver (e.g. "moonraker"). */
  presetDriver?: string;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [type, setType] = useState(presetType ?? types[0] ?? "fdm_monster");
  // For a Bambu, the user chooses HOW it connects: cloud account (monitor) or LAN
  // via the edge bridge (full control). They're different connection shapes.
  const [bambuWay, setBambuWay] = useState<"cloud" | "lan">("cloud");
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
    onSuccess: (conn) => {
      toast.success("Connection added");
      onCreated((conn as { id?: string } | undefined)?.id);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

  return (
    <Modal open onClose={onClose} title="Add a connection" size="md">
      <div className="space-y-3">
        <label className="block">
          <span className={lbl}>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
            {types.map((t) => (
              <option key={t} value={t}>{t === "fdm_monster" ? "FDM Monster" : t === "mock" ? "Mock (test)" : t === "bambu" ? "Bambu Lab" : t === "edge_adapter" ? "Edge adapter (your bridge)" : t}</option>
            ))}
          </select>
        </label>
        {type === "bambu" ? (
          <div className="space-y-3">
            {/* How a Bambu connects — the two genuinely different paths. */}
            <div className="grid grid-cols-2 gap-2">
              {([
                { id: "cloud", title: "Cloud account", note: "Bambu login. Live status, temps, chamber light + pause/resume/stop. Add per-printer LAN later for full control & camera." },
                { id: "lan", title: "LAN via edge bridge", note: "Developer Mode + your bridge. Full control: send, pause, cancel, jog, camera." },
              ] as const).map((o) => (
                <button key={o.id} type="button" onClick={() => setBambuWay(o.id)}
                  className={"text-left rounded border p-2 transition " + (bambuWay === o.id ? "border-cobble-500 bg-cobble-50/40 dark:bg-cobble-900/20" : "border-line dark:border-slate-600 hover:border-accent")}>
                  <div className="text-xs font-medium text-content dark:text-mortar-100">{o.title}</div>
                  <div className="text-[10px] text-muted dark:text-slate-400 mt-0.5 leading-snug">{o.note}</div>
                </button>
              ))}
            </div>
            {bambuWay === "cloud"
              ? <BambuConnectWizard onConnected={() => onCreated()} onCancel={onClose} />
              : <EdgeBridgeSetup presetDriver="bambu" onCreated={onCreated} onClose={onClose} />}
          </div>
        ) : type === "edge_adapter" ? (
          <EdgeBridgeSetup onCreated={onCreated} onClose={onClose} presetName={presetName} presetDriver={presetDriver} />
        ) : (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
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
        )}
      </div>
    </Modal>
  );
}

// Guided edge-bridge setup. A hosted Cobblr can't reach a machine on your LAN —
// so you run a tiny bridge at your site that dials OUT and holds a tunnel open.
// This shows the one command to run it, watches for it to dial in, then creates
// the cobblr-edge:// connection that routes through the tunnel.
// What the bridge can drive + the fields each needs. Mirrors the bridge's
// built-in drivers (mock/moonraker/prusalink/duet/bambu/lightburn).
const BRIDGE_DRIVERS: { key: string; label: string; fields: { key: string; label: string; placeholder?: string; optional?: boolean }[] }[] = [
  { key: "mock", label: "Mock (test: no hardware)", fields: [] },
  { key: "moonraker", label: "Klipper (Moonraker)", fields: [{ key: "host", label: "Printer IP / host", placeholder: "192.168.1.50" }, { key: "apiKey", label: "API key (only if locked down)", optional: true }] },
  { key: "prusalink", label: "Prusa (PrusaLink)", fields: [{ key: "host", label: "Printer IP / host", placeholder: "192.168.1.213" }, { key: "apiKey", label: "PrusaLink API key" }] },
  { key: "duet", label: "Duet (RepRapFirmware)", fields: [{ key: "host", label: "Printer IP / host", placeholder: "192.168.1.50" }] },
  { key: "bambu", label: "Bambu Lab (LAN)", fields: [{ key: "host", label: "Printer IP" }, { key: "serial", label: "Serial" }, { key: "accessCode", label: "LAN access code" }] },
  { key: "lightburn", label: "LightBurn laser", fields: [{ key: "host", label: "IP of the PC running LightBurn" }] },
];

type MachineDraft = { key: string; name: string; driver: string; cfg: Record<string, string> };
let machineSeq = 0;
const newMachine = (driver = "mock"): MachineDraft => ({ key: `m${++machineSeq}`, name: "", driver, cfg: {} });
const defOf = (m: MachineDraft) => BRIDGE_DRIVERS.find((d) => d.key === m.driver) ?? BRIDGE_DRIVERS[0]!;

export function EdgeBridgeSetup({ onCreated, onClose, presetDriver, presetName }: { onCreated: (connectionId?: string) => void; onClose: () => void; presetDriver?: string; presetName?: string }) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [label, setLabel] = useState("Edge bridge");
  const [bridgeId, setBridgeId] = useState("");
  const [machines, setMachines] = useState<MachineDraft[]>(() => {
    const m = newMachine(presetDriver && BRIDGE_DRIVERS.some((d) => d.key === presetDriver) ? presetDriver : "mock");
    if (presetName?.trim()) m.name = presetName.trim(); // carry the name from the New-printer form
    return [m];
  });
  const [token, setToken] = useState<string | null>(null);
  const [cmdMode, setCmdMode] = useState<"run" | "compose">("compose");
  const bid = bridgeId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  // Name the bridge the status box is reporting on — you may run several, so
  // "your bridge is online" is ambiguous. Blank → the default/main bridge.
  const bridgeLabel = bid ? `the "${bid}" bridge` : "your main bridge";
  // The canonical kernel wire (bridges installed pre-move keep polling the
  // /modules/digifab/edge alias — both land on the same channel).
  const relayUrl = `${window.location.origin}/api/v1/orgs/${activeSlug}/edge`;
  const status = useQuery({
    queryKey: ["digifab-edge-status", activeSlug, bid],
    queryFn: () => api.getDigifabEdgeStatus(activeSlug, bid || undefined),
    enabled: !!activeSlug,
    refetchInterval: 3000,
  });
  const connected = !!status.data?.connected;

  const updateMachine = (key: string, patch: Partial<MachineDraft>) => setMachines((ms) => ms.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  const setField = (key: string, fk: string, v: string) => setMachines((ms) => ms.map((m) => (m.key === key ? { ...m, cfg: { ...m.cfg, [fk]: v } } : m)));

  // Unique instance ids (matched by the per-machine connection's cobblr-edge://<id>).
  const withIds = (() => {
    const seen = new Map<string, number>();
    return machines.map((m, i) => {
      let id = (m.name.trim() || m.driver).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `m${i + 1}`;
      const n = seen.get(id) ?? 0; seen.set(id, n + 1); if (n) id = `${id}-${n + 1}`;
      return { m, id };
    });
  })();
  const missing = machines.flatMap((m) => defOf(m).fields.filter((f) => !f.optional && !m.cfg[f.key]?.trim()).map((f) => `${m.name.trim() || defOf(m).label}: ${f.label}`));

  const mint = useMutation({
    mutationFn: () => api.createApiToken({ name: `Edge bridge: ${label.trim() || "bridge"}`, scopes: ["devices:edge"] }),
    onSuccess: (r) => setToken(r.token),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't generate a token."),
  });
  // The command carries NOTHING machine-specific — just the relay token. The
  // bridge installs once and stays open; machines are added below and ride down
  // the tunnel per request (dynamic config), so the box never needs re-running.
  const tok = token ?? "<generate the token first>";
  // Registry-free bootstrap: a stock public node image fetches the bridge CODE
  // from this Cobblr (loader → sha-verified bundle) with the tunnel token, and
  // self-updates by restarting onto new versions. No private registry.
  // The shell reads the token + URL from its ENVIRONMENT — the secret appears
  // once (env), never in argv/shell history. `|| true` keeps a cached loader
  // usable when the cloud blips during a restart.
  const shellCmd = 'wget -qO loader.mjs --header "Authorization: Bearer $BRIDGE_RELAY_TOKEN" "$BRIDGE_RELAY_URL/release/loader" || true; node loader.mjs';
  // docker run: single-quote for the HOST shell so $ survives to the container.
  const runCmd = `sh -c '${shellCmd}'`;
  // compose: list-form command (a colon inside a plain scalar breaks YAML) and
  // $$ so compose's own interpolation leaves the $ for the container shell.
  const composeCmd = `command: ["sh", "-c", "${shellCmd.replace(/\$/g, "$$$$").replace(/"/g, '\\"')}"]`;
  const cmd = [
    "docker run -d --name cobblr-edge-bridge --restart unless-stopped \\",
    "  -v cobblr-bridge-data:/data -w /data \\",
    "  -e BRIDGE_MODE=tunnel \\",
    `  -e BRIDGE_RELAY_URL=${relayUrl} \\`,
    `  -e BRIDGE_RELAY_TOKEN=${tok} \\`,
    ...(bid ? [`  -e BRIDGE_ID=${bid} \\`] : []),
    "  node:22-alpine \\",
    `  ${runCmd}`,
  ].join("\n");
  const compose = [
    "# docker-compose.yml — then: docker compose up -d",
    "# Self-updating: the bridge fetches its own code from your Cobblr (sha-verified)",
    "# and restarts onto new versions — stock node image, nothing else to pull.",
    "services:",
    "  cobblr-edge-bridge:",
    "    image: node:22-alpine",
    "    restart: unless-stopped",
    "    working_dir: /data",
    "    volumes:",
    "      - ./bridge-data:/data",
    "    environment:",
    "      BRIDGE_MODE: tunnel",
    `      BRIDGE_RELAY_URL: ${relayUrl}`,
    `      BRIDGE_RELAY_TOKEN: ${tok}`,
    ...(bid ? [`      BRIDGE_ID: ${bid}`] : []),
    `    ${composeCmd}`,
  ].join("\n");
  const snippet = cmdMode === "compose" ? compose : cmd;
  // One connection per machine — base_url cobblr-edge://<id> + the machine config
  // stored on it (rides the tunnel). The first id is returned to link the printer.
  const create = useMutation({
    mutationFn: async () => {
      let firstId: string | undefined;
      for (const { m, id } of withIds) {
        const config = { driver: m.driver, ...(bid ? { bridge: bid } : {}), ...Object.fromEntries(defOf(m).fields.map((f) => [f.key, m.cfg[f.key]?.trim()]).filter(([, v]) => v)) };
        const c = await api.createDigifabConnection(activeSlug, { type: "edge_adapter", label: m.name.trim() || defOf(m).label, base_url: `cobblr-edge://${id}`, config });
        if (!firstId) firstId = c.id;
      }
      return firstId;
    },
    onSuccess: (firstId) => { toast.success(machines.length > 1 ? `${machines.length} machines connected.` : "Machine connected."); onCreated(firstId); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't add the connection(s)."),
  });
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  return (
    <div className="space-y-3">
      {/* Multi-bridge: a SECOND bridge at another site (or LightBurn, which must
          run its own bridge on the LightBurn PC) gets a distinct id so it has its
          own channel instead of colliding with the main bridge. Above the
          already-connected check so you can add a 2nd bridge even when the main
          one's online — typing an id flips the view to that bridge's install. */}
      <label className="block">
        <span className={lbl}>Bridge <span className="normal-case text-faint/70"> - pick a connected one, or type an id you're about to install</span></span>
        <BridgePicker slug={activeSlug} value={bridgeId.trim() ? bridgeId : null} onChange={(v) => setBridgeId(v ?? "")} />
        <span className="text-[11px] text-faint mt-1 block">
          {bid
            ? <>Talking to <code>{bid}</code>  - this must match that bridge's <code>BRIDGE_ID</code>. A 2nd+ bridge (another site, or LightBurn's PC) <strong>must</strong> be named so it gets its own channel.</>
            : <>Blank = your <strong>main</strong> bridge (installed without a <code>BRIDGE_ID</code>). If you gave even your first bridge an id, type it here. Extra bridges always need a name.</>}
        </span>
      </label>
      {/* If THIS bridge is already dialed in, skip the install flow — just add a
          machine to it. (Keyed to the bridge id above.) */}
      {connected ? (
        <div className="flex items-center gap-2 text-sm rounded border border-moss-500/40 bg-moss-50 dark:bg-moss-950/30 p-2">
          <span className="w-2 h-2 rounded-full bg-moss-500 shrink-0" />
          <span className="text-moss-700 dark:text-moss-300">{bid ? <><code>{bid}</code></> : "Your main bridge"} is online ✓ - add a machine to it below. No reinstall needed.</span>
        </div>
      ) : (<>
      <p className="text-[13px] text-muted dark:text-slate-400">
        A hosted Cobblr can't reach a machine on your network directly. Run one tiny <strong>bridge</strong> on
        any always-on box at your site (Pi, NAS, mini-PC) - it dials out and holds a tunnel open (no inbound
        firewall hole). Install it once; <strong>add every machine at your site</strong> to it, anytime.
      </p>
      {/* STEP 1 — install the bridge (name + token; no machines needed yet). */}
      <label className="block">
        <span className={lbl}>1 · Name this bridge</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} className={field} autoFocus />
      </label>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className={lbl}>2 · Install the bridge</span>
          {token && (
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden text-[10px]">
                {(["run", "compose"] as const).map((mode) => (
                  <button key={mode} type="button" onClick={() => setCmdMode(mode)} className={"px-1.5 py-0.5 " + (cmdMode === mode ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}>
                    {mode === "run" ? "docker run" : "compose"}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(snippet); toast.success("Copied"); }} className="text-[10px] text-accent hover:underline">Copy</button>
            </div>
          )}
        </div>
        {!token ? (
          <button type="button" onClick={() => mint.mutate()} disabled={mint.isPending || !label.trim()}
            className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2.5 py-1.5">
            {mint.isPending ? "Generating…" : "Generate token & command"}
          </button>
        ) : (
          <>
            <pre className="text-[11px] leading-relaxed bg-subtle dark:bg-slate-950 border border-line dark:border-slate-700 rounded p-2 overflow-x-auto whitespace-pre text-content dark:text-mortar-200">{snippet}</pre>
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">Run this on a box at your site. Token shown once - it can <strong>only</strong> run this bridge (scope <code>devices:edge</code>).</p>
            <p className="text-[11px] text-faint mt-0.5">Stock public image - the bridge fetches its code from this Cobblr (sha-verified) and keeps itself updated automatically. Nothing to pull from a registry, ever.</p>
          </>
        )}
      </div>
      <div>
        <span className={lbl}>3 · Cobblr is watching for it</span>
        <div className={"flex items-center gap-2 text-sm rounded border p-2 " + (connected ? "border-moss-500/40 bg-moss-50 dark:bg-moss-950/30" : "border-line dark:border-slate-700")}>
          <span className={"w-2 h-2 rounded-full " + (connected ? "bg-moss-500" : "bg-amber-500 animate-pulse")} />
          {connected ? <span className="text-moss-700 dark:text-moss-300">{bid ? <><code>{bid}</code> online</> : "Main bridge online"}  - dialed in ✓</span> : <span className="text-muted dark:text-slate-400">Waiting for {bridgeLabel} to dial in…</span>}
        </div>
      </div>
      </>)}
      {/* Add machines to the bridge (the only step once it's online). */}
      <div className="space-y-2 pt-1 border-t border-line dark:border-slate-800">
        <span className={lbl}>{connected ? "Add a machine" : "4 · Machines on this bridge"}</span>
        {machines.map((m, i) => {
          const def = defOf(m);
          return (
            <div key={m.key} className="rounded border border-line dark:border-slate-700 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-faint">{i === 0 ? "First machine" : `Machine ${i + 1}`}</span>
                <div className="flex-1" />
                {machines.length > 1 && (
                  <button type="button" onClick={() => setMachines((ms) => ms.filter((x) => x.key !== m.key))} title="Remove machine" className="text-faint hover:text-ember-500 transition">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={lbl}>Name</span>
                  <input value={m.name} onChange={(e) => updateMachine(m.key, { name: e.target.value })} placeholder={def.label} className={field} />
                </label>
                <label className="block">
                  <span className={lbl}>Type</span>
                  <select value={m.driver} onChange={(e) => updateMachine(m.key, { driver: e.target.value, cfg: {} })} className={field}>
                    {BRIDGE_DRIVERS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </label>
                {def.fields.map((f) => (
                  <label key={f.key} className="block">
                    <span className={lbl}>{f.label}{f.optional ? "" : " *"}</span>
                    <input value={m.cfg[f.key] ?? ""} onChange={(e) => setField(m.key, f.key, e.target.value)} placeholder={f.placeholder} className={field} />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        <button type="button" onClick={() => setMachines((ms) => [...ms, newMachine()])} className="text-xs text-accent hover:underline">+ Add another machine</button>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
        <button type="button" onClick={() => create.mutate()} disabled={create.isPending || !connected || missing.length > 0}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          title={!connected ? "Start the bridge first" : missing.length ? `Fill in: ${missing.join(", ")}` : ""}>
          {create.isPending ? "Adding…" : machines.length > 1 ? `Add ${machines.length} machines` : "Add this machine"}
        </button>
      </div>
    </div>
  );
}

// The connection's printers, rendered INLINE as a children list (expanded under
// the connection row) — not a modal. Lists each farm printer + a link-to-machine
// picker so a job linked to that machine routes to its printer automatically.
// Machines live in INSTANCES — a workspace's printers are usually under a
// "3D Printers" instance, lasers under "Laser cutters", etc., not the default
// collection. So a link/route picker that reads only the default finds nothing
// ("no matches"). This gathers machines across EVERY instance of the machines

export const KLASS_STYLE: Record<DigifabDeviceClass, { dot: string; text: string; ring: string }> = {
  printing: { dot: "bg-cobble-500", text: "text-cobble-700 dark:text-cobble-300", ring: "border-cobble-300 dark:border-cobble-700" },
  idle: { dot: "bg-moss-500", text: "text-moss-700 dark:text-moss-400", ring: "border-line dark:border-slate-700" },
  paused: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", ring: "border-amber-300 dark:border-amber-800" },
  complete: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", ring: "border-amber-300 dark:border-amber-800" },
  error: { dot: "bg-ember-500", text: "text-ember-600 dark:text-ember-500", ring: "border-ember-300 dark:border-ember-800" },
  offline: { dot: "bg-faint", text: "text-faint", ring: "border-line dark:border-slate-700" },
  unknown: { dot: "bg-faint", text: "text-muted", ring: "border-line dark:border-slate-700" },
};


function FleetBatchBar({
  slug,
  devices,
  onDone,
  confirm,
  toast,
}: {
  slug: string;
  devices: Array<DigifabFleetDevice & { connId: string }>;
  onDone: () => void;
  confirm: ReturnType<typeof useConfirm>;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  const pausable = devices.filter((d) => d.active_job?.status === "printing");
  const resumable = devices.filter((d) => d.active_job?.status === "paused");
  const stoppable = devices.filter((d) => d.active_job && ["printing", "paused", "sent"].includes(d.active_job.status));
  const clearable = devices.filter((d) => d.needs_attention);
  const run = async (label: string, items: Array<DigifabFleetDevice & { connId: string }>, fn: (d: DigifabFleetDevice & { connId: string }) => Promise<unknown>, destructive = false) => {
    const ok = await confirm({
      title: `${label} ${items.length} machine${items.length === 1 ? "" : "s"}?`,
      message: destructive ? "On a live farm this affects running prints." : "Applies to every selected machine that supports it.",
      confirmLabel: label,
      destructive,
    });
    if (!ok) return;
    setBusy(true);
    const results = await Promise.allSettled(items.map(fn));
    const failed = results.filter((r) => r.status === "rejected").length;
    toast[failed ? "info" : "success"](failed ? `${label}: ${items.length - failed} ok, ${failed} failed` : `${label}: done on ${items.length}`);
    setBusy(false);
    onDone();
  };
  const btn = "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition disabled:opacity-50";
  return (
    <div className="sticky bottom-3 z-10 flex items-center gap-2 rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 shadow-lg px-3 py-2">
      <span className="text-xs font-medium text-content dark:text-mortar-100">{devices.length} selected</span>
      {pausable.length + resumable.length + stoppable.length + clearable.length === 0 && (
        <span className="text-[11px] text-faint italic">no batch actions for this selection - select running or finished machines</span>
      )}
      <div className="flex-1" />
      {pausable.length > 0 && (
        <button disabled={busy} onClick={() => run("Pause", pausable, (d) => api.pauseDigifabJob(slug, d.active_job!.id))} className={btn + " border border-line dark:border-slate-600 hover:border-accent hover:text-accent"}>
          <Pause size={12} /> Pause {pausable.length}
        </button>
      )}
      {resumable.length > 0 && (
        <button disabled={busy} onClick={() => run("Resume", resumable, (d) => api.resumeDigifabJob(slug, d.active_job!.id))} className={btn + " border border-line dark:border-slate-600 hover:border-accent hover:text-accent"}>
          <Play size={12} /> Resume {resumable.length}
        </button>
      )}
      {stoppable.length > 0 && (
        <button disabled={busy} onClick={() => run("Stop", stoppable, (d) => api.cancelDigifabJob(slug, d.active_job!.id), true)} className={btn + " border border-line dark:border-slate-600 hover:border-ember-500 hover:text-ember-500"}>
          <Ban size={12} /> Stop {stoppable.length}
        </button>
      )}
      {clearable.length > 0 && (
        <button disabled={busy} onClick={() => run("Clear bed on", clearable, (d) => api.markDigifabDeviceReady(slug, d.connId, d.id, "good"))} className={btn + " bg-moss-600 hover:bg-moss-700 text-white"}>
          Clear {clearable.length} bed{clearable.length === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}


const DEVICE_DRAG_MIME = "application/x-cobblr-fleet-device";

export type FleetDev = DigifabFleetDevice & { connLabel: string; connId: string; connType: string };
const devKey = (d: { connId: string; id: string }) => `${d.connId}:${d.id}`;

/** Free-form fleet layout — the tiles ARE the floor (no cell grid, no arrange
 *  mode). Drag any tile: it hides in place and a dashed PLACEHOLDER slot shows
 *  exactly where it will land — tiles around the slot shift once and stay put
 *  (targets are computed against the tiles' fixed geometry, never against the
 *  placeholder, so the preview can't feed back into itself and bounce). The
 *  strips between rows accept a drop to START A NEW ROW in place; the hovered
 *  strip swells into a full-height slot and stays stable under the cursor.
 *  Machines with no saved slot flow in a trailing row. Order + row starts
 *  persist per-workspace (PUT fleet/layout). */
function ReorderableRows({ slug, devices, gridCls, canDrag, dataVersion, renderTile }: {
  slug: string;
  devices: FleetDev[];
  gridCls: string;
  /** False while a bucket filter hides tiles or batch-select is on. */
  canDrag: boolean;
  /** Bumps when fresh fleet data lands — drops the optimistic post-drop layout. */
  dataVersion: number;
  renderTile: (d: FleetDev) => ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const boxRef = useRef<HTMLDivElement>(null);
  const byKey = new Map(devices.map((d) => [devKey(d), d]));

  // Baseline rows from the saved layout: placed devices ordered by sort_order,
  // split where row_break starts a new row; unplaced trail in their own row.
  const baseRows = useMemo(() => {
    const placed = devices.filter((d) => d.sort_order != null).sort((a, b) => a.sort_order! - b.sort_order!);
    const rest = devices.filter((d) => d.sort_order == null);
    const rows: string[][] = [];
    let cur: string[] = [];
    for (const d of placed) {
      if (d.row_break && cur.length) { rows.push(cur); cur = []; }
      cur.push(devKey(d));
    }
    if (cur.length) rows.push(cur);
    if (rest.length) rows.push(rest.map(devKey));
    return rows;
  }, [devices]);

  const [drag, setDrag] = useState<string | null>(null); // tile in hand (hidden in place)
  // Landing slot, in RENDERED coordinates (row index / index among visible
  // tiles, or a gap between rows). Never derived from the placeholder itself.
  const [target, setTarget] = useState<{ kind: "cell"; row: number; index: number } | { kind: "gap"; gap: number } | null>(null);
  const [committed, setCommitted] = useState<string[][] | null>(null); // optimistic after drop
  useEffect(() => { setCommitted(null); }, [dataVersion]);
  const rows = committed ?? baseRows;

  const save = useMutation({
    mutationFn: (layout: string[][]) =>
      api.saveDigifabFleetLayout(
        slug,
        layout.flatMap((row, ri) =>
          row
            .map((k, i) => {
              const d = byKey.get(k);
              return d ? { connection_id: d.connId, device_id: d.id, row_break: ri > 0 && i === 0 } : null;
            })
            .filter((x): x is { connection_id: string; device_id: string; row_break: boolean } => !!x),
        ),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] }),
    onError: (e) => {
      setCommitted(null);
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the layout");
    },
  });

  const setTargetIf = (t: typeof target) =>
    setTarget((prev) => (JSON.stringify(prev) === JSON.stringify(t) ? prev : t));

  /** The layout a drop right now would produce. Indices are in rendered terms:
   *  rows keep their slots (a row whose only tile is the hidden dragged one
   *  still occupies its index) until the final empty-row sweep. */
  const droppedRows = (): string[][] => {
    if (!drag) return rows;
    const out = rows.map((r) => r.filter((x) => x !== drag));
    if (!target) {
      out.push([drag]);
    } else if (target.kind === "gap") {
      out.splice(Math.max(0, Math.min(target.gap, out.length)), 0, [drag]);
    } else {
      const r = out[target.row];
      if (r) r.splice(Math.max(0, Math.min(target.index, r.length)), 0, drag);
      else out.push([drag]);
    }
    return out.filter((r) => r.length > 0);
  };

  // ONE hit-test on the container. Geometry comes from the real tiles (the
  // hidden dragged tile and the placeholder are excluded), so hovering the
  // placeholder or the space it opened recomputes to the SAME target — stable.
  const onDragOverBox = (e: React.DragEvent) => {
    if (!drag || !e.dataTransfer.types.includes(DEVICE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    if (el?.closest("[data-drop-placeholder]")) return; // over the landing slot → keep it
    const strip = el?.closest<HTMLElement>("[data-drop-gap]");
    if (strip) {
      setTargetIf({ kind: "gap", gap: Number(strip.dataset.dropGap) });
      return;
    }
    const box = boxRef.current;
    if (!box) return;
    const rowEls = Array.from(box.querySelectorAll<HTMLElement>("[data-drop-row]"));
    for (const rowEl of rowEls) {
      const rect = rowEl.getBoundingClientRect();
      if (rect.height === 0 || e.clientY < rect.top || e.clientY > rect.bottom) continue;
      const ri = Number(rowEl.dataset.dropRow);
      const tiles = Array.from(rowEl.querySelectorAll<HTMLElement>("[data-drop-key]")).filter(
        (t) => t.dataset.dropKey !== drag,
      );
      let idx = tiles.length;
      for (let i = 0; i < tiles.length; i++) {
        const tr = tiles[i]!.getBoundingClientRect();
        if (e.clientX < tr.left + tr.width / 2) { idx = i; break; }
      }
      setTargetIf({ kind: "cell", row: ri, index: idx });
      return;
    }
    // Outside every row band: snap to the nearest end gap.
    if (rowEls.length) {
      const first = rowEls[0]!.getBoundingClientRect();
      if (e.clientY < first.top) setTargetIf({ kind: "gap", gap: 0 });
      else setTargetIf({ kind: "gap", gap: rows.length });
    }
  };

  const finishDrag = () => { setDrag(null); setTarget(null); };
  const commitDrop = (e: React.DragEvent) => {
    if (!drag || !e.dataTransfer.types.includes(DEVICE_DRAG_MIME)) return;
    e.preventDefault();
    const final = droppedRows();
    setCommitted(final);
    save.mutate(final);
    finishDrag();
  };

  // The landing slot — dashed, tile-shaped. pointer-events stay ON so the
  // placeholder guard above can hold the target steady while hovered.
  const slotCls = "rounded-lg border-2 border-dashed border-accent/60 bg-accent/5 min-h-16";

  return (
    <div
      ref={boxRef}
      className="space-y-2"
      onDragOver={onDragOverBox}
      onDrop={commitDrop}
    >
      {rows.map((row, ri) => {
        const gapHot = target?.kind === "gap" && target.gap === ri;
        return (
          <Fragment key={ri}>
            {drag != null &&
              (gapHot ? (
                <div data-drop-placeholder className={slotCls + " h-20 flex items-center justify-center text-[10px] font-mono uppercase tracking-wider text-accent/80"}>
                  new row
                </div>
              ) : (
                <div data-drop-gap={ri} className="h-6 rounded border border-dashed border-accent/30 bg-accent/5 flex items-center justify-center text-[9px] font-mono uppercase tracking-wider text-accent/50">
                  new row
                </div>
              ))}
            <div data-drop-row={ri} className={gridCls}>
              {(() => {
                // Placeholder indices are in VISIBLE-tile terms (the hidden
                // dragged tile doesn't count), while `row` still contains it —
                // map each key to its visible index so the slot lands true.
                const visIdx = new Map<string, number>();
                let c = 0;
                for (const k of row) if (k !== drag) visIdx.set(k, c++);
                return row.map((k, i) => {
                const d = byKey.get(k);
                if (!d) return null; // device vanished between refreshes
                const showSlot = drag != null && k !== drag && target?.kind === "cell" && target.row === ri && target.index === visIdx.get(k);
                return (
                  <Fragment key={k}>
                    {showSlot && <div data-drop-placeholder className={slotCls} />}
                    <div
                      data-drop-key={k}
                      draggable={canDrag && !drag}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DEVICE_DRAG_MIME, JSON.stringify({ connId: d.connId, id: d.id }));
                        e.dataTransfer.effectAllowed = "move";
                        // Let the browser capture the drag image BEFORE the tile
                        // hides — hiding synchronously kills the drag in Firefox.
                        const kk = k;
                        setTimeout(() => {
                          setDrag(kk);
                          setTarget({ kind: "cell", row: ri, index: i }); // anchor at origin
                        }, 0);
                      }}
                      onDragEnd={finishDrag}
                      className={(canDrag ? "cursor-grab active:cursor-grabbing " : "") + (drag === k ? "hidden" : "")}
                    >
                      {renderTile(d)}
                    </div>
                  </Fragment>
                );
                });
              })()}
              {drag != null && target?.kind === "cell" && target.row === ri && target.index >= row.filter((x) => x !== drag).length && (
                <div data-drop-placeholder className={slotCls} />
              )}
            </div>
          </Fragment>
        );
      })}
      {drag != null &&
        (target?.kind === "gap" && target.gap === rows.length ? (
          <div data-drop-placeholder className={slotCls + " h-20 flex items-center justify-center text-[10px] font-mono uppercase tracking-wider text-accent/80"}>
            new row
          </div>
        ) : (
          <div data-drop-gap={rows.length} className="h-6 rounded border border-dashed border-accent/30 bg-accent/5 flex items-center justify-center text-[9px] font-mono uppercase tracking-wider text-accent/50">
            new row
          </div>
        ))}
    </div>
  );
}

// deviceBucket moved to lib/fleet-status.ts — ONE status vocabulary shared
// with the machines registry's live chips (machines-digifab-unification.md §3).

/** Last fleet response, persisted per workspace — the floor paints from it the
 *  INSTANT the page loads (the live aggregate asks every manager and can take
 *  seconds); the immediate refetch + 12s poll then correct it. A few-seconds-
 *  stale card beats a skeleton every time (the author). */
const fleetSnapKey = (slug: string) => `cobblr.fleet.last.${slug}`;
function readFleetSnap(slug: string): DigifabFleet | undefined {
  try {
    const raw = localStorage.getItem(fleetSnapKey(slug));
    return raw ? (JSON.parse(raw) as DigifabFleet) : undefined;
  } catch {
    return undefined;
  }
}

export function FleetView({ slug, machineIds, scopeNoun }: {
  slug: string;
  /** Scope the floor to devices linked to these machines (the instance Fleet
   *  tab — "just my 3D printers, live"). Undefined = the whole shop floor.
   *  Devices outside the scope are counted in an honesty footer, never
   *  silently dropped (machines-digifab-unification.md §4). */
  machineIds?: Set<string>;
  /** The scope's item noun ("3D printer"), for the honesty footer. */
  scopeNoun?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fleet = useQuery({
    queryKey: ["digifab-fleet", slug],
    queryFn: async () => {
      const d = await api.getDigifabFleet(slug);
      try {
        localStorage.setItem(fleetSnapKey(slug), JSON.stringify(d));
      } catch {
        /* quota/private-mode — instant paint just degrades to the skeleton */
      }
      return d;
    },
    enabled: !!slug,
    refetchInterval: 12_000,
    // Refetches keep showing the previous floor instead of blanking it.
    placeholderData: (prev) => prev,
    // Cold load: hydrate from the persisted snapshot so machines render on the
    // first frame; updatedAt 0 marks it stale so the real fetch fires at once.
    initialData: () => readFleetSnap(slug),
    initialDataUpdatedAt: 0,
  });
  // Server said it answered from a stale cache (its live refresh is already
  // running) — refetch quickly a couple of times so fresh state lands in
  // seconds instead of at the next 12s poll. Bounded so a manager that's
  // genuinely down can't turn this into a fast-poll loop.
  const staleRetries = useRef(0);
  useEffect(() => {
    if (!fleet.data?.stale) { staleRetries.current = 0; return; }
    if (staleRetries.current >= 3) return;
    const t = setTimeout(() => { staleRetries.current += 1; void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] }); }, 2500);
    return () => clearTimeout(t);
  }, [fleet.data, qc, slug]);
  // Operator bucket filter (All / Working / Needs you / Idle / Off) — the
  // summary counts double as clickable filters.
  const [bucket, setBucket] = useState<"all" | "working" | "needs" | "idle" | "off">("all");
  // View mode: Cards (default) / Compact (density for big farms) / Cameras
  // (an OctoFarm-style webcam wall). Persisted.
  const [mode, setMode] = useState<"cards" | "dense" | "cams">(() => {
    const m = localStorage.getItem("cobblr.fleet.mode");
    return m === "dense" || m === "cams" ? m : "cards";
  });
  const pickMode = (m: "cards" | "dense" | "cams") => { localStorage.setItem("cobblr.fleet.mode", m); setMode(m); };
  const dense = mode === "dense";
  // Batch mode: select tiles → one action bar (FDMM-style).
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set()); // `${connId}:${deviceId}`
  const toggleSel = (k: string) => setSel((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const invalidateFleet = () => void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] });
  const data = fleet.data;
  // First load: render the section FRAME immediately with skeleton cards — the
  // fleet aggregate can take a few seconds (it asks every manager), and having
  // the whole section pop in later reads as broken layout (the author).
  if (!data) {
    return (
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Fleet</h2>
          <span className="text-xs font-mono text-faint">{fleet.isError ? "couldn't reach the farm — retrying" : "checking your machines…"}</span>
          {!fleet.isError && <RefreshCw size={13} className="animate-spin text-faint" />}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-2.5 animate-pulse space-y-2">
              <div className="h-3.5 w-2/3 rounded bg-line dark:bg-slate-700" />
              <div className="h-2.5 w-1/2 rounded bg-line dark:bg-slate-700" />
              <div className="h-1 w-full rounded bg-line dark:bg-slate-700" />
            </div>
          ))}
        </div>
      </section>
    );
  }
  // Scope filter (the instance Fleet tab): only devices linked to the given
  // machines. Kept OUT of the whole-shop floor (/digifab), which passes no
  // machineIds. Counted for the honesty footer below — never silently dropped.
  const inScope = (d: DigifabFleetDevice) => !machineIds || (!!d.linked_machine_id && machineIds.has(d.linked_machine_id));
  const allDevsUnscoped = data.connections.filter((c) => !c.error).flatMap((c) => c.devices);
  const scopedOutCount = machineIds ? allDevsUnscoped.filter((d) => !inScope(d)).length : 0;
  // Bucket counts over the (scoped) floor — the chips both inform AND filter.
  const allDevs = allDevsUnscoped.filter(inScope);
  const nBucket = (b: "working" | "needs" | "idle" | "off") => allDevs.filter((d) => deviceBucket(d) === b).length;
  const chips: Array<{ key: typeof bucket; label: string; n: number; dot: string }> = [
    { key: "all", label: "All", n: allDevs.length, dot: "bg-line" },
    { key: "working", label: "Working", n: nBucket("working"), dot: "bg-cobble-500" },
    { key: "needs", label: "Needs you", n: nBucket("needs"), dot: "bg-amber-500" },
    { key: "idle", label: "Idle", n: nBucket("idle"), dot: "bg-moss-500" },
    { key: "off", label: "Off", n: nBucket("off"), dot: "bg-faint" },
  ];
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Fleet</h2>
        {/* Operator buckets — clickable filters, Bambu-style ("what do I do?"). */}
        <div className="flex items-center gap-1">
          {chips.map((c) => (
            (c.n > 0 || c.key === "all") && (
              <button
                key={c.key}
                type="button"
                onClick={() => setBucket(c.key)}
                className={
                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] transition " +
                  (bucket === c.key
                    ? "bg-cobble-600 text-white"
                    : "border border-line dark:border-slate-600 text-muted hover:border-accent hover:text-accent")
                }
              >
                <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                {c.label} {c.n}
              </button>
            )
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => { setSelecting((v) => !v); setSel(new Set()); }}
          className={"text-[11px] px-2 py-0.5 rounded border transition " + (selecting ? "border-cobble-500 text-accent" : "border-line dark:border-slate-600 text-muted hover:border-accent hover:text-accent")}
          title="Select machines for a batch action"
        >
          {selecting ? "Done" : "Select"}
        </button>
        <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden">
          {([["cards", "Cards"], ["dense", "Compact"], ["cams", "Cameras"]] as const).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => pickMode(m)}
              className={"text-[11px] px-2 py-0.5 transition " + (mode === m ? "bg-cobble-600 text-white" : "text-muted hover:text-accent")}
              title={m === "cams" ? "Webcam wall — every machine's camera" : m === "dense" ? "Compact cards (fit more machines)" : "Full cards"}
            >
              {label}
            </button>
          ))}
        </div>
        {fleet.isFetching && <RefreshCw size={13} className="animate-spin text-faint" />}
      </div>
      {(() => {
        // Group machines by POOL (a pool reads as one farm even across
        // connections); unpooled machines fall back to their connection. A
        // dead manager keeps its own error row.
        type FDev = FleetDev;
        const errored = data.connections.filter((c) => c.error);
        const allUnfiltered: FDev[] = data.connections
          .filter((c) => !c.error)
          .flatMap((c) => c.devices.map((d) => ({ ...d, connLabel: c.label, connId: c.connection_id, connType: c.type })))
          .filter(inScope);
        const all: FDev[] = allUnfiltered.filter((d) => bucket === "all" || deviceBucket(d) === bucket);
        const connDeviceCountEarly = new Map<string, number>();
        for (const d of allUnfiltered) connDeviceCountEarly.set(d.connId, (connDeviceCountEarly.get(d.connId) ?? 0) + 1);
        const manyConnsEarly = new Set(allUnfiltered.filter((d) => !d.pool_id).map((d) => d.connId)).size > 1;
        const pools = new Map<string, { name: string; devices: FDev[] }>();
        const unpooled = new Map<string, FDev[]>();
        for (const d of all) {
          if (d.pool_id) {
            const g = pools.get(d.pool_id) ?? { name: d.pool_name ?? "Pool", devices: [] };
            g.devices.push(d);
            pools.set(d.pool_id, g);
          } else {
            const arr = unpooled.get(d.connLabel) ?? [];
            arr.push(d);
            unpooled.set(d.connLabel, arr);
          }
        }
        // Farm-floor order: what's WORKING leads, dead metal trails.
        const RANK: Record<string, number> = { printing: 0, paused: 1, complete: 2, idle: 3, error: 4, unknown: 5, offline: 6 };
        const byActivity = (a: FDev, b: FDev) =>
          (a.needs_attention ? -1 : RANK[a.klass] ?? 9) - (b.needs_attention ? -1 : RANK[b.klass] ?? 9) || a.name.localeCompare(b.name);
        const sections: Array<{ key: string; label: string | null; isPool: boolean; devices: FDev[] }> = [];
        for (const [id, g] of pools) sections.push({ key: `pool:${id}`, label: g.name, isPool: true, devices: g.devices.sort(byActivity) });
        // Unpooled machines share ONE grid — a connection is plumbing, not a
        // section: three single-printer connections used to render as three
        // full-width rows of one lonely card each (the author). The connection identity
        // moves onto the card instead: a single-machine connection's LABEL is the
        // human name ("RailCore 300ZL — Justin"), so the card leads with it and
        // demotes the device name ("Klipper (192.168.1.128)") to a subtitle;
        // multi-machine connections keep the device name and note the connection.
        //
        // Counts come from the UNFILTERED floor (connDeviceCountEarly /
        // manyConnsEarly): a bucket filter narrowing a multi-printer connection
        // down to one visible card must NOT flip it into "single-machine
        // connection" naming — a card's identity can't change with the filter
        // (the author: Thumper read as "Bambu (account…)" under Needs-you).
        const flat: FDev[] = [...unpooled.values()].flat().sort(byActivity);
        if (flat.length > 0) sections.push({ key: "unpooled", label: pools.size > 0 ? "Machines" : null, isPool: false, devices: flat });
        const titleFor = (d: FDev): { title: string; sub: string | null } => {
          // One machine, two lenses: a LINKED machine's own name is the tile
          // title — the tile IS the machine, not a parallel connection-side
          // identity. Connection label / device name demote to the subtitle.
          if (d.linked_machine?.name) {
            if (d.pool_id) return { title: d.linked_machine.name, sub: null };
            const sub = (connDeviceCountEarly.get(d.connId) ?? 0) === 1 && d.connLabel ? d.connLabel : manyConnsEarly && d.connLabel ? d.connLabel : d.name;
            return { title: d.linked_machine.name, sub: sub && sub !== d.linked_machine.name ? sub : null };
          }
          if (d.pool_id) return { title: d.name, sub: null };
          if ((connDeviceCountEarly.get(d.connId) ?? 0) === 1 && d.connLabel && d.connLabel !== d.name) {
            return { title: d.connLabel, sub: d.name };
          }
          return { title: d.name, sub: manyConnsEarly ? d.connLabel : null };
        };
        return (
          <>
            {sections.map((sec) => {
              const gridCls = dense ? "grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-1.5" : mode === "cams" ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" : "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2";
              const tile = (d: FDev) => {
                const t = titleFor(d);
                const k = `${d.connId}:${d.id}`;
                return (
                  <DeviceCard
                    key={`${sec.key}:${k}`}
                    d={d}
                    connId={d.connId}
                    slug={slug}
                    title={t.title}
                    subtitle={t.sub}
                    dense={dense}
                    cams={mode === "cams"}
                    selecting={selecting}
                    selected={sel.has(k)}
                    onToggleSelect={() => toggleSel(k)}
                  />
                );
              };
              return (
                <div key={sec.key} className="space-y-1.5">
                  {sec.label && (
                    <div className="text-[11px] font-mono uppercase tracking-wider text-faint flex items-center gap-1.5">
                      {sec.isPool && <Layers size={11} className="text-accent" />}
                      {sec.label}
                      {sec.isPool && <span className="text-faint/70">· {sec.devices.length} machine{sec.devices.length === 1 ? "" : "s"}</span>}
                    </div>
                  )}
                  {sec.isPool ? (
                    <div className={gridCls}>{sec.devices.map(tile)}</div>
                  ) : (
                    // The open floor: always-on drag-reorder with row breaks.
                    // Drag disabled while a bucket filter hides tiles (a partial
                    // view can't safely rewrite the full layout) or selecting.
                    <ReorderableRows
                      slug={slug}
                      devices={sec.devices}
                      gridCls={gridCls}
                      canDrag={bucket === "all" && !selecting}
                      dataVersion={fleet.dataUpdatedAt}
                      renderTile={tile}
                    />
                  )}
                </div>
              );
            })}
            {errored.map((c) => (
              <div key={c.connection_id} className="flex items-center gap-1.5 text-xs text-ember-600 dark:text-ember-500">
                <AlertTriangle size={13} className="shrink-0" /> {c.label} unreachable - {c.error}
              </div>
            ))}
            {sections.length === 0 && errored.length === 0 && (
              <div className="text-xs text-faint italic">
                {bucket !== "all"
                  ? "Nothing in this bucket right now."
                  : machineIds
                    ? `No ${scopeNoun ?? "machine"}s are linked to the farm yet — link one from its page (or on Digital Fabrication → Setup).`
                    : "No machines reported."}
              </div>
            )}
            {/* Honesty footer: scoping must say what it hid, never silently drop
                farm devices (machines-digifab-unification.md §4). */}
            {machineIds && scopedOutCount > 0 && (
              <div className="text-[11px] text-faint">
                {scopedOutCount} device{scopedOutCount === 1 ? " on the farm isn't" : "s on the farm aren't"} linked to a {scopeNoun ?? "machine"} in this collection - {" "}
                <Link to="/digifab" className="text-accent hover:underline">see Digital Fabrication</Link>
              </div>
            )}
            {selecting && sel.size > 0 && (
              <FleetBatchBar
                slug={slug}
                devices={all.filter((d) => sel.has(`${d.connId}:${d.id}`))}
                onDone={() => { setSel(new Set()); invalidateFleet(); }}
                confirm={confirm}
                toast={toast}
              />
            )}
          </>
        );
      })()}
    </section>
  );
}

/** Camera-wall fallback: no camera source, but the linked machine has a photo —
 *  show the machine's own portrait instead of a dark void, with a quiet "no
 *  camera" chip so nobody mistakes it for a live feed. */
function MachinePhotoFill({ src, alt }: { src: string; alt: string }) {
  const resolved = useImageSrc(src);
  const [failed, setFailed] = useState(false);
  if (!resolved || failed) {
    return <span className="flex flex-col items-center gap-1 text-faint text-[11px]"><Camera size={18} /> no camera</span>;
  }
  return (
    <div className="relative w-full h-full">
      <img src={resolved} alt={alt} draggable={false} className="w-full h-full object-cover" onError={() => setFailed(true)} />
      <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/55 text-[9px] font-mono uppercase tracking-wider text-white/85 inline-flex items-center gap-1">
        <Camera size={9} /> no camera
      </span>
    </div>
  );
}

// Cockpit: temps + the "set camera URL" affordance live on the device card.
export function tempLabel(t: { actual: number; target?: number } | null | undefined): string | null {
  if (!t) return null;
  return t.target ? `${Math.round(t.actual)}/${Math.round(t.target)}°` : `${Math.round(t.actual)}°`;
}

/** Minutes → "13h 2m" / "45m" — readable remaining-time. */
export function fmtRemaining(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// The relayed snapshot: auth-fetch the latest agent-pushed frame to a blob URL.
// `live` → refresh every few seconds (a near-live thumbnail while the printer
// works); otherwise fetch ONCE and freeze it — the last frame stays visible with
// no constant bandwidth on an idle bed.
export function RelaySnapshot({ slug, connId, deviceId, name, live }: { slug: string; connId: string; deviceId: string; name: string; live: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    const tick = async () => {
      const next = await fetchAuthBlobUrl(api.digifabSnapshotPath(slug, connId, deviceId));
      if (!alive) { if (next) URL.revokeObjectURL(next); return; }
      if (next) { setUrl(next); if (current) URL.revokeObjectURL(current); current = next; }
    };
    void tick(); // always grab the latest stored frame once (even if stale)
    const id = live ? setInterval(tick, 5000) : null;
    return () => { alive = false; if (id) clearInterval(id); if (current) URL.revokeObjectURL(current); };
  }, [slug, connId, deviceId, live]);
  if (!url) return null;
  return <img src={url} alt={`${name} camera`} className="mb-1.5 w-full h-24 object-cover rounded bg-black/30" />;
}

export const LIBRARY_DRAG_MIME = "application/x-cobblr-library-item";

function RelaySnapshotFill({ slug, connId, deviceId, name, live }: { slug: string; connId: string; deviceId: string; name: string; live: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    const tick = async () => {
      const next = await fetchAuthBlobUrl(api.digifabSnapshotPath(slug, connId, deviceId));
      if (!alive) { if (next) URL.revokeObjectURL(next); return; }
      if (next) { setUrl(next); if (current) URL.revokeObjectURL(current); current = next; }
    };
    void tick();
    const id = live ? setInterval(tick, 5000) : null;
    return () => { alive = false; if (id) clearInterval(id); if (current) URL.revokeObjectURL(current); };
  }, [slug, connId, deviceId, live]);
  if (!url) return <span className="flex flex-col items-center gap-1 text-faint text-[11px]"><Camera size={18} /> waiting for a frame…</span>;
  return <img src={url} alt={`${name} camera`} draggable={false} className="w-full h-full object-cover" />;
}

/** Camera-wall fill for a printer whose camera rides the LAN bridge (Bambu
 *  hybrid): the same /camera frame-grab the cockpit uses, polled gently. The
 *  server-cached snapshot paints first so the tile is never blank. */
function LanCameraFill({ slug, connId, deviceId, name, live, klass }: { slug: string; connId: string; deviceId: string; name: string; live: boolean; klass: DigifabDeviceClass }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Only consulted once a frame-grab has FAILED: the bridge's live status turns
  // "camera unreachable" into a diagnosis instead of a shrug. A connected
  // bridge (fresh poll) can't be the problem; then the device's own reported
  // state says whether the PRINTER is dark or just its camera.
  const edge = useQuery({
    queryKey: ["edge-status", slug],
    queryFn: () => api.getEdgeStatus(slug),
    enabled: !!slug && failed,
    refetchInterval: failed ? 30_000 : false,
    staleTime: 15_000,
  });
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    const swap = (next: string | null, isFrame: boolean) => {
      if (!alive) { if (next) URL.revokeObjectURL(next); return; }
      if (!next) { if (!current && isFrame) setFailed(true); return; }
      setUrl(next); setFailed(false);
      if (current) URL.revokeObjectURL(current);
      current = next;
    };
    // Instant: last server-cached snapshot, then live frames replace it.
    void fetchAuthBlobUrl(api.digifabSnapshotPath(slug, connId, deviceId)).then((c) => { if (!current) swap(c, false); else if (c) URL.revokeObjectURL(c); });
    const tick = async () => swap(await fetchAuthBlobUrl(api.digifabCameraPath(slug, connId, deviceId)), true);
    void tick();
    const id = setInterval(tick, live ? 5000 : 20000);
    return () => { alive = false; clearInterval(id); if (current) URL.revokeObjectURL(current); };
  }, [slug, connId, deviceId, live]);
  if (!url) {
    let msg = "connecting…";
    let hint: string | null = null;
    if (failed) {
      const staleMs = edge.data?.stale_after_ms ?? 60_000;
      const agents = edge.data?.agents ?? [];
      const bridgeUp = agents.some((a) => a.last_seen_ms < staleMs);
      if (edge.isLoading) {
        msg = "camera unreachable";
        hint = "checking the bridge…";
      } else if (!bridgeUp) {
        msg = "bridge offline";
        hint = "nothing on-site can be reached — start the bridge / check its box";
      } else if (klass === "offline" || klass === "unknown") {
        msg = "printer unreachable";
        hint = "the bridge is connected, so it's probably the printer — powered off (maybe on purpose) or unplugged";
      } else {
        msg = "camera unreachable";
        hint = "the printer itself is responding and the bridge is fine — check the camera / LAN-access settings";
      }
    }
    return (
      <span className="flex flex-col items-center gap-1 text-faint text-[11px] text-center px-3">
        <Camera size={18} /> {msg}
        {hint && <span className="text-[10px] text-faint/80">{hint}</span>}
      </span>
    );
  }
  return <img src={url} alt={`${name} camera`} draggable={false} className="w-full h-full object-cover" />;
}

function DeviceCard({ d, connId, slug, title, subtitle, dense, cams, selecting, selected, onToggleSelect }: {
  d: DigifabFleetDevice; connId: string; slug: string; title?: string; subtitle?: string | null;
  /** Compact tile (farm-wall density). */
  dense?: boolean;
  /** Camera-wall tile: the webcam IS the card (OctoFarm camera view). */
  cams?: boolean;
  /** Batch mode: clicking the card toggles selection instead of opening it. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const st = KLASS_STYLE[d.klass];
  // Progress: a Cobblr job's (0–1) wins; otherwise the printer's own live percent
  // (already 0–100, e.g. a Bambu print started from its own slicer).
  const pct = d.active_job?.progress != null
    ? Math.round(d.active_job.progress * 100)
    : d.live?.progress != null ? Math.round(d.live.progress) : null;
  const invalidateFleet = () => void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] });
  const [camOpen, setCamOpen] = useState(false);
  const [camUrl, setCamUrl] = useState(d.camera_url ?? "");
  const ready = useMutation({
    mutationFn: (outcome: "good" | "scrapped") => api.markDigifabDeviceReady(slug, connId, d.id, outcome),
    onSuccess: (_r, outcome) => {
      toast.success(
        outcome === "scrapped"
          ? `${d.name} cleared — scrapped, filament & usage restored`
          : `${d.name} cleared — ready for the next job`,
      );
      invalidateFleet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const camera = useMutation({
    mutationFn: (url: string | null) => api.setDigifabDeviceCamera(slug, connId, d.id, url),
    onSuccess: () => { setCamOpen(false); toast.success("Camera updated"); invalidateFleet(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const ctrl = useMutation({
    mutationFn: (action: "pause" | "resume") =>
      action === "pause" ? api.pauseDigifabJob(slug, d.active_job!.id) : api.resumeDigifabJob(slug, d.active_job!.id),
    onSuccess: (_r, action) => { toast.success(action === "pause" ? "Paused" : "Resumed"); invalidateFleet(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const confirmStop = useConfirm();
  const stop = useMutation({
    mutationFn: () => api.cancelDigifabJob(slug, d.active_job!.id),
    onSuccess: (r) => {
      toast[r.remote_cancelled ? "success" : "info"](r.remote_cancelled ? "Stopped — told the printer to abort" : "Marked cancelled — stop it at the machine if it's still moving");
      invalidateFleet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const relay = useMutation({
    mutationFn: (enabled: boolean) => api.setDigifabDeviceSnapshotRelay(slug, connId, d.id, enabled),
    onSuccess: (_r, enabled) => { toast.success(enabled ? "Snapshot relay on" : "Snapshot relay off"); invalidateFleet(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // FDMM-signature interaction: drag a Library file onto the tile → queue + send
  // it to THIS printer (confirm-gated; a drop must never silently start a print).
  const [dropHover, setDropHover] = useState(false);
  const confirmDrop = useConfirm();
  const dropSend = useMutation({
    mutationFn: async (item: { name: string; file_id: string }) => {
      const job = await api.createDigifabJob(slug, { connection_id: connId, target_device: d.id, file_ref: item.name, file_id: item.file_id });
      return api.sendDigifabJob(slug, job.id);
    },
    onSuccess: () => { toast.success(`Sent to ${d.name} — printing`); invalidateFleet(); void qc.invalidateQueries({ queryKey: ["digifab-jobs", slug] }); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropHover(false);
    const raw = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
    if (!raw) return;
    let item: { name: string; file_id: string };
    try { item = JSON.parse(raw); } catch { return; }
    if (await confirmDrop({ title: `Print "${item.name}" on ${d.name}?`, message: "Uploads the file and starts the print on this machine now.", confirmLabel: "Print here", destructive: true })) {
      dropSend.mutate(item);
    }
  };

  // EXPERIMENTAL cloud control: publish a command to a Bambu over the pump's MQTT
  // (same broker the app uses). The printer may reject it (Authorization Control)
  // — so we lead with the harmless visible ones (light / nudge) to confirm it works.
  const [detailOpen, setDetailOpen] = useState(false);
  const att = d.needs_attention;
  const nozzle = tempLabel(d.temps?.nozzle);
  const bed = tempLabel(d.temps?.bed);
  const chamber = tempLabel(d.temps?.chamber);
  const job = d.active_job;
  // ETA: "~done 3:42 PM" from the driver-reported seconds remaining (Cobblr job)
  // or the printer's own remaining minutes (external print).
  const etaMin = job?.eta_sec != null ? Math.round(job.eta_sec / 60) : d.live?.remaining_min ?? null;
  const doneBy = etaMin != null && etaMin > 0 ? new Date(Date.now() + etaMin * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  // Blocking reason — say WHY a machine isn't doing anything (SimplyPrint's
  // strongest pattern). Attention has its own richer banner below.
  const blocked = !d.enabled ? "disabled — not taking jobs" : d.klass === "offline" ? "offline — check the machine" : d.klass === "error" && !att ? "error — see the manager" : null;
  // WHY this machine is in the "Needs you" bucket — always named on the tile,
  // never a bare amber ring. The deviceBucket() rule is: needs_attention (the
  // Cobblr bed-clear gate), OR klass "error", OR klass "complete". The last one
  // is the silent case the author hit: a print that finished OUTSIDE a Cobblr job (a
  // Bambu started from its own slicer) reads "complete" with no attention row —
  // it still needs the bed cleared, there's just no verdict flow to offer, so
  // it clears itself once the printer reports idle again. (Firmware-update-
  // available is NOT a needs reason — it never enters deviceBucket.)
  const needsReason =
    att?.reason === "print-failed" ? "print failed — check the bed"
    : att ? "print done — clear the bed"
    : d.klass === "complete" ? "print finished — clear the bed"
    : d.klass === "error" ? "error — see the manager"
    : null;
  const needsShort =
    att?.reason === "print-failed" ? "failed"
    : (att || d.klass === "complete") ? "clear bed"
    : d.klass === "error" ? "error"
    : null;
  const dragProps = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(LIBRARY_DRAG_MIME)) { e.preventDefault(); setDropHover(true); } },
    onDragLeave: () => setDropHover(false),
    onDrop: (e: React.DragEvent) => void onDrop(e),
  };
  const rootCls = `relative rounded-lg border overflow-hidden ${dropHover ? "border-cobble-500 ring-2 ring-cobble-500/40" : att ? "border-amber-400 dark:border-amber-700" : st.ring} bg-subtle dark:bg-slate-800/50 ${d.enabled ? "" : "opacity-50"} ${selecting ? "cursor-pointer" : ""} ${selected ? "ring-2 ring-cobble-500" : ""}`;

  // Camera-wall tile — the feed is the card; status + progress ride as an
  // overlay strip. Streams/snapshots regardless of state (that's the point of
  // switching to this view). Clicking opens the cockpit.
  if (cams) {
    return (
      <div className={rootCls} {...dragProps} onClick={selecting ? onToggleSelect : undefined}>
        <div className={`h-1 ${att ? "bg-amber-500" : st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
        <button type="button" onClick={selecting ? undefined : () => setDetailOpen(true)} className="block w-full text-left">
          <div className="relative aspect-video bg-black/40 flex items-center justify-center overflow-hidden">
            {d.snapshot_relay ? (
              <RelaySnapshotFill slug={slug} connId={connId} deviceId={d.id} name={d.name} live={d.klass === "printing" || d.klass === "paused"} />
            ) : d.lan_camera ? (
              <LanCameraFill slug={slug} connId={connId} deviceId={d.id} name={d.name} live={d.klass === "printing" || d.klass === "paused"} klass={d.klass} />
            ) : d.camera_url ? (
              <img src={d.camera_url} alt={`${d.name} camera`} draggable={false} className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            ) : d.linked_machine?.image_path ? (
              <MachinePhotoFill src={d.linked_machine.image_path} alt={`${title ?? d.name} photo`} />
            ) : (
              <span className="flex flex-col items-center gap-1 text-faint text-[11px]"><Camera size={18} /> no camera</span>
            )}
            {/* The AI verdict, on the image it judges — the camera wall is where
                "is that print turning into spaghetti?" gets asked. */}
            {!d.managed_by_detector && d.failure?.paused ? (
              <span className="absolute top-1.5 left-1.5 z-10 inline-flex items-center gap-1 rounded-full bg-ember-600/90 text-white px-1.5 py-0.5 text-[10px] font-medium shadow">
                ⚠ paused by AI
              </span>
            ) : !d.managed_by_detector && d.failure?.watching ? (
              <span
                className={`absolute top-1.5 left-1.5 z-10 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium shadow ${
                  d.failure.score >= 0.6
                    ? "bg-ember-600/90 text-white"
                    : d.failure.score >= 0.3
                      ? "bg-amber-500/90 text-slate-900"
                      : "bg-emerald-600/85 text-white"
                }`}
                title={`AI failure watch — rolling score ${d.failure.score.toFixed(2)}`}
              >
                <ShieldCheck size={10} /> {Math.round(d.failure.score * 100)}%
              </span>
            ) : null}
          </div>
          <div className="px-2 py-1.5 flex items-center gap-2">
            {selecting && <input type="checkbox" checked={!!selected} readOnly className="shrink-0" />}
            <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
            <span className="text-xs font-medium text-content dark:text-mortar-100 truncate">{title ?? d.name}</span>
            <span className="flex-1" />
            {pct != null && <span className="text-[10px] font-mono text-faint shrink-0">{pct}%{doneBy ? ` · ~${doneBy}` : ""}</span>}
            {needsShort && <span className="text-[10px] text-amber-600 shrink-0">{needsShort}</span>}
          </div>
        </button>
        {detailOpen && <PrinterDetailModal slug={slug} connId={connId} device={d} onClose={() => setDetailOpen(false)} />}
      </div>
    );
  }

  // Compact tile — farm-wall density: band, name, progress, ETA. Everything else
  // is one click away in the cockpit.
  if (dense) {
    return (
      <div className={rootCls} {...dragProps} onClick={selecting ? onToggleSelect : undefined}>
        <div className={`h-1 ${att ? "bg-amber-500" : st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
        <div className="p-1.5">
          <div className="flex items-center gap-1">
            {selecting && <input type="checkbox" checked={!!selected} readOnly className="shrink-0" />}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />
            <button type="button" onClick={(e) => { if (selecting) { e.stopPropagation(); onToggleSelect?.(); } else setDetailOpen(true); }} className="text-[11px] font-medium text-content dark:text-mortar-100 truncate hover:text-accent text-left flex-1 min-w-0" title={title ?? d.name}>
              {title ?? d.name}
            </button>
          </div>
          {pct != null ? (
            <>
              <div className="mt-1 h-1 rounded bg-line dark:bg-slate-700 overflow-hidden">
                <div className={`h-full ${job?.status === "paused" ? "bg-amber-500" : "bg-cobble-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[9px] font-mono text-faint mt-0.5 truncate">{pct}%{doneBy ? ` · ~${doneBy}` : ""}</div>
            </>
          ) : (
            <div className={`text-[9px] font-mono uppercase tracking-wider truncate ${st.text}`}>{needsShort ?? blocked ?? d.state}</div>
          )}
        </div>
        {detailOpen && <PrinterDetailModal slug={slug} connId={connId} device={d} onClose={() => setDetailOpen(false)} />}
      </div>
    );
  }

  return (
    <div className={rootCls} {...dragProps} onClick={selecting ? onToggleSelect : undefined}>
      {/* Status band — the farm-floor read: color says state before text does. */}
      <div className={`h-1 ${att ? "bg-amber-500" : st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
      <div className="p-2.5">
      {selecting && (
        <div className="flex items-center gap-1.5 mb-1">
          <input type="checkbox" checked={!!selected} readOnly />
          <span className="text-[10px] text-faint">select</span>
        </div>
      )}
      {/* Cockpit camera. A relayed snapshot shows the last frame frozen and only
          live-refreshes while the printer is working (printing/paused) — no
          constant bandwidth on an idle bed, but the last image stays visible. A
          direct camera_url is a continuous MJPEG stream, so it's only embedded
          while working; otherwise it'd stream 24/7. Either way the live feed is
          one click away in the detail modal (mounts on open). */}
      {d.snapshot_relay ? (
        <RelaySnapshot
          slug={slug}
          connId={connId}
          deviceId={d.id}
          name={d.name}
          live={d.klass === "printing" || d.klass === "paused"}
        />
      ) : (d.klass === "printing" || d.klass === "paused") && d.camera_url ? (
        <img
          src={d.camera_url}
          alt={`${d.name} camera`}
          className="mb-1.5 w-full h-24 object-cover rounded bg-black/30"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot} ${d.klass === "printing" ? "animate-pulse" : ""}`} />
        <button type="button" onClick={(e) => { if (selecting) { e.stopPropagation(); onToggleSelect?.(); } else setDetailOpen(true); }} className="text-sm font-medium text-content dark:text-mortar-100 truncate hover:text-accent text-left" title={`${title ?? d.name} — open details`}>{title ?? d.name}</button>
        <div className="flex-1" />
        <button
          onClick={() => { setCamUrl(d.camera_url ?? ""); setCamOpen((o) => !o); }}
          title={d.camera_url ? "Edit camera URL" : "Add a camera URL"}
          className={`p-0.5 transition ${d.camera_url ? "text-accent" : "text-faint hover:text-accent"}`}
        >
          <Camera size={13} />
        </button>
      </div>
      {subtitle && <div className="text-[10px] text-faint truncate">{subtitle}</div>}
      <div className="flex items-center gap-2 mt-0.5">
        <span className={`text-[10px] font-mono uppercase tracking-wider ${st.text}`}>{d.state}</span>
        {d.stage && (
          <span className="text-[10px] font-medium text-accent truncate" title="current stage">{d.stage}</span>
        )}
        {(nozzle || bed || chamber) && (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-faint" title="nozzle / bed / chamber (actual/target °C)">
            <Thermometer size={10} />
            {nozzle && <span>N {nozzle}</span>}
            {bed && <span>B {bed}</span>}
            {chamber && <span>C {chamber}</span>}
          </span>
        )}
      </div>
      {/* An external detector (e.g. PrintGuard) owns this printer's detection + camera. */}
      {d.managed_by_detector && (
        <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-faint" title="An external detector owns this printer's detection and camera - Cobblr isn't watching it or pulling its camera">
          👁 watched by detector
        </div>
      )}
      {/* AI failure watch: red when it auto-paused, else a GRADED live score —
          visible whenever the watch is live (the old ≥0.2 floor hid the AI on
          every healthy print, so nobody knew it was working). */}
      {!d.managed_by_detector && d.failure?.paused ? (
        <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-ember-600 dark:text-ember-500 font-medium" title="AI flagged a likely print failure and paused it - check the print">
          ⚠ AI: likely failure - paused
        </div>
      ) : !d.managed_by_detector && d.failure?.watching ? (
        <div
          className={`mt-1 inline-flex items-center gap-1 text-[10px] ${
            d.failure.score >= 0.6
              ? "text-ember-600 dark:text-ember-500 font-medium"
              : d.failure.score >= 0.3
                ? "text-amber-600 dark:text-amber-500"
                : "text-emerald-600 dark:text-emerald-500"
          }`}
          title={`AI failure watch is live — rolling score ${d.failure.score.toFixed(2)}; auto-pause trips when it crosses your threshold`}
        >
          <ShieldCheck size={10} /> AI watch · {Math.round(d.failure.score * 100)}%
        </div>
      ) : null}
      {blocked && <div className="mt-1 text-[10px] text-ember-600 dark:text-ember-500">{blocked}</div>}
      {/* A print that finished outside a Cobblr job (no attention row, no verdict
          flow) still owes you a bed-clear — name it so the amber tile isn't
          silent. The richer att banner below owns the Cobblr-tracked case. */}
      {!att && !blocked && d.klass === "complete" && (
        <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-500">{needsReason}</div>
      )}
      {/* Next up — what this machine will do next (queued to it or its pool). */}
      {d.next_job && !att && (
        <div className="mt-1 text-[10px] text-faint truncate" title={d.next_job.file_ref}>
          ⏭ next: <span className="text-muted dark:text-slate-400">{d.next_job.file_ref}</span>{d.next_job.pooled ? " · pool" : ""}
        </div>
      )}
      {camOpen && (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            value={camUrl}
            onChange={(e) => setCamUrl(e.target.value)}
            placeholder="http://…/webcam/?action=stream"
            className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
          <button onClick={() => camera.mutate(camUrl.trim() || null)} disabled={camera.isPending} className="text-[11px] rounded bg-cobble-600 hover:bg-cobble-700 text-white px-1.5 py-0.5 disabled:opacity-50">Save</button>
          {d.camera_url && <button onClick={() => camera.mutate(null)} disabled={camera.isPending} title="Remove" className="text-faint hover:text-ember-500 p-0.5"><X size={12} /></button>}
        </div>
      )}
      {camOpen && (
        // Snapshot relay (opt-in, OFF by default): pushes frames up so the feed
        // works for a REMOTE viewer (not on the printer's LAN). Costs bandwidth.
        <label className="mt-1 flex items-center gap-1.5 text-[10px] text-faint cursor-pointer">
          <input type="checkbox" checked={d.snapshot_relay} disabled={relay.isPending} onChange={(e) => relay.mutate(e.target.checked)} />
          Relay snapshots to cloud (for remote viewing){d.snapshot_relay && !d.snapshot_fresh ? " — waiting for the agent…" : ""}
        </label>
      )}
      {att && (
        // F-1: bed-clear gate. The printer finished/failed a print and won't take
        // new work until a human confirms the bed is clear.
        <div className="mt-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-1">
          <div className="text-[10px] text-amber-700 dark:text-amber-400 leading-tight">
            {att.reason === "print-failed" ? "Print failed — check the bed" : "Print done — clear the bed. Come out good?"}
          </div>
          {att.reason === "print-failed" ? (
            <button
              onClick={() => ready.mutate("good")}
              disabled={ready.isPending}
              className="mt-1 w-full text-[11px] rounded bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white py-0.5"
            >
              {ready.isPending ? "…" : "Cleared — ready"}
            </button>
          ) : (
            // F-13: the verdict. "Good" closes the linked task; "Scrapped" puts
            // the filament + machine usage back. Both clear the bed.
            <div className="mt-1 flex gap-1">
              <button
                onClick={() => ready.mutate("good")}
                disabled={ready.isPending}
                className="flex-1 text-[11px] rounded bg-moss-600 hover:bg-moss-700 disabled:opacity-50 text-white py-0.5"
              >
                Came out good
              </button>
              <button
                onClick={() => ready.mutate("scrapped")}
                disabled={ready.isPending}
                className="flex-1 text-[11px] rounded border border-amber-400 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-800 dark:text-amber-300 py-0.5"
              >
                Scrapped
              </button>
            </div>
          )}
        </div>
      )}
      {job && (
        <div className="mt-1.5">
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0 text-[11px] text-muted dark:text-slate-400 truncate" title={job.file_ref}>
              {job.file_ref}
            </div>
            {job.priority > 0 && (
              <span className={"text-[9px] font-mono uppercase px-1 rounded shrink-0 " + (job.priority >= 20 ? "bg-ember-500/15 text-ember-600" : "bg-amber-500/15 text-amber-600")}>
                {job.priority >= 20 ? "urgent" : "high"}
              </span>
            )}
            {job.max_attempts > 1 && (
              <span className="text-[9px] text-faint shrink-0" title={`auto-retry on fail (${job.attempts}/${job.max_attempts - 1} used)`}>↻{job.attempts}/{job.max_attempts - 1}</span>
            )}
            {/* Cockpit live-control: pause / resume the running print. */}
            {job.status === "printing" && (
              <button onClick={() => ctrl.mutate("pause")} disabled={ctrl.isPending} title="Pause print" className="text-faint hover:text-accent transition p-0.5 disabled:opacity-50">
                <Pause size={13} />
              </button>
            )}
            {job.status === "paused" && (
              <button onClick={() => ctrl.mutate("resume")} disabled={ctrl.isPending} title="Resume print" className="text-amber-600 hover:text-amber-700 transition p-0.5 disabled:opacity-50">
                <Play size={13} />
              </button>
            )}
            {(job.status === "printing" || job.status === "paused" || job.status === "sent") && (
              <button
                onClick={async () => {
                  if (await confirmStop({ title: `Stop the print on ${d.name}?`, message: "Cancels the job. Where the manager supports it the printer aborts; otherwise stop it at the machine.", confirmLabel: "Stop print", destructive: true })) stop.mutate();
                }}
                disabled={stop.isPending}
                title="Stop print"
                className="text-faint hover:text-ember-500 transition p-0.5 disabled:opacity-50"
              >
                <Ban size={13} />
              </button>
            )}
          </div>
          {job.status === "paused" && <div className="text-[10px] font-mono uppercase tracking-wider text-amber-600 mt-0.5">paused</div>}
          {pct != null && (
            <>
              <div className="mt-1 h-1 rounded bg-line dark:bg-slate-700 overflow-hidden">
                <div className={`h-full transition-[width] ${job.status === "paused" ? "bg-amber-500" : "bg-cobble-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[10px] font-mono text-faint mt-0.5 flex gap-2">
                <span>{pct}%</span>
                {etaMin != null && etaMin > 0 && <span>{fmtRemaining(etaMin)} left</span>}
                {doneBy && <span>~done {doneBy}</span>}
              </div>
            </>
          )}
        </div>
      )}
      {/* A print Cobblr didn't start (e.g. straight from Bambu Studio) — show the
          printer's own live progress so the floor view isn't blank for it. */}
      {!job && pct != null && d.live && (
        <div className="mt-1.5">
          <div className="h-1 rounded bg-line dark:bg-slate-700 overflow-hidden">
            <div className="h-full transition-[width] bg-cobble-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[10px] font-mono text-faint mt-0.5 flex gap-2">
            <span>{pct}%</span>
            {d.live.layer_num != null && d.live.total_layers != null && <span>layer {d.live.layer_num}/{d.live.total_layers}</span>}
            {d.live.remaining_min != null && d.live.remaining_min > 0 && <span>{fmtRemaining(d.live.remaining_min)} left</span>}
          </div>
        </div>
      )}
      {/* Open the full printer modal — identity, live telemetry, controls,
          link-to-machine, and this printer's history, all in one place. */}
      <div className="mt-1.5 pt-1.5 border-t border-line dark:border-slate-700/60">
        <button type="button" onClick={() => setDetailOpen(true)} className="text-[10px] text-accent hover:underline flex items-center gap-1">
          <Sliders size={11} /> Details &amp; controls
        </button>
      </div>
      </div>
      {detailOpen && <PrinterDetailModal slug={slug} connId={connId} device={d} onClose={() => setDetailOpen(false)} />}
    </div>
  );
}

// Generic control panel — fetches the controls the driver DECLARES for this
// device and renders by kind (action buttons, a light toggle, a jog pad, number
// inputs), grouped. Only declared controls appear, so a printer shows exactly
// what it can do. Works across managers (Bambu cloud/LAN, Moonraker, OctoPrint,
// Duet, edge-bridge) — each declares its own set.
// A proper directional jog pad — an X/Y cross with Home in the middle and a
// separate Z column — instead of a flat row of X+/X−/Y+/Y− buttons. Renders only
// the axes the driver actually reports.
function JogPad({
  axes,
  step,
  steps,
  onStep,
  onJog,
  onHome,
  disabled,
}: {
  axes: string[];
  step: number;
  steps: number[];
  onStep: (s: number) => void;
  onJog: (axis: string, dist: number) => void;
  onHome?: () => void;
  disabled?: boolean;
}) {
  const has = (a: string) => axes.includes(a);
  const pad =
    "flex items-center justify-center rounded-md border border-line dark:border-slate-600 hover:border-accent hover:text-accent text-content dark:text-mortar-200 transition disabled:opacity-30 disabled:hover:border-line disabled:hover:text-content h-9 w-9 text-sm font-medium select-none";
  const cell = "flex items-center justify-center h-9 w-9";
  const btn = (label: string, axis: string, dist: number) => (
    <button type="button" disabled={disabled || !has(axis)} onClick={() => onJog(axis, dist)} className={pad} title={`${axis.toUpperCase()} ${dist > 0 ? "+" : "−"}${Math.abs(dist)}mm`}>
      {label}
    </button>
  );
  return (
    <div className="flex items-start gap-4">
      {/* X / Y cross */}
      <div className="grid grid-cols-3 grid-rows-3 gap-1">
        <div className={cell} />
        <div className={cell}>{btn("Y+", "y", step)}</div>
        <div className={cell} />
        <div className={cell}>{btn("X−", "x", -step)}</div>
        <div className={cell}>
          {onHome ? (
            <button type="button" disabled={disabled} onClick={onHome} className={pad} title="Home all axes">⌂</button>
          ) : (
            <span className="text-[9px] font-mono uppercase text-faint">X/Y</span>
          )}
        </div>
        <div className={cell}>{btn("X+", "x", step)}</div>
        <div className={cell} />
        <div className={cell}>{btn("Y−", "y", -step)}</div>
        <div className={cell} />
      </div>
      {/* Z column */}
      {has("z") && (
        <div className="flex flex-col items-center gap-1">
          {btn("Z+", "z", step)}
          <span className="text-[9px] font-mono uppercase text-faint">Z</span>
          {btn("Z−", "z", -step)}
        </div>
      )}
      {/* Step selector */}
      <div className="flex flex-col gap-1">
        <span className="text-[9px] font-mono uppercase text-faint">Step</span>
        {steps.map((sMm) => (
          <button
            key={sMm}
            type="button"
            onClick={() => onStep(sMm)}
            className={
              "px-2 py-1 rounded text-xs border transition " +
              (step === sMm ? "bg-cobble-600 text-white border-cobble-600" : "border-line dark:border-slate-600 text-muted hover:border-accent")
            }
          >
            {sMm}mm
          </button>
        ))}
      </div>
    </div>
  );
}

function ControlsPanel({ slug, connId, deviceId, name, telemetry, lanActive }: { slug: string; connId: string; deviceId: string; name: string; telemetry?: DigifabDeviceDetail["telemetry"] | null; lanActive?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [jogStep, setJogStep] = useState(10);
  const [nums, setNums] = useState<Record<string, string>>({});
  // Map a temperature control to its live actual/target so the input reflects
  // reality (pre-filled to the current target — so it "persists" across reopen)
  // and shows actual → target next to it.
  const tempFor = (id: string): { actual: number | null; target: number | null } | null => {
    if (!telemetry) return null;
    if (id === "nozzle_temp") return { actual: telemetry.nozzle, target: telemetry.nozzle_target };
    if (id === "bed_temp") return { actual: telemetry.bed, target: telemetry.bed_target };
    return null;
  };
  const ctrls = useQuery({ queryKey: ["digifab-controls", slug, connId, deviceId], queryFn: () => api.getDigifabControls(slug, connId, deviceId) });
  const run = useMutation({
    mutationFn: ({ id, params }: { id: string; params?: Record<string, unknown> }) => api.runDigifabControl(slug, connId, deviceId, id, params),
    onSuccess: () => toast.success("Sent - watch the printer"),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't send"),
  });
  const controls = ctrls.data?.controls ?? [];
  const doRun = async (c: typeof controls[number], params?: Record<string, unknown>) => {
    if (c.destructive && !(await confirm({ title: `${c.label} — ${name}?`, message: "This affects the running print.", confirmLabel: c.label, destructive: true }))) return;
    run.mutate({ id: c.id, params });
  };
  const groups: { key: string; label: string }[] = [
    { key: "print", label: "Print" }, { key: "motion", label: "Motion" }, { key: "temperature", label: "Temperature" }, { key: "accessory", label: "Accessory" },
  ];
  const btn = "text-xs px-2 py-1 rounded border border-line dark:border-slate-600 hover:border-accent disabled:opacity-50";
  return (
    <>
      {ctrls.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : controls.length === 0 ? (
        <div className="text-sm text-muted dark:text-slate-400 italic">This printer reports no live controls.</div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const cs = controls.filter((c) => (c.group ?? "accessory") === g.key);
            if (cs.length === 0) return null;
            const jog = cs.find((c) => c.kind === "jog");
            const homeAction = g.key === "motion" ? cs.find((c) => c.kind === "action") : undefined;
            return (
              <div key={g.key}>
                <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1.5">{g.label}</div>
                {/* Motion renders as a directional jog pad; Home rides inside it. */}
                {g.key === "motion" && jog ? (
                  <JogPad
                    axes={jog.axes ?? ["z"]}
                    step={jogStep}
                    steps={jog.steps ?? [1, 10, 100]}
                    onStep={setJogStep}
                    onJog={(axis, dist) => doRun(jog, { axis, dist })}
                    onHome={homeAction ? () => doRun(homeAction) : undefined}
                    disabled={run.isPending}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {cs.map((c) =>
                      c.kind === "action" ? (
                        <button key={c.id} type="button" onClick={() => doRun(c)} disabled={run.isPending} className={c.destructive ? "text-xs px-2.5 py-1.5 rounded border border-ember-400 text-ember-600 hover:bg-ember-50 dark:hover:bg-ember-950/30 disabled:opacity-50" : btn}>{c.label}</button>
                      ) : c.kind === "toggle" ? (
                        <span key={c.id} className="inline-flex items-center gap-1 text-xs">
                          <span className="text-muted dark:text-slate-400">{c.label}</span>
                          <button type="button" onClick={() => doRun(c, { on: true })} disabled={run.isPending} className={btn}>on</button>
                          <button type="button" onClick={() => doRun(c, { on: false })} disabled={run.isPending} className={btn}>off</button>
                        </span>
                      ) : c.kind === "jog" ? null : (
                        (() => {
                          const tm = tempFor(c.id);
                          return (
                            <div key={c.id} className="flex items-center gap-1.5">
                              <span className="text-xs text-muted dark:text-slate-400">{c.label}</span>
                              {tm && (
                                <span className="text-[11px] font-mono text-faint">
                                  {tm.actual != null ? `${Math.round(tm.actual)}°` : "—"} live · {tm.target ? `${Math.round(tm.target)}°` : "off"} set
                                </span>
                              )}
                              <input
                                value={nums[c.id] ?? (tm && tm.target != null ? String(Math.round(tm.target)) : "")}
                                onChange={(e) => setNums((nv) => ({ ...nv, [c.id]: e.target.value }))}
                                placeholder={c.unit}
                                className="input !py-0.5 !text-xs !w-16"
                              />
                              <button type="button" onClick={() => doRun(c, { value: Number(nums[c.id] ?? (tm?.target ?? 0)) || 0 })} disabled={run.isPending} className={btn}>Set</button>
                            </div>
                          );
                        })()
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[10px] text-faint">{lanActive ? "Commands route over your LAN bridge." : "Some printers reject third-party commands (e.g. Bambu Authorization Control). If nothing happens, that printer needs LAN control."}</p>
        </div>
      )}
    </>
  );
}

// Printer file timestamp (rr_filelist `date`, the machine's local time, no TZ) →
// a compact "26 Feb 2023" plus a relative hint for recent files.
export function fmtFileDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 0) return date;
  if (days === 0) return `Today · ${date}`;
  if (days === 1) return `Yesterday · ${date}`;
  if (days < 30) return `${days}d ago · ${date}`;
  return date;
}

// Seconds → "2h 5m" / "45m". Shared by the job panel + per-file estimates.
export function fmtDuration(s?: number): string | null {
  if (s == null || !Number.isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Live print progress (Duet & any bridge that reports job): a bar + layer / time.
function JobPanel({ job }: { job: { fractionPrinted?: number; currentLayer?: number; timeLeftSec?: number; durationSec?: number } }) {
  const pct = job.fractionPrinted != null ? Math.round(job.fractionPrinted * 100) : null;
  return (
    <div className="space-y-1.5">
      {pct != null && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 rounded-full bg-subtle dark:bg-slate-800 overflow-hidden">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-mono text-content dark:text-mortar-100 shrink-0">{pct}%</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-faint">
        {job.currentLayer != null && <span>Layer {job.currentLayer}</span>}
        {fmtDuration(job.timeLeftSec) && <span>{fmtDuration(job.timeLeftSec)} left</span>}
        {fmtDuration(job.durationSec) && <span>{fmtDuration(job.durationSec)} elapsed</span>}
      </div>
    </div>
  );
}

// One file row. The slicer preview + estimate (fileInfo) load LAZILY — only once
// the row scrolls into view (IntersectionObserver) — and are hard-cached (30 min,
// immutable per file) both here and server-side, so the bridge is hit at most once
// per file the user actually looks at. NEVER eager-fetches the whole list.
/** Where a row's knowledge comes from: SD = the file is on the printer's card
 *  (printable right now); CLOUD = the cloud print-history knows it (name,
 *  picture, outcome). A matched row carries both. */
function SourceChip({ kind }: { kind: "sd" | "cloud" }) {
  return (
    <span
      className={
        "inline-flex items-center text-[9px] font-mono uppercase tracking-wider px-1 py-px rounded border " +
        (kind === "sd"
          ? "text-faint border-line dark:border-slate-700"
          : "text-accent border-accent/40 bg-accent/5")
      }
      title={kind === "sd" ? "On the printer's SD card — printable now" : "Known to the cloud print history — name, picture & outcome come from there"}
    >
      {kind === "sd" ? "SD" : "Cloud"}
    </span>
  );
}

function FileRow({
  slug, connId, deviceId, file, printing, onPrint, onZoom, fmtSize, printed,
}: {
  slug: string; connId: string; deviceId: string;
  file: { name: string; size?: number; modified?: string };
  printing: string | null;
  onPrint: (name: string) => void;
  onZoom?: (src: string) => void;
  fmtSize: (b?: number) => string;
  /** The matched recent print — the row borrows its intelligence: the pleasant
   *  model name becomes the title (raw filename drops to the subtitle) and the
   *  cloud cover fills the thumbnail until the slicer preview is cached. */
  printed?: { at: string; status: string; title?: string | null; cover?: string | null } | null;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } },
      { root: el.closest("ul"), rootMargin: "150px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  const fq = useQuery({
    queryKey: ["digifab-fileinfo", slug, connId, deviceId, file.name],
    queryFn: () => api.getDigifabFileInfo(slug, connId, deviceId, file.name),
    enabled: visible,
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000, // keep the (heavy) thumbnail in memory across reopens — no re-fetch
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const fi: DigifabFileInfo | null = fq.data?.info ?? null;
  // Slicer preview (the actual plate) wins; the cloud cover (the model render)
  // fills in instantly while it loads — or permanently when the file has none.
  const thumb = fi?.thumbnail ?? printed?.cover ?? undefined;
  // A matched print lends its pleasant model name; the raw filename stays
  // visible underneath so "which file on the card is this" never gets lost.
  const niceTitle = printed?.title && normPrintName(printed.title) !== normPrintName(file.name) ? printed.title : null;
  return (
    <li ref={ref} className="px-2 py-1 text-xs">
      <div className="flex items-center gap-2">
        <div className="w-10 h-10 shrink-0 rounded border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 overflow-hidden flex items-center justify-center">
          {thumb ? (
            <img src={thumb} alt="" loading="lazy" className="w-full h-full object-contain cursor-zoom-in" onClick={() => onZoom?.(thumb)} />
          ) : (
            <span className="text-faint text-[9px]">{visible && fq.isFetching ? "…" : ""}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <button type="button" onClick={() => setExpanded((v) => !v)} className="block w-full truncate text-left text-content dark:text-mortar-100 hover:text-accent" title="Show print estimate">
            {niceTitle ?? file.name}
          </button>
          {(niceTitle || file.modified) && (
            <div className="text-faint text-[10px] truncate">
              {niceTitle ? file.name : ""}
              {niceTitle && file.modified ? " · " : ""}
              {file.modified ? fmtFileDate(file.modified) : ""}
            </div>
          )}
        </div>
        {/* Provenance: every row here is a card file (SD); a matched one is
            ALSO known to the cloud history (CLOUD) — both chips show. */}
        <span className="shrink-0 inline-flex items-center gap-1">
          <SourceChip kind="sd" />
          {printed && <SourceChip kind="cloud" />}
        </span>
        {printed && (
          <span
            className={"shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded " + (printed.status === "completed" ? "text-moss-600 bg-moss-500/10" : "text-ember-600 bg-ember-500/10")}
            title={`Last printed ${new Date(printed.at).toLocaleString()} — ${printed.status}`}
          >
            {printed.status === "completed" ? "✓" : "✗"} {new Date(printed.at).toLocaleDateString()}
          </span>
        )}
        {file.size != null && <span className="text-faint font-mono shrink-0">{fmtSize(file.size)}</span>}
        <button type="button" onClick={() => onPrint(file.name)} disabled={printing === file.name} className="shrink-0 text-accent hover:underline disabled:opacity-50">
          {printing === file.name ? "Sending…" : "Print"}
        </button>
      </div>
      {expanded && (
        <div className="mt-1 pl-12 text-[11px] text-faint">
          {fq.isLoading ? (
            "Reading slicer info…"
          ) : !fi ? (
            "No slicer estimate in this file."
          ) : (
            <span className="flex flex-wrap gap-x-3 gap-y-0.5">
              {fmtDuration(fi.printTimeSec) && <span>⏱ {fmtDuration(fi.printTimeSec)}</span>}
              {fi.filamentMm != null && <span>🧵 {(fi.filamentMm / 1000).toFixed(1)} m</span>}
              {fi.numLayers != null && <span>{fi.numLayers} layers</span>}
              {fi.height != null && <span>{fi.height} mm tall</span>}
              {fi.generatedBy && <span className="opacity-70">· {fi.generatedBy.split(/\s+/)[0]}</span>}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

// The gcode files already on the printer's storage. CACHED — the list is fetched
// once (5-min cache) and NEVER polled; each row's preview + estimate load lazily
// on scroll (see FileRow). The Refresh button forces a live re-read of the list.
/** Normalize a file/print name for matching: basename, extensions off, spaces
 *  collapsed, lowercase. "cache/Split .3mf" ↔ "Split" both → "split". */
function normPrintName(n: string): string {
  return n
    .replace(/^.*[\\/]/, "")
    .replace(/\.(gcode\.3mf|gcode|3mf|bgcode|stl|step)$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function FilesPanel({ slug, connId, deviceId, onZoom, history, onOpenPrint, onReprint }: {
  slug: string; connId: string; deviceId: string; onZoom?: (src: string) => void;
  /** Recent prints on THIS device — rolled into the same surface: matching SD
   *  files get a printed-on chip; prints with no SD file left get a tail row. */
  history?: DigifabHistory["recent"];
  onOpenPrint?: (r: DigifabHistory["recent"][number]) => void;
  onReprint?: (r: DigifabHistory["recent"][number]) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [refreshing, setRefreshing] = useState(false);
  const [printing, setPrinting] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["digifab-files", slug, connId, deviceId],
    queryFn: () => api.getDigifabFiles(slug, connId, deviceId),
    staleTime: 15 * 60_000,
    gcTime: 15 * 60_000, // keep across modal close/reopen → no refetch within the window
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const files = q.data?.files ?? [];
  const [sort, setSort] = useState<"recent" | "oldest" | "name" | "size">("recent");
  const sorted = useMemo(() => {
    const t = (m?: string) => (m ? new Date(m).getTime() || 0 : 0);
    return [...files].sort((a, b) => {
      switch (sort) {
        case "name": return a.name.localeCompare(b.name, undefined, { numeric: true });
        case "size": return (b.size ?? 0) - (a.size ?? 0);
        case "oldest": return t(a.modified) - t(b.modified);
        default: return t(b.modified) - t(a.modified); // recent
      }
    });
  }, [files, sort]);
  const doPrint = async (name: string) => {
    if (!(await confirm({ title: `Print "${name}"?`, message: "This starts the print on the printer now.", confirmLabel: "Print" }))) return;
    setPrinting(name);
    try {
      await api.printDigifabFile(slug, connId, deviceId, name);
      toast.success(`Sent "${name}" — the print is starting.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't start the print");
    } finally {
      setPrinting(null);
    }
  };
  const fmtSize = (b?: number) =>
    b == null ? "" : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`;
  // Join history ↔ SD files by normalized name (containment either way, guarded
  // by length so "a" can't match everything). A matched print LENDS the row its
  // intelligence — the pleasant model name + the cloud cover image — while the
  // raw filename stays as the subtitle; unmatched prints become the "no longer
  // on the card" tail below.
  const hist = history ?? [];
  const { printedFor, unmatched } = useMemo(() => {
    const printedFor = new Map<string, { at: string; status: string; title: string | null; cover: string | null }>();
    const used = new Set<string>();
    for (const f of files) {
      const nf = normPrintName(f.name);
      if (nf.length < 4) continue;
      const m = hist.find((h) => {
        if (used.has(h.id)) return false;
        const nh = normPrintName(h.sub_label || h.file_ref);
        const nh2 = normPrintName(h.file_ref);
        const hit = (x: string) => x.length >= 4 && (nf.includes(x) || x.includes(nf));
        return hit(nh) || hit(nh2);
      });
      if (m) {
        printedFor.set(f.name, { at: m.at, status: m.status, title: m.file_ref || null, cover: m.cover ?? null });
        used.add(m.id);
      }
    }
    return { printedFor, unmatched: hist.filter((h) => !used.has(h.id)) };
  }, [files, hist]);
  // Enriched entries (a matched print = a name + usually a picture) read as the
  // real list; the anonymous cache files sit below them. Sort applies within
  // each group.
  const grouped = useMemo(() => {
    const matched = sorted.filter((f) => printedFor.has(f.name));
    const rest = sorted.filter((f) => !printedFor.has(f.name));
    return [...matched, ...rest];
  }, [sorted, printedFor]);
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(["digifab-files", slug, connId, deviceId], await api.getDigifabFiles(slug, connId, deviceId, true));
    } catch {
      /* keep the existing list on a failed refresh */
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-muted dark:text-slate-400">
          {q.isLoading ? "Loading…" : `${files.length} file${files.length === 1 ? "" : "s"}`}
          {q.data?.cached ? " · cached" : ""}
        </span>
        <button type="button" onClick={refresh} disabled={refreshing || q.isLoading} className="text-accent hover:underline disabled:opacity-50">
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {files.length > 1 && (
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="ml-auto bg-transparent text-muted dark:text-slate-400 border border-line dark:border-slate-700 rounded px-1 py-0.5 text-[11px]"
            title="Sort files"
          >
            <option value="recent">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
            <option value="size">Largest first</option>
          </select>
        )}
      </div>
      {!q.isLoading && files.length === 0 ? (
        <div className="text-xs text-muted dark:text-slate-400 italic">No files reported (this printer may not list them).</div>
      ) : (
        <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded max-h-72 overflow-y-auto">
          {grouped.map((f) => (
            <FileRow key={f.name} slug={slug} connId={connId} deviceId={deviceId} file={f} printing={printing} onPrint={doPrint} onZoom={onZoom} fmtSize={fmtSize} printed={printedFor.get(f.name)} />
          ))}
        </ul>
      )}
      {unmatched.length > 0 && (
        <>
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint pt-1">
            Printed before - file no longer on the printer
          </div>
          <ul className="divide-y divide-line dark:divide-slate-800 border border-line dark:border-slate-700 rounded max-h-48 overflow-y-auto">
            {unmatched.map((r) => (
              <li key={r.id} className="px-2 py-1 text-xs flex items-center gap-2">
                {r.cover ? (
                  <img src={r.cover} alt="" loading="lazy" className="w-10 h-10 rounded object-cover bg-subtle shrink-0 border border-line dark:border-slate-700" />
                ) : (
                  <span className={"w-10 h-10 rounded shrink-0 flex items-center justify-center border border-line dark:border-slate-700 " + (r.status === "completed" ? "bg-moss-500/10" : "bg-ember-500/10")}>
                    <span className={"w-1.5 h-1.5 rounded-full " + (r.status === "completed" ? "bg-moss-500" : "bg-ember-500")} />
                  </span>
                )}
                <button type="button" onClick={() => onOpenPrint?.(r)} className="flex-1 min-w-0 text-left hover:text-accent">
                  <span className="block truncate text-content dark:text-mortar-100">{r.file_ref}</span>
                  <span className="block truncate text-faint text-[10px]">{r.sub_label && r.sub_label !== r.file_ref ? r.sub_label + " · " : ""}{new Date(r.at).toLocaleDateString()}</span>
                </button>
                <SourceChip kind="cloud" />
                {onReprint && isReprintable(r) && (
                  <button type="button" onClick={() => onReprint(r)} className="shrink-0 text-accent hover:underline">
                    Print again
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// A full-screen image viewer — click anywhere to close. Portals to body so the
// header's backdrop-blur can't trap it.
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useOverlayOpenFlag(); // full-screen: floating chrome must yield (lint:overlay-flag)
  return createPortal(
    <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-6 cursor-zoom-out" onClick={onClose}>
      <img src={src} alt="" className="max-w-full max-h-full object-contain rounded shadow-2xl" />
    </div>,
    document.body,
  );
}

// Live LAN camera — the Bambu chamber camera, grabbed frame-by-frame over the
// bridge (one JPEG every ~3s; a refreshing still, not a stream).
function LanCameraView({ slug, connId, deviceId, name, onZoom }: { slug: string; connId: string; deviceId: string; name: string; onZoom?: (src: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let current: string | null = null;
    // Instant: show the last cached frame (server-cached on the previous grab) so
    // there's no "connecting" gap on open; the live poll below replaces it the
    // moment a fresh frame decodes.
    void fetchAuthBlobUrl(api.digifabSnapshotPath(slug, connId, deviceId)).then((cached) => {
      if (!alive) { if (cached) URL.revokeObjectURL(cached); return; }
      if (cached && !current) { setUrl(cached); current = cached; }
      else if (cached) URL.revokeObjectURL(cached);
    });
    const tick = async () => {
      const next = await fetchAuthBlobUrl(api.digifabCameraPath(slug, connId, deviceId));
      if (!alive) { if (next) URL.revokeObjectURL(next); return; }
      if (!next) { if (!current) setFailed(true); return; }
      // Double-buffer: decode the new frame OFF-SCREEN, then swap. Swapping the
      // <img> src directly let it flash empty between frames — the refresh
      // flicker. We only show the new blob once it's fully decoded.
      const probe = new Image();
      probe.onload = () => {
        if (!alive) { URL.revokeObjectURL(next); return; }
        setUrl(next); setFailed(false);
        if (current) URL.revokeObjectURL(current);
        current = next;
      };
      probe.onerror = () => { URL.revokeObjectURL(next); if (!current) setFailed(true); };
      probe.src = next;
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); if (current) URL.revokeObjectURL(current); };
  }, [slug, connId, deviceId]);
  if (failed && !url) return <div className="text-[11px] text-faint italic">Camera not reachable over LAN yet (bridge online + LAN access on the printer?).</div>;
  if (!url) return <div className="text-[11px] text-faint">Connecting to the camera…</div>;
  return <img src={url} alt={`${name} camera`} className="w-full max-h-72 object-contain rounded bg-black/30 cursor-zoom-in" onClick={() => onZoom?.(url)} />;
}

// Per-printer Bambu LAN access (hybrid). Cloud keeps doing telemetry; enabling
// LAN here routes file-push + control through your on-site bridge. Bambu-only.
function LanAccessPanel({ slug, connId, deviceId, lan }: { slug: string; connId: string; deviceId: string; lan?: { applicable: boolean; configured: boolean; host?: string; mode?: "cloud" | "prefer_lan" | "lan_only" } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  // The corner shows a tiny affordance; the actual config (mode picker / setup /
  // remove) opens in a roomy modal — cramming the mode cards into the narrow
  // header column looked bad.
  const [open, setOpen] = useState(false);
  const inval = () => void qc.invalidateQueries({ queryKey: ["digifab-device-detail", slug, connId, deviceId] });
  const save = useMutation({
    mutationFn: () => api.setBambuLan(slug, connId, deviceId, { host: host.trim(), access_code: code.trim() }),
    onSuccess: () => { toast.success("LAN access saved"); setCode(""); inval(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save LAN access"),
  });
  const clear = useMutation({
    mutationFn: () => api.clearBambuLan(slug, connId, deviceId),
    onSuccess: () => { toast.success("LAN access removed"); setOpen(false); inval(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't remove LAN access"),
  });
  const setMode = useMutation({
    mutationFn: (mode: "cloud" | "prefer_lan" | "lan_only") => api.setBambuLan(slug, connId, deviceId, { mode }),
    onSuccess: () => { toast.success("Mode updated"); setOpen(false); inval(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't update mode"),
  });
  const MODES: { key: "cloud" | "prefer_lan" | "lan_only"; label: string; desc: string }[] = [
    { key: "cloud", label: "All cloud", desc: "Status, control & history via Bambu's cloud. Works anywhere; no bridge." },
    { key: "prefer_lan", label: "Prefer LAN", desc: "Status, control & file-push over your LAN/bridge; cloud fills in print-history names. Cloud is the fallback." },
    { key: "lan_only", label: "LAN only", desc: "Everything local, cloud off: no internet needed, max privacy. You lose cloud-only print-history names/covers." },
  ];
  if (!lan?.applicable) return null;
  const field = "px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const modeLabel = MODES.find((m) => m.key === (lan.mode ?? "cloud"))?.label ?? "All cloud";

  return (
    <>
      {/* Tiny corner affordance — opens the roomy config modal. */}
      {lan.configured ? (
        <button type="button" onClick={() => setOpen(true)} title="LAN access settings" className="flex items-center gap-1.5 text-faint hover:text-content dark:hover:text-mortar-100 transition">
          <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
          <span className="text-content dark:text-mortar-200">{modeLabel}</span>
          <Sliders size={11} />
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1 text-accent hover:underline">
          <Wifi size={11} /> Set up LAN access
        </button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="LAN access" subtitle="file-push + control via your bridge" size="sm">
        {lan.configured ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-moss-500 shrink-0" />
              <span className="text-content dark:text-mortar-100">Connected via <span className="font-mono">{lan.host}</span></span>
              <div className="flex-1" />
              <button type="button" onClick={() => clear.mutate()} disabled={clear.isPending} className="text-faint hover:text-ember-500">Remove</button>
            </div>
            <div className="space-y-1.5">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMode.mutate(m.key)}
                  disabled={setMode.isPending || lan.mode === m.key}
                  className={"w-full text-left rounded border px-3 py-2 " + (lan.mode === m.key ? "border-accent bg-accent/5" : "border-line dark:border-slate-700 hover:border-accent/50")}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span className={"w-3.5 h-3.5 rounded-full border shrink-0 " + (lan.mode === m.key ? "border-accent bg-accent" : "border-line dark:border-slate-600")} />
                    <span className="text-content dark:text-mortar-100 font-medium">{m.label}</span>
                  </div>
                  <div className="text-faint text-xs pl-[1.375rem] mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-1.5">
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Printer IP - 192.168.1.x" className={field + " flex-1"} />
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Access code" className={field + " w-32"} />
              <button type="button" onClick={() => save.mutate()} disabled={save.isPending || !host.trim() || !code.trim()} className="px-2.5 py-1 text-xs rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50">{save.isPending ? "…" : "Enable"}</button>
            </div>
            <span className="text-[11px] text-faint">On the printer: Settings → network for its IP + Access Code. Needs your edge bridge online on the same LAN.</span>
          </div>
        )}
      </Modal>
    </>
  );
}

// A temperature read-out: the LIVE value on top, the SET target below, each
// labelled so there's no "which number is which" ambiguity (no bare arrow). The
// "live"/"set" tags only show when there's a target to disambiguate against
// (chamber has none → just the current reading).
function TempStat({ label, actual, target }: { label: string; actual: number | null | undefined; target?: number | null }) {
  return (
    <div className="rounded border border-line dark:border-slate-700 p-1.5">
      <div className="text-faint text-[10px]">{label}</div>
      <div className="text-content dark:text-mortar-100 leading-tight">
        {actual == null ? "—" : `${Math.round(actual)}°`}
        {actual != null && target != null && <span className="text-faint text-[10px] ml-1">live</span>}
      </div>
      {target != null && target > 0 && (
        <div className="text-faint leading-tight">{Math.round(target)}° <span className="text-[10px]">set</span></div>
      )}
    </div>
  );
}

// The full printer modal — identity + image, live telemetry (temps/AMS/light/
// firmware), controls, link-to-machine, and THIS printer's history, in one place.
export function PrinterDetailModal({ slug, connId, device, onClose }: { slug: string; connId: string; device: DigifabFleetDevice; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [printOpen, setPrintOpen] = useState<DigifabHistory["recent"][number] | null>(null);
  const [linkEdit, setLinkEdit] = useState(false);
  const detail = useQuery({ queryKey: ["digifab-device-detail", slug, connId, device.id], queryFn: () => api.getDigifabDeviceDetail(slug, connId, device.id), refetchInterval: 10_000 });
  // The AI failure-watch verdict for THIS printer — rendered on the camera
  // frame (badge + paused banner) and as a detail strip under it, so the
  // watch reads as part of the picture instead of an invisible daemon.
  // External-detector printers skip the query (single-owner rule): Cobblr
  // isn't watching them and shows who is instead.
  const failQ = useQuery({
    queryKey: ["digifab-failure-status", slug, connId, device.id],
    queryFn: () => api.getDigifabFailureStatus(slug, connId, device.id),
    refetchInterval: 12_000,
    enabled: !device.managed_by_detector,
  });
  const fail = failQ.data ?? null;
  const aiCheck = useMutation({
    mutationFn: () => api.checkDigifabFailure(slug, connId, device.id),
    onSuccess: (r) => {
      if (!r.available) toast.info(`No reading: ${r.reason ?? "no camera frame available"}`);
      else
        toast[r.would_trip ? "error" : "success"](
          `Live reading: ${Math.round((r.probability ?? 0) * 100)}% failure risk via ${r.source ?? "detector"}${r.would_trip ? " — this would trip the auto-pause" : ""}`,
        );
      void failQ.refetch();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't take a reading"),
  });
  const machines = useQuery({ queryKey: ["digifab-all-machines", slug], queryFn: () => fetchAllMachines(slug) });
  const links = useQuery({ queryKey: ["digifab-links", slug], queryFn: () => api.listDigifabLinks(slug) });
  const history = useQuery({ queryKey: ["digifab-history", slug, 365], queryFn: () => api.getDigifabHistory(slug, 365) });
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["digifab-links", slug] }); void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] }); };
  const link = useMutation({
    mutationFn: async (m: LinkableMachine | null): Promise<void> => {
      const cur = (links.data?.items ?? []).find((l) => l.connection_id === connId && l.remote_device_id === device.id);
      if (!m) { if (cur) await api.deleteDigifabLink(slug, cur.id); return; }
      await api.createDigifabLink(slug, { connection_id: connId, remote_device_id: device.id, remote_device_name: device.name, machine_id: m.id, machine_label: m.name });
    },
    onSuccess: () => { toast.success("Updated machine link"); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't update link"),
  });

  // "Print again" — clone the source job + send. Only history rows backed by a
  // Cobblr job can be cloned; Bambu cloud tasks (id "task:…") are view-only.
  const reprint = useMutation({
    mutationFn: (jobId: string) => api.reprintDigifabJob(slug, jobId),
    onSuccess: (r) => {
      toast[r.sent === false && !r.pooled ? "info" : "success"](
        r.pooled ? "Queued to the pool — auto-assigns to a free printer" : r.sent ? "Sent — printing again" : `Queued — send it from the print queue${r.reason ? ` (${r.reason})` : ""}`,
      );
      void qc.invalidateQueries({ queryKey: ["digifab-jobs", slug] });
      void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't reprint"),
  });
  const askReprint = async (r: DigifabHistory["recent"][number]) => {
    const ok = await confirm({
      title: `Print "${r.file_ref}" again?`,
      message: "Clones the original job (same file, routing, material and build) and sends it to the printer. On a live farm this physically starts the print.",
      confirmLabel: "Print again",
      destructive: true,
    });
    if (ok) reprint.mutate(r.id);
  };

  const t = detail.data?.telemetry;
  const machineList = machines.data?.items ?? [];
  const linkedId = device.linked_machine_id;
  const linkedMachine = machineList.find((m) => m.id === linkedId) ?? null;
  const machineImg = useImageSrc(linkedMachine?.image ? (/^https?:/i.test(linkedMachine.image) ? linkedMachine.image : api.fileRawUrl(slug, linkedMachine.image)) : null);
  // Match by device IDENTITY when the row carries it (Cobblr jobs), falling back
  // to display name (Bambu cloud tasks only have names). Fixes the audit B2.6
  // hole where raw device ids / renames silently orphaned a printer's history.
  const mine = (history.data?.recent ?? [])
    .filter((r) =>
      r.device_id
        ? r.connection_id === connId && r.device_id === device.id
        : r.device.trim().toLowerCase() === device.name.trim().toLowerCase(),
    )
    .slice(0, 60); // enough to annotate a full SD card + a meaningful history tail
  const lbl = "text-[10px] font-mono uppercase tracking-widest text-faint";

  return (
    <>
      <Modal open onClose={onClose} title={device.name} size="xl">
        {/* Cockpit: a wide two-column dashboard. LEFT = watch (camera + progress +
            live temps + filament); RIGHT = do (controls + files). Everything the
            operator needs is on one screen — secondary detail (recent prints) is a
            collapsible so the default view fits without scrolling. */}
        <div className="space-y-3">
          {/* Header strip — status pills + machine link + LAN, all on one wrapping row. */}
          <div className="flex flex-wrap items-center gap-2 text-xs pb-2 border-b border-line dark:border-slate-800">
            <span className="px-1.5 py-0.5 rounded bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100">{device.state}</span>
            {device.pool_name && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">{device.pool_name}</span>}
            {!device.enabled && <span className="px-1.5 py-0.5 rounded bg-ember-500/10 text-ember-600">disabled</span>}
            {t?.firmware_update && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">firmware update</span>}
            {t && t.hms_count > 0 && <span className="px-1.5 py-0.5 rounded bg-ember-500/15 text-ember-600">{t.hms_count} alert{t.hms_count > 1 ? "s" : ""}</span>}
            {t && (t.nozzle_diameter || t.nozzle_type) && <span className="text-faint">Nozzle {t.nozzle_diameter}mm {t.nozzle_type?.replace(/_/g, " ")}</span>}
            {t?.wifi && <span className="text-faint">Wi-Fi {t.wifi}</span>}
            <div className="flex-1 min-w-[8rem]" />
            <div className="text-muted dark:text-slate-400">
              {linkedMachine ? <>Linked to <span className="text-accent">{linkedMachine.name}{linkedMachine.instLabel ? ` · ${linkedMachine.instLabel}` : ""}</span></> : <span className="text-faint italic">Not linked to a machine</span>}
              {/* Jump to the machine's own record (specs, mods, notes) — the
                  reverse of the machine page's "Open controls". The instance-
                  aware URL comes from the fleet payload (registry-built). */}
              {device.linked_machine?.detail_url && (
                <Link to={device.linked_machine.detail_url} onClick={onClose} className="text-accent hover:underline ml-1.5">Open machine →</Link>
              )}
              <button type="button" onClick={() => setLinkEdit((v) => !v)} className="text-accent hover:underline ml-1.5">{linkEdit ? "close" : linkedMachine ? "change" : "link"}</button>
            </div>
          </div>
          {linkEdit && (
            <Combobox
              value={linkedId ?? ""}
              allowClear
              placeholder=" - link to a machine - "
              options={machineList.map((m) => ({ value: m.id, label: m.instLabel ? `${m.name} · ${m.instLabel}` : m.name }))}
              onChange={(id) => { link.mutate(id ? (machineList.find((m) => m.id === id) ?? null) : null); setLinkEdit(false); }}
            />
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* LEFT — watch. */}
            <div className="space-y-3 min-w-0">
              {(detail.data?.lan?.camera || machineImg) && (
                <div className="relative">
                  {detail.data?.lan?.camera ? (
                    <LanCameraView slug={slug} connId={connId} deviceId={device.id} name={device.name} onZoom={setLightbox} />
                  ) : (
                    <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 overflow-hidden aspect-video">
                      <img src={machineImg!} alt={device.name} className="w-full h-full object-cover cursor-zoom-in" onClick={() => setLightbox(machineImg!)} />
                    </div>
                  )}
                  {/* The verdict, ON the frame it judges. */}
                  {fail?.watching && !fail.paused && (
                    <div
                      className={`absolute top-2 left-2 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium shadow-lg backdrop-blur-sm ${
                        fail.score >= 0.6
                          ? "bg-ember-600/90 text-white"
                          : fail.score >= 0.3
                            ? "bg-amber-500/90 text-slate-900"
                            : "bg-emerald-600/85 text-white"
                      }`}
                      title={`AI failure watch — rolling score ${fail.score.toFixed(2)} over ${fail.samples} sample${fail.samples === 1 ? "" : "s"}`}
                    >
                      <ShieldCheck size={11} /> {Math.round(fail.score * 100)}%
                    </div>
                  )}
                  {fail?.paused && (
                    <div className="absolute inset-x-0 bottom-0 z-10 bg-ember-600/90 text-white text-xs font-medium px-3 py-1.5 rounded-b-lg">
                      ⚠ AI flagged a likely failure and paused this print - inspect the bed, then resume from the controls.
                    </div>
                  )}
                </div>
              )}
              {/* The watch, in words: freshness + source + a live one-tap reading. */}
              {device.managed_by_detector ? (
                <div className="flex items-center gap-1.5 text-[11px] text-faint">
                  👁 An external detector watches this printer and raises its own alerts; Cobblr stands down its camera (single-owner rule).
                </div>
              ) : fail && (fail.watching || fail.samples > 0 || fail.paused) ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
                  <ShieldCheck size={12} className={fail.watching ? "text-emerald-500" : "text-faint"} />
                  <span>
                    {fail.watching ? "AI failure watch is live" : "AI watch idle (arms when a print starts)"}
                    {fail.last_sample_at &&
                      ` · last look ${Math.max(1, Math.round((Date.now() - new Date(fail.last_sample_at).getTime()) / 60000))}m ago${fail.last_source ? ` via ${fail.last_source}` : ""}`}
                    {fail.samples > 0 && ` · ${fail.samples} sample${fail.samples === 1 ? "" : "s"} this print`}
                  </span>
                  <button
                    type="button"
                    disabled={aiCheck.isPending}
                    onClick={() => aiCheck.mutate()}
                    className="text-accent hover:underline disabled:opacity-50"
                    title="Take one reading from the camera right now and show the verdict"
                  >
                    {aiCheck.isPending ? "reading…" : "Check now"}
                  </button>
                </div>
              ) : null}
              {detail.data?.job && (
                <div>
                  <div className={lbl + " mb-1"}>Printing</div>
                  <JobPanel job={detail.data.job} />
                </div>
              )}
              {t && (
                <div>
                  <div className={lbl + " mb-1"}>Live</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <TempStat label="Nozzle" actual={t.nozzle} target={t.nozzle_target} />
                    <TempStat label="Bed" actual={t.bed} target={t.bed_target} />
                    <TempStat label="Chamber" actual={t.chamber} />
                  </div>
                  {t.ams.length > 0 && (
                    <div className="mt-2">
                      <div className={lbl + " mb-1"}>Filament (AMS)</div>
                      <div className="flex flex-wrap gap-1.5">
                        {t.ams.map((s) => (
                          <span key={s.id} className="inline-flex items-center gap-1.5 text-[11px] rounded border border-line dark:border-slate-700 px-1.5 py-0.5">
                            <span className="w-3 h-3 rounded-full border border-black/20" style={{ backgroundColor: s.color ?? "transparent" }} />
                            <span className="text-content dark:text-mortar-100">{s.type ?? "?"}</span>
                            {s.remain != null && s.remain > 0 && <span className="text-faint">{s.remain}%</span>}
                            {s.id === "ext" && <span className="text-faint text-[10px]">ext</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {detail.data && detail.data.live === false && <div className="text-[11px] text-faint italic">No live cloud telemetry for this printer.</div>}
              {detail.data?.lan?.applicable && (
                <LanAccessPanel slug={slug} connId={connId} deviceId={device.id} lan={detail.data?.lan} />
              )}
            </div>

            {/* RIGHT — do. */}
            <div className="space-y-3 min-w-0">
              <div>
                <div className={lbl + " mb-1.5"}>Controls</div>
                <ControlsPanel slug={slug} connId={connId} deviceId={device.id} name={device.name} telemetry={t} lanActive={!!detail.data?.lan?.configured && detail.data?.lan?.mode !== "cloud"} />
              </div>
            </div>
          </div>

          {/* ON THIS PRINTER — first-class, FULL-WIDTH below the watch/do columns.
              ONE rolled-together surface (the author: the separate Files + Recent-prints
              sections read as two things when they answer the same question —
              "what can I print / print again?"): the SD-card files (each with a
              printed-on chip when a recent print matches by name, and a Print
              button), plus a tail of prints whose file is no longer on the card
              (view detail; Print-again when a Cobblr job backs it). */}
          <div className="pt-3 border-t border-line dark:border-slate-800">
            <div className={lbl + " mb-1.5"}>On {device.name}  - files &amp; prints</div>
            <FilesPanel
              slug={slug}
              connId={connId}
              deviceId={device.id}
              onZoom={setLightbox}
              history={mine}
              onOpenPrint={setPrintOpen}
              onReprint={(r) => void askReprint(r)}
            />
          </div>
        </div>
      </Modal>
      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {printOpen && <PrintDetailModal item={printOpen} onClose={() => setPrintOpen(null)} onZoom={setLightbox} onReprint={(r) => { setPrintOpen(null); void askReprint(r); }} />}
    </>
  );
}

// A single print's detail — large cover (click to zoom) + the metadata.
export function PrintDetailModal({ item, onClose, onZoom, onReprint }: { item: DigifabHistory["recent"][number]; onClose: () => void; onZoom?: (src: string) => void; onReprint?: (r: DigifabHistory["recent"][number]) => void }) {
  const durMin = item.duration_s ? Math.round(item.duration_s / 60) : 0;
  const dur = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : durMin > 0 ? `${durMin}m` : null;
  const row = (k: string, v: ReactNode) => (v ? <div className="flex justify-between gap-3 text-xs py-1 border-b border-line dark:border-slate-800 last:border-0"><span className="text-faint">{k}</span><span className="text-content dark:text-mortar-100 text-right">{v}</span></div> : null);
  return (
    <Modal open onClose={onClose} title={item.file_ref} size="md">
      <div className="space-y-3">
        {item.cover && (
          <img src={item.cover} alt="" className="w-full max-h-72 object-contain rounded bg-subtle dark:bg-slate-800 cursor-zoom-in" onClick={() => onZoom?.(item.cover!)} />
        )}
        <div>
          {row("Status", <span className={item.status === "completed" ? "text-moss-600" : item.status === "failed" ? "text-ember-600" : ""}>{item.status}</span>)}
          {row("Profile", item.sub_label)}
          {row("Printer", item.device)}
          {row("Filament", item.filament_g != null ? `${Math.round(item.filament_g)} g` : null)}
          {row("Print time", dur)}
          {row("When", new Date(item.at).toLocaleString())}
        </div>
        {onReprint && isReprintable(item) && (
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => onReprint(item)}
              className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition"
            >
              <RefreshCw size={13} /> Print again
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Pools ──────────────────────────────────────────────────────────────────
// A pool is a Cobblr-native set of machines (possibly across connections) you
// queue jobs onto; the assignment worker drips queued pool jobs onto free
// members. This is how you aggregate a pile of individual printers into one
// farm — the FDM-Monster-replacement core.

// F-10 — add several machines to a pool at once (building a 50-member pool one

/** Per-machine "Print manager" panel — shown in the detail modal when digifab
 *  is enabled (the 3D Printers bundle brings both modules under one roof). Lets
 *  you link THIS machine to a manager's device (FDM Monster / OctoPrint / …)
 *  without leaving the machine's page, so a job routed to the machine goes to
 *  the right printer. Mirrors the link model on the /digifab page. */
// Live status chip logic moved to lib/fleet-status.ts (fleetStatusChip) — ONE
// status vocabulary shared with the digifab floor's bucket chips.

// Printer kind → the bridge driver key, so connecting a manager from a printer
// pre-selects the right driver (Klipper→moonraker, Prusa→prusalink, Duet→duet).
const KIND_BRIDGE_DRIVER: Record<string, string> = { klipper: "moonraker", prusa: "prusalink", reprap: "duet", duet: "duet" };

export function MachineDigifabPanel({
  slug,
  machineId,
  machineName,
  driverHint,
}: {
  slug: string;
  machineId: string;
  machineName: string;
  /** Pre-selected bridge driver (from the printer's kind), for the inline connect. */
  driverHint?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const links = useQuery({
    queryKey: ["digifab-links", slug],
    queryFn: () => api.listDigifabLinks(slug),
    enabled: !!slug,
  });
  const conns = useQuery({
    queryKey: ["digifab-connections", slug],
    queryFn: () => api.listDigifabConnections(slug),
    enabled: !!slug,
  });
  const link = (links.data?.items ?? []).find((l) => l.machine_id === machineId);
  const connections = conns.data?.items ?? [];
  // Live status of this machine's linked device (polls while the modal is open).
  const fleet = useQuery({
    queryKey: ["digifab-fleet", slug],
    queryFn: () => api.getDigifabFleet(slug),
    enabled: !!slug && !!link,
    refetchInterval: 15_000,
  });
  const fleetDev = link
    ? fleet.data?.connections.find((c) => c.connection_id === link.connection_id)?.devices.find((d) => d.id === link.remote_device_id)
    : undefined;
  const chip = fleetStatusChip(fleetDev);

  const [connId, setConnId] = useState("");
  const [createConnOpen, setCreateConnOpen] = useState(false);
  // The cockpit — the same PrinterDetailModal a fleet tile opens (camera,
  // temps, controls, files, history). Reachable from the machine's own page,
  // so "operate this machine" is identical from either doorway
  // (machines-digifab-unification.md §6).
  const [cockpitOpen, setCockpitOpen] = useState(false);
  const devices = useQuery({
    queryKey: ["digifab-devices", slug, connId],
    queryFn: () => api.listDigifabDevices(slug, connId),
    enabled: !!connId,
  });
  const [deviceId, setDeviceId] = useState("");
  // Not linked yet? Pre-choose the manager (when there's only one) and its printer
  // (when there's only one) so the Print Manager isn't sitting on "choose…" — the
  // user just clicks Link.
  useEffect(() => {
    if (link || connId) return;
    if (connections.length === 1 && connections[0]) setConnId(connections[0].id);
  }, [link, connId, connections]);
  useEffect(() => {
    const d = devices.data?.items ?? [];
    if (!deviceId && d.length === 1 && d[0]) setDeviceId(d[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.dataUpdatedAt, deviceId]);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["digifab-links", slug] });
  const createLink = useMutation({
    mutationFn: () => {
      const dev = (devices.data?.items ?? []).find((d) => d.id === deviceId);
      return api.createDigifabLink(slug, {
        connection_id: connId,
        remote_device_id: deviceId,
        remote_device_name: dev?.name ?? null,
        machine_id: machineId,
        machine_label: machineName,
      });
    },
    onSuccess: () => {
      toast.success("Linked to print manager.");
      setConnId("");
      setDeviceId("");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't link."),
  });
  const removeLink = useMutation({
    mutationFn: (id: string) => api.deleteDigifabLink(slug, id),
    onSuccess: () => {
      toast.success("Unlinked from print manager.");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't unlink."),
  });

  const conn = link ? connections.find((c) => c.id === link.connection_id) : undefined;

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/30 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-accent">
          <Printer size={12} /> Print manager
        </div>
        {link && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-subtle dark:bg-slate-800 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-content dark:text-mortar-200">
            <span className={`w-1.5 h-1.5 rounded-full ${chip.dot}`} />
            {chip.label}
          </span>
        )}
      </div>

      {link ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-content dark:text-mortar-100">
              Linked to{" "}
              <span className="font-medium">{conn?.label ?? "a manager"}</span>
              {" · "}
              <span className="font-mono text-xs text-muted">
                {link.remote_device_name ?? link.remote_device_id}
              </span>
            </span>
            <button
              onClick={() => removeLink.mutate(link.id)}
              disabled={removeLink.isPending}
              className="text-[10px] font-mono uppercase tracking-widest text-faint hover:text-ember-500 transition flex items-center gap-1 disabled:opacity-50"
            >
              <Trash2 size={11} /> unlink
            </button>
          </div>
          {/* Open the cockpit — the SAME modal a fleet tile opens. Enabled once
              the manager has reported this printer live (fleetDev present); a
              printer the manager can't currently see has nothing to control. */}
          <button
            type="button"
            onClick={() => setCockpitOpen(true)}
            disabled={!fleetDev}
            title={fleetDev ? "Camera, temperatures, controls, files & history" : "Waiting for the manager to report this printer…"}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium py-1.5 transition"
          >
            <Sliders size={13} /> Open controls
          </button>
        </div>
      ) : connections.length === 0 ? (
        <p className="text-xs text-muted dark:text-slate-400">
          No print managers connected yet - add FDM Monster, OctoPrint, Klipper, Duet, Prusa, or Bambu.{" "}
          <button type="button" onClick={() => setCreateConnOpen(true)} className="text-accent hover:underline">
            Connect one →
          </button>
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-faint mb-1">
              Manager
              <button type="button" onClick={() => setCreateConnOpen(true)} className="text-accent hover:underline normal-case tracking-normal">
                + new
              </button>
            </span>
            <select
              value={connId}
              onChange={(e) => {
                setConnId(e.target.value);
                setDeviceId("");
              }}
              className="input !py-1 !text-xs !w-auto"
            >
              <option value="">choose…</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {connId && (() => {
            const devs = devices.data?.items ?? [];
            // A direct driver (PrusaLink / Duet / a LAN Bambu) IS the one printer —
            // exactly one device, nothing to pick. Only a true farm manager (FDM
            // Monster / OctoPrint fronting several printers) needs a "which printer"
            // step. So show the dropdown only for 2+; otherwise state the target.
            if (devices.isLoading) return <span className="text-[11px] text-muted dark:text-slate-400 self-center">checking…</span>;
            if (devices.isError) return <span className="text-[11px] text-rose-500 self-center">couldn't reach it - is the bridge + printer on?</span>;
            if (devs.length === 0) return <span className="text-[11px] text-muted dark:text-slate-400 self-center">no printer found at this connection</span>;
            if (devs.length === 1) return <span className="text-[11px] text-muted dark:text-slate-400 self-center">→ {devs[0]!.name} <span className="text-faint dark:text-slate-500">(direct)</span></span>;
            return (
              <label className="block">
                <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Printer</span>
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="input !py-1 !text-xs !w-auto">
                  <option value="">choose…</option>
                  {devs.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
                </select>
              </label>
            );
          })()}
          <button
            onClick={() => createLink.mutate()}
            disabled={!connId || !deviceId || createLink.isPending}
            className="rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs px-2.5 py-1.5"
          >
            {createLink.isPending ? "linking…" : "Link"}
          </button>
        </div>
      )}
      {createConnOpen && (
        <CreateConnectionModal
          types={conns.data?.types ?? ["fdm_monster", "mock"]}
          presetType="edge_adapter"
          presetName={machineName}
          presetDriver={driverHint}
          onClose={() => setCreateConnOpen(false)}
          onCreated={(connectionId) => {
            // Auto-select the just-created manager so it's not back on "choose…";
            // its single device then auto-picks → the user just clicks Link.
            void qc.invalidateQueries({ queryKey: ["digifab-connections", slug] });
            if (connectionId) {
              setConnId(connectionId);
              setDeviceId("");
            }
            setCreateConnOpen(false);
          }}
        />
      )}
      {/* The cockpit, opened from the machine's own page — same component the
          fleet tile mounts. Portals to body, so it layers over the machine
          detail modal cleanly. */}
      {cockpitOpen && link && fleetDev && (
        <PrinterDetailModal
          slug={slug}
          connId={link.connection_id}
          device={fleetDev}
          onClose={() => setCockpitOpen(false)}
        />
      )}
    </div>
  );
}

// ── Panel-registry adapters (web/src/panels/registry.tsx) ────────────────
// The generic host context → this feature's component props. These are the
// ONLY entry points the machines pages reach digifab UI through.

/** contributes.panels "digifab:fleet-tab" — the scoped floor as a page tab. */
export function FleetPageTab({ ctx }: { ctx: ModulePageTabCtx }) {
  return <FleetView slug={ctx.slug} machineIds={ctx.entityIds} scopeNoun={ctx.itemNoun} />;
}

/** contributes.panels "digifab:cockpit" — the per-machine Print manager in
 *  the machine's detail modal. The printer_kind hint (machines metadata)
 *  maps to a bridge driver HERE — driver keys are digifab knowledge. */
export function MachineCockpitPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  return (
    <MachineDigifabPanel
      slug={ctx.slug}
      machineId={ctx.entityId}
      machineName={ctx.entityTitle}
      driverHint={KIND_BRIDGE_DRIVER[ctx.hints?.printer_kind ?? ""]}
    />
  );
}
