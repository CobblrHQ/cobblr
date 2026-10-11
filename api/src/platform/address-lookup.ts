// The map lookup behind the address picker: the seam a geocoder plugs into.
//
// None ships (#5317: our own Photon server was punted by the owner, and a
// public one is not called from a workspace without a decision). With no
// lookup set, the suggestions route says `lookup: null` and the picker offers
// the addresses this workspace already used and free text, and shows no map
// search at all: an option that can never answer is not offered.
//
// A lookup is operator-configured, so when one is wired it calls out with
// plain `fetch`, never guardedFetch (prod's strict egress policy).

import type { AddressValue } from "@cobblr/platform-contract/address";

export interface AddressLookup {
  /** What the picker calls it ("OpenStreetMap"). */
  name: string;
  /** Places matching what was typed, nearest `near` first when given. A slow
   *  or failed lookup throws; the caller answers with what it has. */
  suggest(query: string, opts: { near?: { lat: number; lon: number }; signal: AbortSignal }): Promise<AddressValue[]>;
}

let current: AddressLookup | null = null;

/** Set (or clear, with null) the lookup. Called once at boot by whatever
 *  wires one; nothing does yet. */
export function setAddressLookup(lookup: AddressLookup | null): void {
  current = lookup;
}

export function addressLookup(): AddressLookup | null {
  return current;
}

/** A lookup never holds the picker up: past this it is abandoned. */
export const LOOKUP_TIMEOUT_MS = 1500;
/** Fewer characters than this match too much to be worth a lookup. */
export const LOOKUP_MIN_CHARS = 3;
