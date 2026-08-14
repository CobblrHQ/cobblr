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
  const name = (process.env.COBBLR_TRACKING_API || DEFAULT_AGGREGATOR).trim().toLowerCase();
  const driver = AGGREGATORS[name];
  return driver?.configured() ? driver : null;
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

/** True when an aggregator is configured, so the UI can say that a carrier with
 *  no driver of its own is still followable. */
export function aggregatorConfigured(): boolean {
  return aggregatorDriver() !== null;
}
