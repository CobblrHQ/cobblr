// Is this address on the person's own network, and so out of reach of a
// hosted Cobblr without a bridge?
//
// Every form that takes a device's address asks this: Part-DB, Homebox, a sync
// connection, a print manager, a network printer, a machine's own controller.
// Before this lived here, two forms had their own copy of the rule and the
// rest had none, so typing 192.168.1.50 into Part-DB did nothing until the
// import failed with a raw "fetch failed" (#3904). The copies also disagreed
// with the kernel: neither knew the tailnet range (100.64/10), which the
// hosted egress guard blocks.
//
// Built on `isPrivateIp`, the one rule the egress guard uses, so "the form
// says it needs a bridge" and "the server refuses to fetch it directly" can
// never disagree about an IP. Pure, for the browser and the api alike.

import { ipFamily, isPrivateIp } from "@cobblr/platform-contract/private-ip";

/** Where an address points, as far as its text can tell. */
export type AddressReach =
  | { kind: "empty" }
  /** On the person's own network: a private or tailnet IP, a loopback, a
   *  `.local` name, or a bare machine name with no dots. */
  | { kind: "home"; host: string; why: "private-ip" | "local-name" | "machine-name" }
  /** A public name or IP the internet can reach. */
  | { kind: "public"; host: string };

/** Suffixes that only ever resolve inside a home or office network. */
const LOCAL_SUFFIXES = [".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain", ".localhost"];

function hostOf(raw: string): string {
  const text = raw.trim();
  let host = text;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname;
  } catch {
    host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/:?#]/)[0] ?? "";
  }
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** What an address the person typed points at. Tolerates a missing scheme,
 *  a port and a path: `192.168.1.50:8080/partdb` is a home address. */
export function addressReach(raw: string): AddressReach {
  if (!raw.trim()) return { kind: "empty" };
  const host = hostOf(raw);
  if (!host) return { kind: "empty" };
  if (ipFamily(host) !== 0) return isPrivateIp(host) ? { kind: "home", host, why: "private-ip" } : { kind: "public", host };
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return { kind: "home", host, why: "local-name" };
  if (!host.includes(".")) return { kind: "home", host, why: "machine-name" };
  return { kind: "public", host };
}

/** Does reaching this address from THIS Cobblr need a bridge on the person's
 *  network? Only a hosted Cobblr needs one: a self-hosted box usually sits on
 *  the same network as the device and reaches it directly. */
export function needsBridge(raw: string, opts: { hosted: boolean }): boolean {
  return opts.hosted && addressReach(raw).kind === "home";
}
