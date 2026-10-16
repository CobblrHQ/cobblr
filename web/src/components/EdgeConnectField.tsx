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
// Reuses the shared pieces rather than reinventing them: the home-network hint
// every address field shows (HomeNetworkHint, the contract's rule), EdgeBridgeInstall (mint
// a token + show the run command + watch for the bridge to dial in), and
// BridgePicker (choose among connected bridges).

import { productName } from "@cobblr/platform-web";
import { useQuery } from "@tanstack/react-query";
import { SegmentedChoice } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { EdgeBridgeInstall } from "./EdgeBridgeInstall";
import { BridgePicker } from "./BridgePicker";
import { HomeNetworkHint } from "./HomeNetworkHint";
import { needsBridge } from "@cobblr/platform-contract/address-reach";

export interface EdgeConnectValue {
  mode: "direct" | "edge";
  /** Direct: the typed http(s):// URL. Edge: `cobblr-edge://<bridge-id>`. */
  base_url: string;
  /** Edge only: the chosen bridge id (null = the workspace's default bridge). */
  bridge: string | null;
}


const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
const lbl = "block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

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
      <SegmentedChoice
        label={`How ${productName()} reaches the print manager`}
        value={value.mode}
        onChange={(mode) => (mode === "direct" ? setDirect(value.mode === "direct" ? value.base_url : "") : setEdge(value.bridge))}
        options={[
          { value: "edge", label: "Via edge bridge" },
          { value: "direct", label: "Direct URL" },
        ]}
      />

      {value.mode === "direct" ? (
        <div>
          <span className={lbl}>Print manager URL</span>
          <input
            className={field + " font-mono"}
            value={value.base_url}
            onChange={(e) => setDirect(e.target.value)}
            placeholder={urlPlaceholder}
          />
          {needsBridge(value.base_url, { hosted }) ? (
            <div className="mt-1 space-y-1">
              <HomeNetworkHint address={value.base_url} hosted={hosted} />
              <button type="button" onClick={() => setEdge(value.bridge)} className="text-[11px] underline text-accent">
                Send it through my bridge instead
              </button>
            </div>
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
            {productName()} hands the print job to this bridge; the bridge speaks to your printer on the LAN.
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
