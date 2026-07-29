// Inline "connect a network printer" — the non-Bambu analog of the Bambu wizard.
// For a declarative-HTTP driver (Duet / OctoPrint / Klipper-Moonraker / PrusaLink):
// enter the printer's address (+ API key if the driver needs one) and we install
// the driver if it isn't already, create the connection, test it, and hand back
// the connection + discovered devices so the New-3D-printer modal can link it.
// No trip to the Print Manager, no pasted JSON — same "you do nothing" feel as Bambu.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ApiError, api, type DigifabConnection, type DigifabDevice } from "../lib/api";

/** A private/LAN address a cloud-hosted Cobblr can't reach directly (needs the
 *  edge bridge). Bare hostnames + .local + RFC-1918 ranges + loopback. */
function looksLikeLan(raw: string): boolean {
  let host = raw.trim();
  if (!host) return false;
  try { host = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname; } catch { /* fall through */ }
  if (host === "localhost" || host.endsWith(".local")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return !host.includes("."); // bare hostname → mDNS/LAN; a dotted public DNS name → not
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function DirectManagerConnect({
  driverId,
  kindLabel,
  defaultLabel,
  onConnected,
  onCancel,
}: {
  /** Catalog driver id, e.g. "duet-rrf". */
  driverId: string;
  /** Human label for the kind, e.g. "RepRapFirmware". */
  kindLabel: string;
  /** Connection label to create, e.g. the typed machine name. */
  defaultLabel: string;
  onConnected: (conn: DigifabConnection, devices: DigifabDevice[]) => void;
  onCancel: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const catalog = useQuery({
    queryKey: ["digifab-driver-catalog", activeSlug],
    queryFn: () => api.getDigifabDriverCatalog(activeSlug),
    enabled: !!activeSlug,
  });
  // Whether THIS Cobblr is hosted (cobblr.me / managed) vs self-hosted — a hosted
  // instance generally can't reach a LAN device, a self-hosted one (same network)
  // can. Drives whether we warn about a LAN address at all.
  const authCfg = useQuery({ queryKey: ["auth-config"], queryFn: () => api.authConfig(), staleTime: 5 * 60_000 });
  const hosted = !!authCfg.data?.hosted;
  const entry = catalog.data?.drivers.find((d) => d.id === driverId);
  const auth = (entry?.manifest as { auth?: { from: "apiKey" | "username" | "password" } } | undefined)?.auth;
  const [url, setUrl] = useState("");
  const [cred, setCred] = useState("");

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

  const connect = useMutation({
    mutationFn: async () => {
      if (!entry) throw new ApiError(400, "no_driver", "Driver catalog still loading — try again in a moment");
      // 1. Install the driver if this workspace doesn't have it yet.
      const drivers = await api.listDigifabDrivers(activeSlug);
      const have = new Set([...drivers.builtins.map((b) => b.key), ...drivers.installed.map((d) => d.key)]);
      if (!have.has(driverId)) await api.installDigifabDriver(activeSlug, entry.manifest);
      // 2. Normalize the address into a real URL. A bare IP/host ("192.168.1.50")
      // gets http:// prepended, and anything that still won't parse is rejected up
      // front — so we never persist a schemeless/garbage base_url that later shows
      // as "unreachable — invalid URL" in the fleet.
      const addr = url.trim();
      const withScheme = /^https?:\/\//i.test(addr) ? addr : `http://${addr}`;
      let baseUrl: string;
      try {
        baseUrl = new URL(withScheme).toString().replace(/\/+$/, "");
      } catch {
        throw new ApiError(400, "bad_url", `"${addr}" isn't a valid address — try an IP or hostname (e.g. 192.168.1.50) or a full URL.`);
      }
      // 3. Create the connection (credential goes where the driver's auth wants it).
      const credField =
        cred.trim() && auth?.from === "apiKey" ? { api_key: cred.trim() } :
        cred.trim() && auth?.from === "password" ? { password: cred.trim() } :
        cred.trim() && auth?.from === "username" ? { username: cred.trim() } : {};
      const conn = await api.createDigifabConnection(activeSlug, {
        type: driverId,
        label: defaultLabel.trim() || kindLabel,
        base_url: baseUrl,
        ...credField,
      });
      // 4. Test (best-effort) + discover devices.
      const test = await api.testDigifabConnection(activeSlug, conn.id).catch(() => ({ ok: false }));
      const devices = (await api.listDigifabDevices(activeSlug, conn.id).catch(() => ({ items: [] as DigifabDevice[] }))).items;
      return { conn, devices, ok: !!test.ok };
    },
    onSuccess: ({ conn, devices, ok }) => {
      if (ok) toast.success(`${kindLabel} connected`);
      else toast.error("Created, but Cobblr couldn't reach it - check the address is right and on the network.");
      onConnected(conn, devices);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Printer size={14} className="text-accent" />
        <span>Point Cobblr at your <strong>{kindLabel}</strong> on the network - we install the driver and connect.</span>
      </div>
      <label className="block">
        <span className={lbl}>Address (URL or IP)</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.50" className={field} autoFocus />
      </label>
      {auth && (
        <label className="block">
          <span className={lbl}>API key{entry?.credentialHint ? ` · ${entry.credentialHint}` : ""}</span>
          <input value={cred} onChange={(e) => setCred(e.target.value)} placeholder="optional for some firmwares" className={field} />
        </label>
      )}
      {hosted && looksLikeLan(url) && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          That's a LAN address, and this is a <strong>hosted</strong> Cobblr - it can't reach a device on your network directly. Run the <strong>Cobblr edge bridge</strong> on your network and connect through that instead.
        </p>
      )}
      <p className="text-[11px] text-faint">Stored encrypted. Cobblr sends files + start/status to this address; it never streams motion.</p>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
        <button type="button" onClick={() => connect.mutate()} disabled={connect.isPending || !url.trim() || catalog.isLoading}
          className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
          {connect.isPending ? "Connecting…" : "Connect"}
        </button>
      </div>
    </div>
  );
}
