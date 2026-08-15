// The driver registry. Two kinds of driver, one interface, both tables.
//
//   CARRIER drivers      speak ONE carrier's own API (fedex)
//   AGGREGATOR drivers   speak one tracking-API WIRE FORMAT and serve any
//                        carrier (easypost-compat)
//
// Adding either is a file plus a row here; nothing branches on a name. That is
// the same shape as core-ai's providers, where "which wire format" and "which
// endpoint" are separate knobs, so a local bridge is just an endpoint that
// speaks a format core already knows.
//
//   COBBLR_TRACKING_API      which wire format        (default easypost)
//   COBBLR_TRACKING_API_URL  where it lives           (default per format)
//   COBBLR_TRACKING_API_KEY  the key it wants
//
// A carrier's own driver wins where one is configured: it is first-hand, where
// an aggregator is a third party reading the same data.

import type { CarrierDriver } from "../status.js";
import { fedexDriver } from "./fedex.js";
import { easypostCompatDriver } from "./easypost-compat.js";

/** One carrier each. */
const CARRIER_DRIVERS: CarrierDriver[] = [fedexDriver];

/** One wire format each, any carrier. Keyed by the name COBBLR_TRACKING_API
 *  takes, so adding AfterShip's format later is a file and a row. */
const AGGREGATORS: Record<string, CarrierDriver> = {
  easypost: easypostCompatDriver,
};

const DEFAULT_AGGREGATOR = "easypost";

/** The configured aggregator, or null when none is set up.
 *
 *  An unknown name is null rather than a silent fall back to the default: an
 *  operator who typed `COBBLR_TRACKING_API=aftership` before that exists is
 *  better served by "nothing is connected" than by quietly getting a different
 *  vendor's client pointed at their URL. */
export function aggregatorDriver(): CarrierDriver | null {
  const driver = aggregatorCandidate();
  return driver?.configured() ? driver : null;
}

/** The aggregator this build would use, set up or not. */
function aggregatorCandidate(): CarrierDriver | null {
  const name = (process.env.COBBLR_TRACKING_API || DEFAULT_AGGREGATOR).trim().toLowerCase();
  return AGGREGATORS[name] ?? null;
}

/** Is this driver set up for THIS parcel — the instance's credentials, or the
 *  owner's own connection? A driver with only instance-wide credentials has no
 *  per-parcel answer to give, so its `configured()` stands. */
async function usable(
  driver: CarrierDriver,
  route: { orgId?: string; ownerUserId?: string | null },
): Promise<boolean> {
  return driver.configuredFor ? await driver.configuredFor(route) : driver.configured();
}

/** Can an aggregator answer for THIS caller — the instance's credentials, or
 *  their own connection? What the settings page asks: an aggregator makes every
 *  recognised carrier followable, so this is "is tracking live for me". */
export async function aggregatorConnectedFor(route: {
  orgId?: string;
  ownerUserId?: string | null;
}): Promise<boolean> {
  const agg = aggregatorCandidate();
  return agg ? await usable(agg, route) : false;
}

/** Who should answer for this carrier ON THIS PARCEL, and whether they can.
 *
 *  The route-aware twin of `driverFor`, and the one the action handler uses.
 *  Once a credential can belong to a person, "is tracking connected here" has
 *  no single answer — it depends whose parcel is being followed. An
 *  instance-only check would tell someone who connected their own service that
 *  nothing is connected, which is the bug this exists to prevent. */
export async function driverForRoute(
  code: string,
  route: { orgId?: string; ownerUserId?: string | null },
): Promise<{ driver: CarrierDriver | null; connected: boolean }> {
  const own = CARRIER_DRIVERS.find((d) => d.code === code);
  // A carrier's own driver is first-hand where an aggregator reads the same
  // data second-hand, so it keeps winning wherever one is set up.
  if (own && (await usable(own, route))) return { driver: own, connected: true };

  const agg = aggregatorCandidate();
  if (agg && (await usable(agg, route))) return { driver: agg, connected: true };

  // Same distinction driverFor makes: an unconfigured carrier driver lets the
  // caller say "FedEx is not connected here" rather than the vaguer "we cannot
  // follow FedEx" — different things for a person to do about it.
  return { driver: own ?? null, connected: false };
}

/** The wire formats this build can speak, for diagnostics and the settings UI. */
export function aggregatorNames(): string[] {
  return Object.keys(AGGREGATORS);
}

/** Who should answer for this carrier, or null when nobody can.
 *
 *  Null stays the normal case: detection recognises seven carriers, most
 *  deployments configure none of this, and a recognised carrier with no driver
 *  still gets its tracking link — most of the value for none of the setup. */
export function driverFor(code: string): CarrierDriver | null {
  const own = CARRIER_DRIVERS.find((d) => d.code === code);
  if (own?.configured()) return own;

  const agg = aggregatorDriver();
  if (agg) return agg;

  // Return the unconfigured carrier driver rather than null, so the caller can
  // say "FedEx is not connected here" instead of the vaguer "we cannot follow
  // FedEx" — different things for the user to do about it.
  return own ?? null;
}

/** Which carriers this deployment can actually follow, as opposed to merely
 *  name. Drives the "connect a carrier" surface: a driver that exists but has
 *  no credentials must read as "available, not set up", never as absent.
 *
 *  A configured aggregator makes every carrier followable, which is the whole
 *  reason for having one. */
export function driverStatus(): { code: string; configured: boolean }[] {
  const viaAggregator = aggregatorDriver() !== null;
  return CARRIER_DRIVERS.map((d) => ({ code: d.code, configured: d.configured() || viaAggregator }));
}
