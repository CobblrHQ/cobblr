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
import { filedQuantityOf, isOwnCopy } from "./filed-quantity.js";
import type { ScanResolverTable } from "@cobblr/platform-contract/scan-triage";
import { filingDestination, type DestinationRow } from "./destination.js";
import { apiFetch } from "@cobblr/platform-contract/self-api";

export interface FilingCandidate {
  module?: string;
  kind?: string;
  instance?: string | null;
  bundle_external_id?: string | null;
  label?: string;
  fields?: Record<string, unknown>;
  /** The record this row adds to instead of creating one (a re-purchase). */
  updates?: { kind: string; id: string; instance: string | null };
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
  /** The workspace's tables as the destination resolver reads them, so a
   *  row files where its card said it goes (services/destination.ts). */
  tables?: readonly ScanResolverTable[];
}

class Removed extends Error {}

/** The instance a bundle's table lives under once installed, memoised per
 *  bundle for one request. `null` instance = the bundle skins the default. */
export class BundleInstaller {
  private readonly done = new Map<string, { ok: true; instance: string | null } | { ok: false; reason: string }>();
  /** Bundles this request actually installed on the way (not ones already there). */
  readonly installed: Array<{ bundle_external_id: string; label: string }> = [];
  constructor(private readonly door: FilingDoor) {}

  /** Whether this person may install or turn on an app. */
  get mayInstall(): boolean {
    return this.door.canInstall;
  }

  async instanceFor(bundleId: string, label: string): Promise<{ ok: true; instance: string | null } | { ok: false; reason: string }> {
    const memo = this.done.get(bundleId);
    if (memo) return memo;
    let out: { ok: true; instance: string | null } | { ok: false; reason: string };
    if (!this.door.canInstall) {
      out = { ok: false, reason: `needs the ${label} table, which an owner or admin can install` };
    } else {
      try {
        const r = await apiFetch(`${this.door.baseUrl}/api/v1/orgs/${this.door.slug}/quickstart/materialize`, {
          method: "POST",
          headers: this.door.authHeaders,
          // Filing implies this install; it never brings back an app the
          // workspace removed (the route answers bundle_removed).
          body: JSON.stringify({ bundle_external_id: bundleId, item_ids: [], unless_removed: true }),
        });
        if (r.status === 409) {
          const e = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
          if (e.error?.code === "bundle_removed") throw new Removed(e.error.message ?? `${label} was removed from this workspace`);
        }
        if (!r.ok) throw new Error(`install ${r.status}`);
        const body = (await r.json()) as { instance?: string | null; installed?: unknown };
        if (body.installed) this.installed.push({ bundle_external_id: bundleId, label });
        out = { ok: true, instance: body.instance ?? null };
      } catch (err) {
        out = { ok: false, reason: err instanceof Removed ? `goes to ${label}, which was removed from this workspace; install it again to file here` : `could not install ${label}: ${(err as Error).message}` };
      }
    }
    this.done.set(bundleId, out);
    return out;
  }

  private modules: Promise<Array<{ name: string; displayName?: string; enabled?: boolean }> | null> | null = null;

  /** Whether `module` is on here, available to turn on, or absent from this
   *  deployment; null when the list could not be read (then nothing is
   *  refused on its account). */
  async moduleState(module: string): Promise<{ state: "enabled" | "available" | "absent"; label: string } | null> {
    this.modules ??= apiFetch(`${this.door.baseUrl}/api/v1/orgs/${this.door.slug}/modules`, { headers: this.door.authHeaders })
      .then(async (r) => (r.ok ? ((await r.json()) as { items: Array<{ name: string; displayName?: string; enabled?: boolean }> }).items : null))
      .catch(() => null);
    const list = await this.modules;
    if (!list) return null;
    const m = list.find((x) => x.name === module);
    if (!m) return { state: "absent", label: module };
    return { state: m.enabled ? "enabled" : "available", label: m.displayName ?? module };
  }

  /** Turn `module` on, through the same enable the Modules screen uses. */
  async enableModule(module: string, label: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.door.canInstall) return { ok: false, reason: `goes to ${label}, which an owner or admin can turn on` };
    try {
      const r = await apiFetch(`${this.door.baseUrl}/api/v1/orgs/${this.door.slug}/modules/${module}/enable`, { method: "POST", headers: this.door.authHeaders, body: "{}" });
      if (!r.ok) throw new Error(`enable ${r.status}`);
      this.modules = null;
      this.enabled.push({ module, label });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `could not turn on ${label}: ${(err as Error).message}` };
    }
  }

  /** Modules this request turned on along the way. */
  readonly enabled: Array<{ module: string; label: string }> = [];
}

/** Why a filing cannot reach its table, and what would: `remedy` is what a
 *  person who may not install could ask for. */
export type TableRefusal = { ok: false; reason: string; remedy?: { kind: "install" | "module"; key: string } };

/** The table a filing into (module, instance) lands in, with the flagship
 *  app behind it installed first when the workspace does not have it yet.
 *
 *  Every door files through the confirm route, and the confirm route asks
 *  this before it creates anything: File N, File all, one-tap Add, the
 *  dashboard's Add all, a put-away plan and the assistant alike. Each used to
 *  decide for itself whether to install first, and the quick ones did not, so
 *  a new workspace's first File on a scanned book answered "No instance
 *  'bookshelf'" and left it pending (#3604). The offer is the row's own: a
 *  candidate for that table carrying `bundle_external_id`. `instance` in the
 *  answer is the one the install REALLY made (null when the app skins the
 *  module's default table), else the one asked for. */
export async function tableForFiling(
  installer: BundleInstaller,
  candidates: readonly FilingCandidate[],
  want: { module: string; instance: string | null },
  live: ReadonlyArray<{ module: string; instance: string | null }>,
): Promise<{ ok: true; instance: string | null } | TableRefusal> {
  if (live.some((t) => t.module === want.module && (t.instance ?? null) === want.instance)) return { ok: true, instance: want.instance };
  const offer =
    candidates.find((c) => c.bundle_external_id && c.module === want.module && (c.instance ?? null) === want.instance) ??
    (want.instance ? candidates.find((c) => c.bundle_external_id && c.instance === want.instance) : undefined);
  if (offer?.bundle_external_id) {
    const got = await installer.instanceFor(offer.bundle_external_id, offer.label ?? offer.bundle_external_id);
    // Only a person who may not install has something to ask for; a failed
    // or refused install (an app the workspace removed) is said as it is.
    return got.ok ? got : installer.mayInstall ? got : { ...got, remedy: { kind: "install", key: offer.bundle_external_id } };
  }
  // No bundle offers it, but the table's app may simply be off here: the
  // same missing table, turned on for someone who may, asked for by
  // someone who may not, and another table when this deployment has no
  // such app at all (#3610). Filing into an app that is off met the
  // module gate's "Enable it in Configuration" and nothing else.
  const mod = await installer.moduleState(want.module);
  // Enabled, unknown, or not in this deployment at all: the door's own
  // target check answers the last (an unknown target kind), as before.
  if (!mod || mod.state !== "available") return { ok: true, instance: want.instance };
  const on = await installer.enableModule(want.module, mod.label);
  return on.ok ? { ok: true, instance: want.instance } : installer.mayInstall ? on : { ...on, remedy: { kind: "module", key: want.module } };
}

/** The table the row files into: the item's ONE destination, the card's
 *  own answer (services/destination.ts): a table the person chose however
 *  the router has re-ranked since (#3587), a better table the workspace
 *  gained (#3136), their typed values riding along (#3618). */
export function topCandidate(row: FilingRow, tables: readonly ScanResolverTable[] = []): FilingCandidate | null {
  return filingDestination(row as unknown as DestinationRow, tables) as FilingCandidate | null;
}

/** Why an item cannot be filed right now, or null when it can. */
export function filingBlocker(row: FilingRow, tables: readonly ScanResolverTable[] = []): string | null {
  if (!displayName(row)) return "needs a name";
  const cand = topCandidate(row, tables);
  if (!cand || !cand.module || !cand.kind) return "needs a table to file into";
  return null;
}

export async function fileThroughConfirm(
  door: FilingDoor,
  installer: BundleInstaller,
  row: FilingRow,
  locationId: string | null,
  overrides: { quantity?: number; container?: { kind: string; id: string } } = {},
): Promise<FilingOutcome> {
  const blocker = filingBlocker(row, door.tables);
  if (blocker) return { ok: false, item_id: row.id, name: displayName(row), reason: blocker };
  const cand = topCandidate(row, door.tables)!;
  // A re-purchase adds to the record it matched, the way the card's +1 more
  // does: filing it through confirm made a second milk beside the first in
  // the very table the card named (#3707).
  if (cand.updates) return addToRecord(door, row, cand.updates, overrides.quantity ?? (row.quantity == null ? 1 : filedQuantityOf(row.quantity)));
  let instance = cand.instance ?? undefined;
  const bundleId = cand.bundle_external_id ?? null;
  if (bundleId) {
    const got = await installer.instanceFor(bundleId, cand.label ?? bundleId);
    if (!got.ok) return { ok: false, item_id: row.id, name: displayName(row), reason: got.reason };
    instance = got.instance ?? undefined;
  }
  try {
    const r = await apiFetch(`${door.baseUrl}/api/v1/orgs/${door.slug}/modules/core-scan/inbox/${row.id}/confirm`, {
      method: "POST",
      headers: door.authHeaders,
      body: JSON.stringify({
        target_module: cand.module,
        target_kind: cand.kind,
        ...(instance ? { instance } : {}),
        name: displayName(row),
        // A row's own count goes through the rule the door checks, so a row
        // that predates it never turns an auto-file into a bad request.
        // An own copy files its own count, 0 included (filed-quantity.ts): the
        // door reads it from the row, so it is never sent through the floor.
        quantity: overrides.quantity ?? (row.quantity == null || isOwnCopy(row.suggested_metadata) ? undefined : filedQuantityOf(row.quantity)),
        extras: cand.fields ?? {},
        // A thing that holds things wins over a place: the new record goes
        // inside it (a Backpack), not onto a shelf.
        ...(overrides.container ? { container: overrides.container } : locationId ? { location_id: locationId } : {}),
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

async function addToRecord(door: FilingDoor, row: FilingRow, to: { kind: string; id: string; instance: string | null }, qty: number): Promise<FilingOutcome> {
  try {
    const r = await apiFetch(`${door.baseUrl}/api/v1/orgs/${door.slug}/modules/core-scan/inbox/${row.id}/attach`, {
      method: "POST",
      headers: door.authHeaders,
      body: JSON.stringify({ kind: to.kind, entity_id: to.id, ...(to.instance ? { instance: to.instance } : {}), mode: "add-qty", qty }),
    });
    if (!r.ok) {
      let msg = `attach ${r.status}`;
      try {
        const e = (await r.json()) as { error?: { message?: string } };
        if (e.error?.message) msg = e.error.message;
      } catch {
        /* the status is the message */
      }
      return { ok: false, item_id: row.id, name: displayName(row), reason: msg };
    }
    return { ok: true, item_id: row.id, name: displayName(row) ?? "", entity_id: to.id, entity_kind: to.kind };
  } catch (err) {
    return { ok: false, item_id: row.id, name: displayName(row), reason: (err as Error).message };
  }
}
