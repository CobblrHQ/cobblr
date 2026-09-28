// Where a second AI connection could stand behind a first one.
//
// When a workspace's only AI was busy for an hour, the person had a second AI
// connected the whole time; it was routed to no workspace, so the fallback
// that tries the next AI had nothing to try (#3819). The card said "Not used
// in any workspace" in small grey type and offered nothing to do about it.
// This names, per connection, each workspace where ANOTHER of your AI
// connections answers and this one does not, with the reach the other one has
// there, so the card can offer it as the backup in one press.
import type { ConnRoute, ConnRouteMode } from "./api";

export interface BackupConn {
  id: string;
  kind: string;
  label?: string | null;
  provider_id: string;
  routes: ConnRoute[];
}

export interface BackupOffer {
  org_id: string;
  /** The same reach the connection it would back up has in that workspace. */
  mode: ConnRouteMode;
  /** Which of your connections already answers there. */
  behind: string;
}

export function backupOffers(conns: readonly BackupConn[], labelOf: (c: BackupConn) => string): Map<string, BackupOffer[]> {
  const ai = conns.filter((c) => c.kind === "ai-provider");
  const out = new Map<string, BackupOffer[]>();
  for (const c of ai) {
    const mine = new Set(c.routes.map((r) => r.org_id));
    const offers: BackupOffer[] = [];
    for (const o of ai) {
      if (o.id === c.id) continue;
      for (const r of o.routes) {
        if (mine.has(r.org_id) || offers.some((x) => x.org_id === r.org_id)) continue;
        offers.push({ org_id: r.org_id, mode: r.mode, behind: labelOf(o) });
      }
    }
    if (offers.length) out.set(c.id, offers);
  }
  return out;
}
