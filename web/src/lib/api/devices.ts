import { ApiError, request } from "./client";
import type { LiveControlPublic } from "@cobblr/platform-contract";
import type { BridgeDiscovery } from "@cobblr/platform-contract/bridge-discovery";
import type { ServerBridgeState } from "@cobblr/platform-contract/server-bridge";

/** A driver package a workspace declares for its bridges. `bridgeId` null
 *  means every bridge; a value scopes it to one. */
export interface EdgeDriverDeclaration {
  kind: string;
  version: string;
  sha256: string;
  source: string;
  bridgeId?: string | null;
}

export interface PairingItem {
  id: string;
  org_id: string;
  source_kind: string;
  source_id: string;
  target_kind: string;
  target_id: string;
  relationship_kind: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

export const devicesApi = {
  /** Is my personal edge agent connected right now? (transit hint) */
  getMyEdgeAgent: () => request<{ connected: boolean }>("GET", "/me/edge-agent"),
  esphomeConnections: (slug: string) => request<{ items: import("@cobblr/platform-contract").DeviceConnectionPublic[] }>("GET", `/orgs/${slug}/modules/core-devices/esphome`),
  addESPHome: (slug: string, body: { label: string; base_url: string; bridge: string; api_key?: string }) => request<import("@cobblr/platform-contract").DeviceConnectionPublic>("POST", `/orgs/${slug}/modules/core-devices/esphome`, body),
  removeESPHome: (slug: string, id: string) => request<{ ok: boolean }>("DELETE", `/orgs/${slug}/modules/core-devices/esphome/${id}`),
  esphomeEntities: (slug: string, id: string) => request<{ items: Array<{ id: string; name: string; state?: string; raw?: { type: string; unit?: string; effects?: string[] } }> }>("GET", `/orgs/${slug}/modules/core-devices/esphome/${id}/entities`),
  discoverESPHome: (slug: string, id: string) => request<{ items: Array<{ name: string; host: string; port: number }> }>("POST", `/orgs/${slug}/modules/core-devices/esphome/${id}/discover`, {}),
  chooseESPHome: (slug: string, id: string, host: string) => request<import("@cobblr/platform-contract").DeviceConnectionPublic>("PATCH", `/orgs/${slug}/modules/core-devices/esphome/${id}`, { host }),
  deviceReadingsForRecord: (slug: string, kind: string, id: string) => request<{ items: Array<{ id: string; device: string; value: number | null; unit: string | null; sampled_at: string | null }> }>("GET", `/orgs/${slug}/modules/core-devices/links?entity_kind=${encodeURIComponent(kind)}&entity_id=${encodeURIComponent(id)}`),
  deviceLinks: (slug: string, connection: string) => request<{ items: Array<{ id: string; device: string; entity_kind: string; entity_id: string; value: number | null; unit: string | null; sampled_at: string | null }> }>("GET", `/orgs/${slug}/modules/core-devices/links?connection_id=${encodeURIComponent(connection)}`),
  attachDevice: (slug: string, body: { connection_id: string; device: string; entity_kind: string; entity_id: string; mode: "log" }) => request("POST", `/orgs/${slug}/modules/core-devices/links`, body),
  unlinkDevice: (slug: string, id: string) => request("DELETE", `/orgs/${slug}/modules/core-devices/links/${id}`),

  // ─── Live box (docs/design-decisions/live-controls.md) ────────────
  // The applicable live controls for this workspace: every enabled module's
  // exposes.live whose required capability is satisfied. Empty → the box hides.
  getLive: (slug: string) =>
    request<{ controls: LiveControlPublic[] }>("GET", `/orgs/${slug}/live`),
  discoverBridgeDevices: (slug:string,bridge:string|null) => request<BridgeDiscovery>("GET", `/orgs/${slug}/edge/discovery${bridge?`?bridge=${encodeURIComponent(bridge)}`:""}`),
  getServerBridge: (slug: string) => request<ServerBridgeState>("GET", `/orgs/${slug}/edge/server-bridge`),
  setServerBridge: (slug: string, enabled: boolean) => request<ServerBridgeState>("POST", `/orgs/${slug}/edge/server-bridge`, {enabled}),
  /** Edge-bridge pane of glass: workspace agents + the caller's personal agent. */
  getEdgeStatus: (slug: string) =>
    request<{
      agents: Array<{ bridge: string | null; last_seen_ms: number; queued: number; in_flight: number; parked: boolean }>;
      personal: { connected: boolean; backs?: string[] };
      stale_after_ms: number;
    }>("GET", `/orgs/${slug}/edge/status`),
  /** Driver packages this workspace has declared. Carries the source URL, so
   *  it is admin-only and deliberately NOT what a bridge is served. */
  getEdgeDriverDeclarations: (slug: string) =>
    request<{ drivers: EdgeDriverDeclaration[] }>("GET", `/orgs/${slug}/edge/driver-declarations`),
  /** Declare or re-pin a driver. Writes a row; the bridge converges on its own
   *  next poll, so this works while the bridge is offline. */
  declareEdgeDriver: (slug: string, body: EdgeDriverDeclaration) =>
    request<{ ok: boolean; kind: string }>("POST", `/orgs/${slug}/edge/drivers`, body),
  removeEdgeDriver: (slug: string, kind: string, bridgeId?: string | null) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/edge/drivers/${encodeURIComponent(kind)}${bridgeId ? `?bridge=${encodeURIComponent(bridgeId)}` : ""}`,
    ),
  /** Modules that can attach to a bridge — data-driven consumer registry. */
  getEdgeConsumers: (slug: string) =>
    request<{ consumers: Array<{ module: string; label: string; description: string; href: string; enabled: boolean }> }>(
      "GET",
      `/orgs/${slug}/edge/consumers`,
    ),

  // ─── D4 entity pairings — polymorphic links without firing a wire ─
  createPairing: (
    slug: string,
    body: {
      source_kind: string;
      source_id: string;
      target_kind: string;
      target_id: string;
      relationship_kind: string;
      notes?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) => request<PairingItem>("POST", `/orgs/${slug}/pairings`, body),
  deletePairing: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/pairings/${id}`),
  recordLinks: (slug: string, kind: string, id: string) =>
    request<{ items: Array<PairingItem & { direction: "in" | "out" }> }>(
      "GET",
      `/orgs/${slug}/pairings?record_kind=${encodeURIComponent(kind)}&record_id=${encodeURIComponent(id)}`,
    ),
  /** The links this record can make, in words, and the words for every link
   *  kind the workspace declares. */
  linkKinds: (slug: string, kind: string) =>
    request<{
      offered: Array<{ kind: string; label: string; to: string[]; reverse: boolean }>;
      words: Record<string, { label: string; inverse: string; date_summary?: import("@cobblr/platform-contract/link-date-summary").LinkDateSummary }>;
      /** Link kinds a record's Links do not remove (a thing's type). */
      fixed?: string[];
    }>("GET", `/orgs/${slug}/pairings/link-kinds?record_kind=${encodeURIComponent(kind)}`),
  // This workspace's connected edge bridges (default + named) — for the shared
  // bridge picker. Served by digifab's relay, which all edge transport rides.
  createEdgePairingCode: (slug: string, name: string, bridge: string | null) =>
    request<{ code: string; expires_at: string }>("POST", `/orgs/${slug}/edge/pairing-codes`, { name, bridge }),
  disconnectEdgeBridge: (slug: string, bridge: string | null) =>
    request<{ ok: true; also_cut: string[] }>("POST", `/orgs/${slug}/edge/bridges/disconnect`, { bridge }),
  renameEdgeBridge: (slug: string, bridge: string | null, name: string) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/edge/bridges/rename`, { bridge, name }),
  // ── A Station (#4640): a tablet a barcode scanner drives ──────────────
  /** A tablet asks to become a station: no session, so a plain fetch. */
  stationRequest: async (slug: string, address: string) => {
    const r = await fetch("/api/v1/station/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, address }) });
    if (!r.ok) throw new ApiError(r.status, "station_request", (await r.json().catch(() => null))?.error?.message ?? "Could not ask to become a station.");
    return (await r.json()) as { request_id: string; poll_key: string; code: string; expires_at: string };
  },
  stationPoll: async (requestId: string, pollKey: string) => {
    const r = await fetch(`/api/v1/station/requests/${encodeURIComponent(requestId)}?key=${encodeURIComponent(pollKey)}`, { cache: "no-store" });
    if (!r.ok) throw new ApiError(r.status, "station_poll", "Could not check the approval.");
    return (await r.json()) as { status: "pending" | "approved" | "gone"; token?: string; address?: string; label?: string; expires_at?: string };
  },
  approveStation: (slug: string, code: string, label?: string) =>
    request<{ address: string; label: string }>("POST", `/orgs/${slug}/station-devices/approve`, { code, ...(label ? { label } : {}) }),
  listStationDevices: (slug: string) =>
    request<{ items: Array<{ id: string; name: string; address: string; label: string; approved_by: string; created_at: string; last_used_at: string | null }> }>(
      "GET",
      `/orgs/${slug}/station-devices`,
    ),
  revokeStationDevice: (slug: string, id: string) => request<{ ok: true }>("DELETE", `/orgs/${slug}/station-devices/${id}`),
  /** A phone opened a station's kitchen QR (#5353): its key buys a token for
   *  that station's few presses. No session, so a plain fetch; null when the
   *  label no longer opens it. */
  stationQrClaim: async (slug: string, address: string, key: string) => {
    const r = await fetch("/api/v1/station/qr/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, address, key }), cache: "no-store" });
    if (r.status === 403) return null;
    if (!r.ok) throw new ApiError(r.status, "station_qr_claim", (await r.json().catch(() => null))?.error?.message ?? "Could not open the station.");
    return (await r.json()) as { ok: true; token: string; slug: string; address: string; label: string };
  },
  stationQrState: (slug: string, address: string) =>
    request<{ enabled: boolean; printed_at: string | null; phones: number }>("GET", `/orgs/${slug}/station-devices/qr/${address}`),
  /** Print a new kitchen QR: a fresh key (shown once, for the label) that
   *  retires the old one and every phone it let in. */
  printStationQr: (slug: string, address: string) =>
    request<{ key: string; enabled: boolean; printed_at: string | null; phones: number }>("POST", `/orgs/${slug}/station-devices/qr/${address}`, {}),
  stopStationQr: (slug: string, address: string) => request<{ ok: true }>("DELETE", `/orgs/${slug}/station-devices/qr/${address}`),
};
