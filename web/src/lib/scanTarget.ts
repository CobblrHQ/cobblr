// Scan into what is open. A page that takes scanned things (a printer's
// Loaded panel: scan a spool = load it) says so while it is on screen, and a
// scanned label for a thing it takes goes to it instead of opening that
// thing's page. Anything else scanned still opens as always.
//
// One target at a time, the last one mounted: the page you are looking at.

import { useEffect, useRef } from "react";
import { api } from "./api";
import { qrTokenFromUrl } from "@cobblr/platform-contract/qr-token";

export interface ScannedThing {
  kind: string;
  id: string;
  label: string;
}

export interface ScanTarget {
  /** Does this page take that kind of thing? */
  takes(kind: string): boolean;
  /** Take it. Resolves with the sentence to show ("Loaded Black PLA in slot 2"). */
  take(thing: ScannedThing): Promise<string>;
}

let current: ScanTarget | null = null;

export function currentScanTarget(): ScanTarget | null {
  return current;
}

/** While mounted, scans of things `target` takes go to it. */
export function useScanTarget(target: ScanTarget | null): void {
  const ref = useRef(target);
  ref.current = target;
  const on = target != null;
  useEffect(() => {
    if (!on) return;
    const mine: ScanTarget = { takes: (k) => ref.current?.takes(k) ?? false, take: (t) => ref.current!.take(t) };
    current = mine;
    return () => {
      if (current === mine) current = null;
    };
  }, [on]);
}

/** What a scanned code names in this workspace: a Cobblr label, else an
 *  identifier a record declares (a serial, a lot code). Null when it names
 *  nothing, or several. */
export async function resolveScannedThing(slug: string, code: string): Promise<ScannedThing | null> {
  const token = qrTokenFromUrl(code);
  if (token) {
    const r = await api.resolveQrToken(token).catch(() => null);
    if (!r?.entity_kind || !r.entity_id || (r.org_slug && r.org_slug !== slug)) return null;
    return { kind: r.entity_kind, id: r.entity_id, label: "" };
  }
  const out = await api.scanResolveExternal(slug, code).catch(() => null);
  return out?.outcome === "resolved" ? { kind: out.entity_kind, id: out.entity_id, label: out.entity_label } : null;
}
