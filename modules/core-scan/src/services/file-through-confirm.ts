// Filing an inbox item from another route, through the same confirm door a
// person's Add uses.
//
// The confirm route re-issues the create against the api with the caller's
// own bearer token, so role gating and every module's own validation fire on
// the target. A route that wants to file (File all, an accepted put-away
// group) does the same: it calls confirm, it never writes another module's
// table. The candidate carries its own module, kind and instance; core-scan
// never names another module here.
//
// A candidate routed at a flagship bundle's table that is not installed yet
// installs it first (the same quickstart door the session's File all uses),
// once per bundle, and keeps the instance the install REALLY made: a bundle
// that skins a module's default table makes no instance, and filing with the
// candidate's routing token would ask for one that was never created.

import { displayName } from "@cobblr/platform-contract/display-identity";
import { filedQuantityOf } from "./filed-quantity.js";

export interface FilingCandidate {
  module?: string;
  kind?: string;
  instance?: string | null;
  bundle_external_id?: string | null;
  label?: string;
  fields?: Record<string, unknown>;
}

export interface FilingRow {
  id: string;
  suggested_name: string | null;
  /** Carries a person's own name, which files over the column (#2982). */
  suggested_metadata?: unknown;
  quantity: number | null;
  suggested_candidates: unknown;
}

export type FilingOutcome =
  | { ok: true; item_id: string; name: string; entity_id: string | null; entity_kind: string | null }
  | { ok: false; item_id: string; name: string | null; reason: string };

export interface FilingDoor {
  baseUrl: string;
  slug: string;
  authHeaders: Record<string, string>;
  /** Owner or admin: filing into a table that needs a bundle installs it. */
  canInstall: boolean;
}

/** The instance a bundle's table lives under once installed, memoised per
 *  bundle for one request. `null` instance = the bundle skins the default. */
export class BundleInstaller {
  private readonly done = new Map<string, { ok: true; instance: string | null } | { ok: false; reason: string }>();
  /** Bundles this request actually installed on the way (not ones already there). */
  readonly installed: Array<{ bundle_external_id: string; label: string }> = [];
  constructor(private readonly door: FilingDoor) {}

  async instanceFor(bundleId: string, label: string): Promise<{ ok: true; instance: string | null } | { ok: false; reason: string }> {
    const memo = this.done.get(bundleId);
    if (memo) return memo;
    let out: { ok: true; instance: string | null } | { ok: false; reason: string };
    if (!this.door.canInstall) {
      out = { ok: false, reason: `needs the ${label} table, which an owner or admin can install` };
    } else {
      try {
        const r = await fetch(`${this.door.baseUrl}/api/v1/orgs/${this.door.slug}/quickstart/materialize`, {
          method: "POST",
          headers: this.door.authHeaders,
          body: JSON.stringify({ bundle_external_id: bundleId, item_ids: [] }),
        });
        if (!r.ok) throw new Error(`install ${r.status}`);
        const body = (await r.json()) as { instance?: string | null; installed?: unknown };
        if (body.installed) this.installed.push({ bundle_external_id: bundleId, label });
        out = { ok: true, instance: body.instance ?? null };
      } catch (err) {
        out = { ok: false, reason: `could not install ${label}: ${(err as Error).message}` };
      }
    }
    this.done.set(bundleId, out);
    return out;
  }
}

export function topCandidate(row: FilingRow): FilingCandidate | null {
  const cands = Array.isArray(row.suggested_candidates) ? (row.suggested_candidates as FilingCandidate[]) : [];
  return cands[0] ?? null;
}

/** Why an item cannot be filed right now, or null when it can. */
export function filingBlocker(row: FilingRow): string | null {
  if (!displayName(row)) return "needs a name";
  const cand = topCandidate(row);
  if (!cand || !cand.module || !cand.kind) return "needs a table to file into";
  return null;
}

export async function fileThroughConfirm(
  door: FilingDoor,
  installer: BundleInstaller,
  row: FilingRow,
  locationId: string | null,
  overrides: { quantity?: number } = {},
): Promise<FilingOutcome> {
  const blocker = filingBlocker(row);
  if (blocker) return { ok: false, item_id: row.id, name: displayName(row), reason: blocker };
  const cand = topCandidate(row)!;
  let instance = cand.instance ?? undefined;
  const bundleId = cand.bundle_external_id ?? null;
  if (bundleId) {
    const got = await installer.instanceFor(bundleId, cand.label ?? bundleId);
    if (!got.ok) return { ok: false, item_id: row.id, name: displayName(row), reason: got.reason };
    instance = got.instance ?? undefined;
  }
  try {
    const r = await fetch(`${door.baseUrl}/api/v1/orgs/${door.slug}/modules/core-scan/inbox/${row.id}/confirm`, {
      method: "POST",
      headers: door.authHeaders,
      body: JSON.stringify({
        target_module: cand.module,
        target_kind: cand.kind,
        ...(instance ? { instance } : {}),
        name: displayName(row),
        // A row's own count goes through the rule the door checks, so a row
        // that predates it never turns an auto-file into a bad request.
        quantity: overrides.quantity ?? (row.quantity == null ? undefined : filedQuantityOf(row.quantity)),
        extras: cand.fields ?? {},
        ...(locationId ? { location_id: locationId } : {}),
      }),
    });
    if (!r.ok) {
      let msg = `confirm ${r.status}`;
      try {
        const e = (await r.json()) as { error?: { message?: string } };
        if (e.error?.message) msg = e.error.message;
      } catch {
        /* the status is the message */
      }
      return { ok: false, item_id: row.id, name: displayName(row), reason: msg };
    }
    const body = (await r.json()) as { created?: { id?: string; kind?: string } | null; item?: { target_entity_id?: string | null; target_kind?: string | null; target_module?: string | null } };
    const entityId = body.created?.id ?? body.item?.target_entity_id ?? null;
    const tk = body.item?.target_kind ?? null;
    const entityKind = body.created?.kind ?? (tk ? (tk.includes(":") ? tk : body.item?.target_module ? `${body.item.target_module}:${tk}` : tk) : null);
    return { ok: true, item_id: row.id, name: displayName(row) ?? "", entity_id: entityId, entity_kind: entityKind };
  } catch (err) {
    return { ok: false, item_id: row.id, name: displayName(row), reason: (err as Error).message };
  }
}
