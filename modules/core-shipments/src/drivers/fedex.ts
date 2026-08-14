// FedEx, via the Track API.
//
// Free to call: FedEx gates its label and shipping APIs and gives tracking
// away (the "Basic Integrated Visibility" product, 100k calls/day). Auth is
// OAuth 2.0 client-credentials against a key pair from a developer project.
//
// ⚠️ The SANDBOX IS A FIXTURE. It returns the same canned response for every
// tracking number, including numbers that do not exist. So a test pointed at
// sandbox passes whatever the mapping below does, and would keep passing if
// this file ignored the response entirely. Sandbox proves auth and wire-up and
// nothing else; the mapping is tested against recorded responses instead.

import {
  CarrierError,
  type CarrierDriver,
  type ShipmentEvent,
  type ShipmentState,
  type ShipmentStatus,
} from "../status.js";

const HOSTS = {
  sandbox: "https://apis-sandbox.fedex.com",
  production: "https://apis.fedex.com",
};

/** Env, read at call time rather than at import, so a key added to a running
 *  deployment's environment does not need a code change to be noticed. */
function config() {
  // `||` not `??`: compose passes an unset var as "", which `??` would keep.
  // (CLAUDE.md section 14.6.)
  const key = process.env.COBBLR_FEDEX_API_KEY || "";
  const secret = process.env.COBBLR_FEDEX_SECRET_KEY || "";
  const env = process.env.COBBLR_FEDEX_ENV || "production";
  return { key, secret, host: env === "sandbox" ? HOSTS.sandbox : HOSTS.production };
}

/** FedEx tokens last an hour. Cached in memory with a minute of headroom, so a
 *  daily sweep over many orders costs one token rather than one per parcel. */
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;

  const { key, secret, host } = config();
  const res = await fetch(`${host}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: key,
      client_secret: secret,
    }),
  });

  if (!res.ok) {
    // Deliberately does not include the response body: FedEx echoes request
    // parameters in some error shapes, and the request carried the secret.
    throw new CarrierError(
      `FedEx rejected the credentials (HTTP ${res.status})`,
      // 401/400 means the keys are wrong and will still be wrong in an hour.
      res.status >= 500,
    );
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new CarrierError("FedEx returned no access token", true);

  cached = {
    token: body.access_token,
    expiresAt: now + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

/** FedEx's derived status codes to ours.
 *
 *  A TABLE, not a switch: adding a code is adding a row, and an unlisted code
 *  falls through to a stated default rather than to a crash. FedEx publishes
 *  more codes than this; the ones absent here are all varieties of "moving",
 *  which is what the default says. */
const FEDEX_STATE: Record<string, ShipmentState> = {
  DL: "delivered",
  OD: "out_for_delivery",
  IT: "in_transit",
  PU: "in_transit", // picked up
  AR: "in_transit", // arrived at a facility
  DP: "in_transit", // departed a facility
  IN: "pre_transit", // initiated
  OC: "pre_transit", // order/label created
  AA: "in_transit", // at airport
  HL: "exception", // held at location, someone must collect it
  DY: "exception", // delayed
  DE: "exception", // delivery exception
  SE: "exception", // shipment exception
  CA: "exception", // cancelled
  RS: "exception", // return to shipper
};

interface FedexScanEvent {
  date?: string;
  eventDescription?: string;
  derivedStatusCode?: string;
  scanLocation?: { city?: string; stateOrProvinceCode?: string; countryCode?: string };
}

interface FedexTrackResult {
  latestStatusDetail?: {
    derivedCode?: string;
    code?: string;
    statusByLocale?: string;
    description?: string;
    scanLocation?: { city?: string; stateOrProvinceCode?: string; countryCode?: string };
  };
  dateAndTimes?: { type?: string; dateTime?: string }[];
  scanEvents?: FedexScanEvent[];
  error?: { code?: string; message?: string } | null;
}

function place(loc: FedexScanEvent["scanLocation"]): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.stateOrProvinceCode].filter(Boolean);
  // A country on its own is worth showing for an international leg; a country
  // appended to a city and state is noise.
  if (parts.length === 0) return loc.countryCode ?? null;
  return parts.join(", ");
}

/** Pull one labelled timestamp out of FedEx's flat date list. */
function dateOfType(times: FedexTrackResult["dateAndTimes"], type: string): string | null {
  return times?.find((d) => d.type === type)?.dateTime ?? null;
}

export function parseTrackResult(number: string, result: FedexTrackResult, checkedAt: string): ShipmentStatus {
  // FedEx reports a bad or unknown number as an error INSIDE a 200. Reading
  // only the HTTP status would call that success and hand back a blank parcel.
  if (result.error) {
    return {
      carrier: "fedex",
      number,
      state: "unknown",
      description: result.error.message ?? "FedEx has no information for this number",
      location: null,
      estimatedDelivery: null,
      deliveredAt: null,
      events: [],
      checkedAt,
    };
  }

  const latest = result.latestStatusDetail;
  const code = latest?.derivedCode ?? latest?.code ?? "";
  // Unlisted codes are the many flavours of "on its way". Defaulting to
  // in_transit keeps the parcel being watched; defaulting to delivered or
  // unknown would either close it early or stop looking.
  const state: ShipmentState = FEDEX_STATE[code] ?? (code ? "in_transit" : "unknown");

  const events: ShipmentEvent[] = (result.scanEvents ?? [])
    .filter((e) => e.date)
    .map((e) => ({
      at: e.date!,
      description: e.eventDescription ?? "",
      location: place(e.scanLocation),
    }));

  const deliveredAt =
    state === "delivered"
      ? (dateOfType(result.dateAndTimes, "ACTUAL_DELIVERY") ?? events[0]?.at ?? null)
      : null;

  return {
    carrier: "fedex",
    number,
    state,
    description: latest?.statusByLocale || latest?.description || "",
    location: place(latest?.scanLocation),
    estimatedDelivery:
      dateOfType(result.dateAndTimes, "ESTIMATED_DELIVERY") ??
      dateOfType(result.dateAndTimes, "ANTICIPATED_TENDER"),
    deliveredAt,
    events,
    checkedAt,
  };
}

export const fedexDriver: CarrierDriver = {
  code: "fedex",

  configured() {
    const { key, secret } = config();
    return key.length > 0 && secret.length > 0;
  },

  async track(number: string): Promise<ShipmentStatus> {
    const { host } = config();
    const token = await accessToken();

    const res = await fetch(`${host}/track/v1/trackingnumbers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-locale": "en_US",
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }],
      }),
    });

    if (res.status === 401) {
      // The cached token went stale early. Drop it so the next call re-auths
      // rather than looping on a token FedEx has stopped honouring.
      cached = null;
      throw new CarrierError("FedEx rejected the access token", true);
    }
    if (!res.ok) {
      throw new CarrierError(`FedEx track failed (HTTP ${res.status})`, res.status >= 500 || res.status === 429);
    }

    const body = (await res.json()) as {
      output?: { completeTrackResults?: { trackResults?: FedexTrackResult[] }[] };
    };
    const result = body.output?.completeTrackResults?.[0]?.trackResults?.[0];
    if (!result) throw new CarrierError("FedEx returned no track result", true);

    return parseTrackResult(number, result, new Date().toISOString());
  },
};
