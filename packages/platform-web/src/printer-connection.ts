// How a printer is reached — the thing that tells two entries for the SAME
// machine apart.
//
// One physical printer can legitimately appear more than once. A PM220S paired
// to this Mac shows up twice: once through the bridge on that Mac, once through
// this browser's own Bluetooth. Same name, same hardware, completely different
// reach — one keeps working when the tab closes, the other does not. The picker
// showed both as "PM220S" and, once a status reading arrived, replaced the
// connection line with the reading, so the only distinguishing fact disappeared
// exactly when the printer was working well enough to report.
//
// It also has to survive more bridges than one. A second bridge on a Pi, or one
// reached through the cloud tunnel, is a different route to a possibly different
// printer of the same model — "via edge bridge" would name both. So a bridge
// says WHICH bridge whenever it can.

import { isEdgeManagerUrl } from "@cobblr/platform-contract/edge-bridge-client";

/** The stable identity of a printer's route, for grouping and comparison. */
export type PrinterReach =
  | { kind: "browser" }
  | { kind: "bridge-local" }
  | { kind: "bridge-named"; name: string }
  | { kind: "bridge" }
  | { kind: "network" };

interface PrinterLike {
  driver: string;
  base_url?: string | null;
  settings?: Record<string, unknown> | null;
  /** Not used for the route, but declared so callers can pass a whole printer
   *  record without tripping excess-property checking on a literal. */
  name?: string;
}

function bridgeOf(p: PrinterLike): { bridgeUrl?: unknown; bridgeName?: unknown } | null {
  const b = (p.settings ?? {}).bridge as { bridgeUrl?: unknown; bridgeName?: unknown } | undefined;
  return b && typeof b === "object" ? b : null;
}

export function printerReach(p: PrinterLike): PrinterReach {
  // The browser drivers hold the radio in the tab itself.
  if (p.driver === "browser-bluetooth" || p.driver === "browser-serial") return { kind: "browser" };
  const b = bridgeOf(p);
  // A local bridge is addressed directly because it is on this machine.
  if (typeof b?.bridgeUrl === "string" && b.bridgeUrl) return { kind: "bridge-local" };
  // A named bridge rides the cloud tunnel — the name is the workspace's own
  // label for that machine, which is exactly what distinguishes a Pi in the
  // workshop from the laptop on the desk.
  if (typeof b?.bridgeName === "string" && b.bridgeName) return { kind: "bridge-named", name: b.bridgeName };
  if (isEdgeManagerUrl(p.base_url)) return { kind: "bridge" };
  return { kind: "network" };
}

/** One short line naming the route, for under a printer's name.
 *
 *  Deliberately never says "Bluetooth", "serial", or "RFCOMM". Which radio we
 *  ended up using is our implementation detail; what the person chose, and what
 *  actually changes their life, is whether it goes through their browser or
 *  through a helper that keeps running without it. */
export function printerConnectionLabel(p: PrinterLike): string {
  const r = printerReach(p);
  switch (r.kind) {
    case "browser":
      return "via this browser";
    case "bridge-local":
      return "via bridge on this computer";
    case "bridge-named":
      return `via bridge · ${r.name}`;
    case "bridge":
      return "via edge bridge";
    default:
      return "Network";
  }
}

/** True when the tab itself holds the connection, so it dies on refresh and no
 *  other tab can use it. The one difference worth warning about. */
export function isTabHeldConnection(p: PrinterLike): boolean {
  return printerReach(p).kind === "browser";
}

/** Two entries that are the same MACHINE reached different ways.
 *
 *  Used to decide when the route is worth spelling out: with one PM220S there is
 *  nothing to disambiguate, with two there is. */
export function hasDuplicateName<T extends PrinterLike & { name: string }>(printers: T[], p: T): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  return printers.some((o) => o !== p && norm(o.name) === norm(p.name));
}
