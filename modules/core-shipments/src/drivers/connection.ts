// Where a tracking service's address and key come from.
//
// Two sources, and the order matters:
//
//   1. A PERSONAL connection the user added under /me/connections
//   2. The instance's own environment (COBBLR_TRACKING_API_*)
//
// Personal wins, because a parcel belongs to a person. On a hosted Cobblr the
// environment belongs to whoever runs the server, so an env-only design means
// following your own parcels requires an operator to add your key to their box
// — fine for a self-hoster, useless for everyone else. This is the same choice
// AI made: the workspace has a default, and your own connection overrides it.
//
// Everything here is per-CALL rather than per-process. A sweep walks several
// workspaces and several people's parcels in one tick, so "which key" is a
// property of the parcel being followed, never of the running server.

import { platform } from "@cobblr/platform-contract";

/** The kind this module registers + resolves under. */
export const TRACKING_KIND = "parcel-tracking";

/** The provider a user picks when adding a personal tracking connection.
 *
 *  One entry, not one per vendor: the driver speaks a WIRE FORMAT (see
 *  easypost-compat.ts), so the same fields describe EasyPost itself and any
 *  service that answers the same shape. A second entry here would mean a second
 *  format, not a second vendor. */
export const TRACKING_PROVIDER = {
  id: "easypost-compat",
  kind: TRACKING_KIND,
  label: "Parcel tracking (EasyPost-compatible)",
  blurb:
    "A tracking service that answers EasyPost's format. Point it at EasyPost, " +
    "or at something of your own that speaks the same shape.",
  credentials: {
    api_key: { label: "API key", secret: true },
    base_url: { label: "Base URL (blank = EasyPost)", secret: false },
    transit: { label: "Reach it through your edge bridge? (blank / bridge)", secret: false },
  },
} as const;

export function registerTrackingConnection(): void {
  platform().connections.registerProvider({ ...TRACKING_PROVIDER });
}

export interface TrackingConfig {
  base: string;
  key: string;
  /** Route through a bridge rather than fetching directly. */
  viaBridge: boolean;
  /** A named bridge, for a workspace running more than one. */
  named: string;
  /** Whose bridge. Set only for a personal connection — the owner's tunnel is
   *  keyed by user, so this overrides the caller for routing purposes. */
  ownerUserId: string | null;
  /** The URL came from a USER, not from the instance's environment.
   *
   *  This decides whether the fetch is SSRF-guarded. An operator setting an env
   *  var is configuring their own server and is trusted infrastructure; a user
   *  typing a URL into a form is not, and on a hosted Cobblr that URL could name
   *  an internal address the server can reach and they cannot. CLAUDE.md 14.1
   *  draws exactly this line. */
  userSupplied: boolean;
}

const DEFAULT_BASE = "https://api.easypost.com/v2";

/** Parse a transit setting shared by both sources: "" / absent = direct,
 *  "bridge" = the default bridge, "bridge:<id>" = a named one. */
export function parseTransit(raw: string): { viaBridge: boolean; named: string } {
  const t = (raw || "").trim();
  if (!t.startsWith("bridge")) return { viaBridge: false, named: "" };
  return { viaBridge: true, named: t.startsWith("bridge:") ? t.slice(7).slice(0, 60) : "" };
}

/** The instance-wide config, which is what a self-hosted box uses.
 *
 *  `||` not `??` throughout: compose passes an unset var as "" rather than
 *  undefined, so `??` would keep the empty string (CLAUDE.md section 14.6). */
export function envConfig(): TrackingConfig {
  const t = parseTransit(process.env.COBBLR_TRACKING_API_TRANSIT || "");
  return {
    base: (process.env.COBBLR_TRACKING_API_URL || DEFAULT_BASE).trim().replace(/\/+$/, ""),
    key: (process.env.COBBLR_TRACKING_API_KEY || "").trim(),
    viaBridge: t.viaBridge,
    named: t.named,
    // The environment belongs to the instance, not to a person, so a bridge it
    // names is a WORKSPACE bridge. Only a personal connection sets an owner.
    ownerUserId: null,
    // An operator configuring their own server is trusted infrastructure.
    userSupplied: false,
  };
}

/** A personal connection as a config, or null when the user has none. */
export function configFromConnection(c: {
  credentials: Record<string, unknown>;
  ownerUserId: string;
}): TrackingConfig | null {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const key = str(c.credentials.api_key);
  // A connection with no key cannot be used for anything. Falling back to the
  // instance's key would silently spend someone else's quota on this person's
  // parcels, so it is treated as absent instead.
  if (!key) return null;
  const t = parseTransit(str(c.credentials.transit));
  return {
    base: (str(c.credentials.base_url) || DEFAULT_BASE).replace(/\/+$/, ""),
    key,
    viaBridge: t.viaBridge,
    named: t.named,
    ownerUserId: c.ownerUserId,
    userSupplied: true,
  };
}

/** The config for one call: the parcel owner's own connection if they have
 *  one, else the instance's.
 *
 *  A resolve failure is never fatal here — the personal layer is an override,
 *  so anything unexpected falls through to the environment, which is exactly
 *  the behaviour that existed before personal connections did. */
export async function configFor(route?: {
  orgId?: string;
  ownerUserId?: string | null;
}): Promise<TrackingConfig> {
  const orgId = route?.orgId ?? "";
  if (orgId) {
    try {
      const found = await platform().connections.resolve(
        TRACKING_KIND,
        orgId,
        route?.ownerUserId ?? null,
      );
      const cfg = found ? configFromConnection(found) : null;
      if (cfg) return cfg;
    } catch {
      // fall through to the environment
    }
  }
  return envConfig();
}
