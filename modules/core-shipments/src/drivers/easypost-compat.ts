// easypost-compat — ANY server speaking EasyPost's tracker wire format.
//
// The same shape as core-ai's `openai-compat`, and for the same reason: the
// wire format IS the compatibility contract. Point it at EasyPost and it is an
// EasyPost client; point it at something you run that answers the same shape
// and core cannot tell, which is what makes a local bridge possible without
// core shipping a bespoke protocol nobody else implements.
//
// Why EasyPost's format and not AfterShip's, when AfterShip is the bigger name
// (measured 2026-08-13, all four checked directly):
//
//   AfterShip     /v4/trackings/{slug}/{num}  meta/data envelope  CamelCase tags
//   TrackingMore  /v4/trackings/…             meta/data envelope  v4-style
//   Tracktry      /v1/…                       meta/data envelope  lowercase, its own
//   EasyPost      /v2/trackers                flat                snake_case
//
// They do not share one shape, so the pick is real. EasyPost wins on three
// counts: its status vocabulary is nearly identical to ours (both derived from
// what carriers actually do, so the mapping is almost the identity and a bridge
// translates once rather than twice), flat JSON with Basic auth is the least
// work to impersonate, and it is the only vendor priced per-tracker with no
// monthly floor, so the driver is usable by someone who is not a storefront.
//
// A second format is a second file plus a row in AGGREGATORS — see index.ts.

import {
  CarrierError,
  type CarrierDriver,
  type ShipmentEvent,
  type ShipmentState,
  type ShipmentStatus,
} from "../status.js";
import { edgeFetch, edgeKeyFor, transitMode } from "./edge-transit.js";

const DEFAULT_BASE = "https://api.easypost.com/v2";
/** A tracker call can render a real page behind a bridge; bounded, but generous. */
const TIMEOUT_MS = 30_000;

function config() {
  // `||` not `??`: compose passes an unset var as "" (CLAUDE.md section 14.6).
  return {
    base: (process.env.COBBLR_TRACKING_API_URL || DEFAULT_BASE).trim().replace(/\/+$/, ""),
    key: (process.env.COBBLR_TRACKING_API_KEY || "").trim(),
  };
}

/** EasyPost's tracker statuses to ours. A table, so a status they add later
 *  falls through to a stated default rather than crashing or lying.
 *
 *  The three that are not the identity are the interesting ones, and all three
 *  mean "a person has to do something", which is what our `exception` says. */
const STATE_OF: Record<string, ShipmentState> = {
  unknown: "unknown",
  pre_transit: "pre_transit",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  available_for_pickup: "exception",
  return_to_sender: "exception",
  failure: "exception",
  cancelled: "exception",
  error: "exception",
};

interface EasyPostDetail {
  datetime?: string;
  message?: string;
  tracking_location?: { city?: string; state?: string; country?: string } | null;
}

interface EasyPostTracker {
  status?: string;
  status_detail?: string;
  est_delivery_date?: string | null;
  tracking_details?: EasyPostDetail[];
  /** When the SERVICE last asked the carrier. Not when we asked the service. */
  updated_at?: string | null;
}

function place(loc: EasyPostDetail["tracking_location"]): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.state].filter((p): p is string => !!p && p.trim().length > 0);
  if (parts.length === 0) return loc.country?.trim() || null;
  return parts.join(", ");
}

/** Read a tracker, treating it as untrusted input.
 *
 *  Exported and pure because this is where a wrong answer would do damage: the
 *  sweep acts on `state`, so anything unrecognised has to land on `unknown`
 *  rather than on something that closes an order still in a truck. */
export function parseTracker(
  raw: unknown,
  carrier: string,
  number: string,
  /** Fallback only: used when the endpoint does not say how old its data is. */
  calledAt: string,
): ShipmentStatus {
  const t = (raw ?? {}) as EasyPostTracker;

  const state: ShipmentState =
    typeof t.status === "string" ? (STATE_OF[t.status] ?? "unknown") : "unknown";

  // Newest first, which is how the panel reads them. EasyPost returns oldest
  // first, so this is a reverse rather than a sort: their order is already
  // chronological and re-sorting on a possibly-malformed date would be worse.
  const details = Array.isArray(t.tracking_details) ? t.tracking_details : [];
  const events: ShipmentEvent[] = details
    .filter((d) => typeof d?.datetime === "string" && d.datetime.length > 0)
    .map((d) => ({
      at: d.datetime as string,
      description: typeof d.message === "string" ? d.message : "",
      location: place(d.tracking_location),
    }))
    .reverse();

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  // When was the CARRIER asked — not when we asked whoever answered.
  //
  // Stamping our own request time is a lie whenever anything sits in between,
  // and something usually does: a bridge polling on its own schedule, or an
  // aggregator serving its cache. Measured against a real bridge, our stamp was
  // 38 minutes newer than the moment the data was actually gathered, and core
  // would have called a day-old cache fresh on every poll.
  //
  // The newest scan is a lower bound and beats nothing; our own clock is the
  // last resort, and the only case where "checked" honestly means "we called".
  const checkedAt = str(t.updated_at) ?? events[0]?.at ?? calledAt;

  return {
    carrier,
    number,
    state,
    description: str(t.status_detail) ?? str(t.status) ?? "",
    location: events[0]?.location ?? null,
    estimatedDelivery: str(t.est_delivery_date),
    // Only a delivered parcel has a delivery time, and the newest scan is when
    // it happened. A tracker that says in_transit and carries one has
    // contradicted itself; state is the field the sweep acts on, so believe it.
    deliveredAt: state === "delivered" ? (events[0]?.at ?? null) : null,
    events,
    checkedAt,
  };
}

/** Not a carrier: a stand-in for any of them. The registry treats it as the
 *  fallback rather than looking it up by carrier code. */
export const easypostCompatDriver: CarrierDriver = {
  code: "easypost-compat",

  configured() {
    return config().key.length > 0;
  },

  async track(number: string, carrierCode = "unknown", orgId = ""): Promise<ShipmentStatus> {
    const { base, key } = config();
    if (!key) throw new CarrierError("no tracking API key configured", false);

    const transit = transitMode();

    // Read before create. On real EasyPost creating a tracker is the billable
    // act, so a parcel already being followed must not be re-created on every
    // sweep; a bridge can answer this one call and ignore the other entirely.
    const path = `/trackers?tracking_code=${encodeURIComponent(number)}`;
    const headers = {
      Accept: "application/json",
      // EasyPost is HTTP Basic with the key as username and no password.
      Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
    };

    let res: Response;
    try {
      // A tracking service on the user's own network is unreachable from a
      // hosted Cobblr, so it rides their bridge instead. The bridge is handed
      // the base URL and does the call locally; nothing about it is
      // shipments-specific, which is why the bridge needs no support for this.
      res = transit.viaBridge
        ? await edgeFetch(edgeKeyFor(orgId, transit.named), base, path, { method: "GET", headers })
        : await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      // A bridge on a laptop is allowed to be off. Retryable, never a state.
      throw new CarrierError(`tracking API did not answer: ${(err as Error).message}`, true);
    }

    if (res.status === 401 || res.status === 403) {
      throw new CarrierError(`tracking API rejected the key (HTTP ${res.status})`, false);
    }
    if (res.status === 507) {
      // Insufficient Storage: the service is at capacity. A distinct failure
      // from "it could not answer" — the user has to free a slot or upgrade,
      // and silence would leave them with no idea why nothing is tracked.
      const full = new CarrierError("the tracking service is at capacity", false);
      (full as CarrierError & { quotaExhausted?: boolean }).quotaExhausted = true;
      throw full;
    }
    if (!res.ok) {
      throw new CarrierError(
        `tracking API failed (HTTP ${res.status})`,
        res.status >= 500 || res.status === 429,
      );
    }

    const body = (await res.json().catch(() => null)) as
      | { trackers?: unknown[] }
      | EasyPostTracker
      | null;
    if (body === null) throw new CarrierError("tracking API returned invalid JSON", true);

    // The list shape when asked by tracking_code; a single tracker when a
    // bridge chooses to answer directly. Accept both, so a bridge author does
    // not have to fake an envelope to be understood.
    const list = (body as { trackers?: unknown[] }).trackers;
    const tracker = Array.isArray(list) ? list[0] : body;

    if (!tracker) {
      // Nobody is following this number yet. Honest "no information" rather
      // than an error: the parcel is real, we just have nothing on it.
      return parseTracker({ status: "unknown" }, carrierCode, number, new Date().toISOString());
    }

    return parseTracker(tracker, carrierCode, number, new Date().toISOString());
  },
};
