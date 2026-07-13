// Connection-agnostic "how does Cobblr reach this thing on your network" field.
// Two modes: DIRECT (a reachable http(s):// URL — works on self-host / same LAN)
// or EDGE (route through the on-site Cobblr edge bridge — the only way a HOSTED
// instance reaches a LAN device). It knows about NO module: it PERSISTS NOTHING
// and resolves to a plain `{ mode, base_url, bridge }` value — the host surface
// (a printer form, a machine form, a sync connector) calls its own create
// endpoint with the resolved base_url. Mirrors the header note in
// EdgeBridgeInstall.tsx: the wire is kernel infrastructure; what USES it is a
// separate, data-driven concern.
//
// Reuses the shared pieces rather than reinventing them: DirectManagerConnect's
// LAN-on-hosted warning (inlined here as the same copy), EdgeBridgeInstall (mint
// a token + show the run command + watch for the bridge to dial in), and
// BridgePicker (choose among connected bridges).

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { EdgeBridgeInstall } from "./EdgeBridgeInstall";
import { BridgePicker } from "./BridgePicker";

export interface EdgeConnectValue {
  mode: "direct" | "edge";
  /** Direct: the typed http(s):// URL. Edge: `cobblr-edge://<bridge-id>`. */
  base_url: string;
  /** Edge only: the chosen bridge id (null = the workspace's default bridge). */
  bridge: string | null;
}

/** A private/LAN address a cloud-hosted Cobblr can't reach directly (needs the
 *  edge bridge). Bare hostnames + .local + RFC-1918 ranges + loopback. Same test
 *  DirectManagerConnect uses. */
function looksLikeLan(raw: string): boolean {
  let host = raw.trim();
  if (!host) return false;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname;
  } catch {
    /* fall through */
  }
  if (host === "localhost" || host.endsWith(".local")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return !host.includes("."); // bare hostname → mDNS/LAN; a dotted public DNS name → not
  const a = Number(m[1]),
    b = Number(m[2]);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

export function EdgeConnectField({
  slug,
  hosted,
  value,
  onChange,
  urlPlaceholder = "http://printhost.lan:631",
}: {
  slug: string;
  /** Is THIS Cobblr hosted (managed) vs self-hosted? Drives whether the edge
   *  option is offered at all — a self-hosted box on the LAN just uses a URL. */
  hosted: boolean;
  value: EdgeConnectValue;
  onChange: (v: EdgeConnectValue) => void;
  urlPlaceholder?: string;
}) {
  // Which bridges are connected right now — decides install-a-bridge vs pick-one.
  // Same query key BridgePicker uses, so react-query shares one fetch.
  const bridgesQ = useQuery({
    queryKey: ["edge-bridges", slug],
    queryFn: () => api.listEdgeBridges(slug),
    enabled: !!slug && hosted,
    refetchInterval: 8000,
  });
  const anyOnline = (bridgesQ.data?.bridges ?? []).some((b) => b.connected);

  const setDirect = (base_url: string) => onChange({ mode: "direct", base_url, bridge: null });
  const setEdge = (bridge: string | null) =>
    onChange({ mode: "edge", base_url: bridge ? `cobblr-edge://${bridge}` : "cobblr-edge://", bridge });

  // Self-hosted: no edge option, just the direct URL (today's behavior).
  if (!hosted) {
    return (
      <div>
        <span className={lbl}>Print manager URL</span>
        <input
          className={field + " font-mono"}
          value={value.base_url}
          onChange={(e) => setDirect(e.target.value)}
          placeholder={urlPlaceholder}
        />
        <div className="text-[11px] text-faint mt-1">CUPS host on your LAN, e.g. http://printhost.lan:631.</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Mode chooser — how Cobblr reaches the manager. */}
      <div className="inline-flex rounded border border-line dark:border-slate-600 overflow-hidden text-[11px]">
        {(
          [
            ["edge", "Via edge bridge"],
            ["direct", "Direct URL"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => (mode === "direct" ? setDirect(value.mode === "direct" ? value.base_url : "") : setEdge(value.bridge))}
            className={"px-2.5 py-1 " + (value.mode === mode ? "bg-cobble-600 text-white" : "text-muted hover:bg-subtle dark:hover:bg-slate-800")}
          >
            {label}
          </button>
        ))}
      </div>

      {value.mode === "direct" ? (
        <div>
          <span className={lbl}>Print manager URL</span>
          <input
            className={field + " font-mono"}
            value={value.base_url}
            onChange={(e) => setDirect(e.target.value)}
            placeholder={urlPlaceholder}
          />
          {looksLikeLan(value.base_url) ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
              That's a LAN address, and this is a <strong>hosted</strong> Cobblr, which can't reach a device on your
              network directly. Switch to <strong>Via edge bridge</strong> and route through the bridge instead.
            </p>
          ) : (
            <div className="text-[11px] text-faint mt-1">
              A publicly reachable manager URL. For a printer on your own network, use <strong>Via edge bridge</strong>.
            </div>
          )}
        </div>
      ) : anyOnline ? (
        <div>
          <span className={lbl}>Bridge</span>
          <BridgePicker slug={slug} value={value.bridge} onChange={(b) => setEdge(b)} />
          <div className="text-[11px] text-faint mt-1">
            Cobblr hands the print job to this bridge; the bridge speaks to your printer on the LAN.
          </div>
        </div>
      ) : (
        // No bridge online yet — install one inline. Once it dials in, the picker
        // above replaces this (the bridges query flips anyOnline true).
        <EdgeBridgeInstall slug={slug} />
      )}
    </div>
  );
}
