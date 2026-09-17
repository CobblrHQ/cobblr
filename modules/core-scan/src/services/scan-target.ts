// The ONE way core-scan turns a kind into a scan target.
//
// Scannability is a MODULE property: inventory registers `inventory:part`, and
// a record in a named instance (a Groceries table's milk) lives under the
// instance kind `groceries:item`, which nothing registers. The tracked-match
// endpoint reports a match by the kind it lives under, so the card sends
// `groceries:item` back, and a route that looked that kind up directly answered
// "groceries:item is not a scan target". Confirm learned this in June (a
// vehicle from the inbox: "assets:vehicles:item is not a scan target") and
// grew its own fallback; attach and the bin adjust never did, so every re-buy
// button on a grocery, a tea or a spice was a 400 (2026-09-12). Three
// spellings of one lookup is how that happens, so this file is the only one in
// core-scan that asks the kernel's scannable registry at all; the capability
// registry refuses a call anywhere else.
//
// The instance-kind grammar is the kernel's (`resolveKind`), not re-parsed
// here: which module a kind resolves to, and which instance it names, is one
// answer from one place.
import { platform, type ActionUndoStep, type ScannableInfo, type ScannableKind } from "@cobblr/platform-contract";

export interface ScanTarget {
  scannable: ScannableInfo;
  /** The module's registered kind, e.g. `inventory:part`. */
  baseKind: string;
  /** The named instance the kind lives in, when it does. */
  instance: string | null;
}

/** A request's kind (a module kind, or an instance kind) as a scan target.
 *
 *  `instance` from the request wins over the one the kind names. `module`
 *  is a hint for the shape confirm receives (`target_module` beside a
 *  `target_kind`): when the kind resolves to nothing registered, the module's
 *  own scannable stands in, because scannability belongs to the module and
 *  the instance only routes the write. Null when nothing applies. */
export async function scanTargetOf(
  orgId: string,
  kind: string,
  instance?: string | null,
  module?: string | null,
): Promise<ScanTarget | null> {
  const resolved = await platform().entities.resolveKind(orgId, kind);
  const scannable =
    platform().entities.getScannable(resolved.base) ??
    platform().entities.getScannable(kind) ??
    (module ? platform().entities.getScannableForModule(module) : null);
  if (!scannable) return null;
  return { scannable, baseKind: resolved.base, instance: instance ?? resolved.instance };
}

/** A registry record's scan details: the module's scannable for its own kind,
 *  or for the module when the record is a synthesized instance kind. For the
 *  walks over `listKindsForOrg` (matching, duplicates), where the module name
 *  is already in hand and no workspace lookup is needed. */
export function scanTargetOfRecord(rec: { kind: string; module_name: string }): ScannableInfo | null {
  return platform().entities.getScannable(rec.kind) ?? platform().entities.getScannableForModule(rec.module_name);
}

/** The scannable kinds THIS workspace has, instances included: the one
 *  answer for a walk over a workspace's records across kinds (the sibling
 *  tier, the unplaced sweep, the bin census, the duplicates door, the
 *  tracked match). The base registry (`scanTargetsRegistered`) never lists an
 *  instance kind, so a walk over it saw no grocery and no yarn and looked
 *  like it worked (#3132). */
export function scanTargetsForOrg(orgId: string): Promise<ScannableKind[]> {
  return platform().entities.listScannableForOrg(orgId);
}

/** The registered scan targets, one per module: the answer to a MODULE
 *  question (which module a noun names, the module's default kind), never
 *  to "which kinds hold records here". */
export function scanTargetsRegistered(): Array<{ kind: string } & ScannableInfo> {
  return platform().entities.listScannable();
}

// ─────────────── moving a scannable kind's quantity, one way ───────────────
//
// A scan's attach used to bump the count with a PATCH of the quantity field,
// a bare number: no lot, no bought-on date, no expiry, no floor. The record's
// module keeps all of that at its quantity action (inventory: adjust-stock,
// where the lots, the floor and the consumption ledger live), which the
// ScannableInfo names as `adjustAction`. So every quantity move a scan makes
// goes through here: the action when the kind declares one, invoked ON the
// record, else the module's own route; and the action's inverse comes back
// with the result so the caller can keep it beside its own record. The
// capability registry refuses a quantity-field write spelled anywhere else in
// the scan routes.

export interface QuantityMove {
  ok: boolean;
  /** What actually moved (a floor can clamp; a refusal moves nothing). */
  delta: number;
  newQty: number | null;
  /** The door's own sentence when it refused or clamped. */
  refused?: string;
  note?: string;
  /** The way back, from the action's own undoer, when there is one. */
  undo?: ActionUndoStep[];
}

export interface QuantityDoor {
  baseUrl: string;
  slug: string;
  headers: Record<string, string>;
}

/** Move the quantity of `entity` (a record of `target`) by `delta`.
 *
 *  `restock: true` says the delta is stock that arrived (a dated lot, the
 *  record's bought-on and expiry, per the module's rule); `source` names the
 *  scan inbox item for the module's ledger. `current` is the count as the
 *  caller last read it, for the route fallback only. */
export async function moveQuantity(
  orgId: string,
  target: ScanTarget,
  entity: { kind: string; id: string },
  delta: number,
  opts: {
    userId: string | null;
    reason: string;
    restock?: boolean;
    source: { kind: string; id: string };
    door: QuantityDoor;
    current: number;
  },
): Promise<QuantityMove> {
  const field = target.scannable.qtyField;
  if (!field) return { ok: false, delta: 0, newQty: null, refused: "this kind keeps no count" };
  const action = target.scannable.adjustAction;
  if (action) {
    const event = {
      name: "core-scan.inbox.attach",
      payload: {},
      actor: { user_id: opts.userId, display_name: null, auth_method: "session" as const, api_token_id: null, api_token_name: null },
      timestamp: new Date().toISOString(),
      trigger_type: "user-invoked" as const,
    };
    const result = (await platform().actions.invoke(action, {
      orgId,
      userId: opts.userId,
      entity: { kind: entity.kind, id: entity.id },
      event,
      args: {
        delta,
        reason: opts.reason,
        ...(opts.restock ? { restock: true } : {}),
        sourceKind: opts.source.kind,
        sourceId: opts.source.id,
      },
    })) as { ok?: boolean; delta?: number; newQty?: number; error?: string; note?: string; clamped?: boolean } | null;
    if (!result?.ok) {
      return { ok: false, delta: 0, newQty: null, refused: result?.error ?? "the record's quantity could not be changed" };
    }
    const undo = await platform()
      .actions.undoFor(action, result, { orgId, entity: { kind: entity.kind, id: entity.id } })
      .catch(() => null);
    return {
      ok: true,
      delta: Number(result.delta ?? delta),
      newQty: typeof result.newQty === "number" ? result.newQty : null,
      ...(result.clamped && result.note ? { note: result.note } : {}),
      ...(undo?.length ? { undo } : {}),
    };
  }
  // No action declared: the module's own route, never the kernel writer. The
  // floor is honoured here too, since a route is a bare write of the column.
  const path = target.instance
    ? `${opts.door.baseUrl}/api/v1/orgs/${opts.door.slug}/instances/${target.instance}/items/${entity.id}`
    : `${opts.door.baseUrl}/api/v1/orgs/${opts.door.slug}/modules/${target.scannable.createEndpoint}/${entity.id}`;
  const have = Number.isFinite(opts.current) ? opts.current : 0;
  const applied = delta < 0 ? -Math.min(-delta, Math.max(0, have)) : delta;
  if (delta < 0 && applied === 0) return { ok: false, delta: 0, newQty: have, refused: "Nothing on hand to use" };
  const r = await fetch(path, { method: "PATCH", headers: opts.door.headers, body: JSON.stringify({ [field]: have + applied }) });
  if (!r.ok) return { ok: false, delta: 0, newQty: null, refused: `the record's own route answered ${r.status}` };
  return { ok: true, delta: applied, newQty: have + applied, ...(applied !== delta ? { note: `Only ${have} on hand; took ${have}, now 0` } : {}) };
}

/** The count a NEW record starts with, keyed by its kind's own quantity
 *  field: the one quantity write a create may carry. Every move of an
 *  existing record's count goes through moveQuantity above; a scan route
 *  spells neither key itself (capability row scan:quantity-through-the-door). */
export function startingCount(scannable: ScannableInfo, qty: number | null | undefined): Record<string, number> {
  return scannable.qtyField && typeof qty === "number" && qty > 0 ? { [scannable.qtyField]: qty } : {};
}
