// A Station's own routes (#4640): a tablet a barcode scanner drives, at
// /station/<workspace>/<address>.
//
//   GET  /stations/screens/:address           its settings (made on first read)
//   PUT  /stations/screens/:address           change them (an owner or admin,
//                                             or the tablet with the owner PIN)
//   POST /stations/screens/:address/lookup    a code or a label's record → what
//                                             to show: a record you have, one
//                                             outside this station, or nothing
//   POST /stations/screens/:address/count     +1 / used one / set total, straight
//                                             to the record's stock (no inbox item)
//   POST /stations/screens/:address/undo      reverse one move
//   POST /stations/screens/:address/scans     a bridge hands the station a code
//   POST /stations/screens/:address/scans/next  the screen takes the next one
//
// A new thing does not come through here: the screen hands it to the scan
// intake (POST /scan) and shows the inbox's own card for it, so a station can
// do everything the inbox can. What a known thing's count does goes through
// the record's own quantity door (services/scan-target.ts), so the lots, the
// floor, the usage ledger and low stock all behave as they do anywhere else.
//
// The tablet's token reaches only its own address (api/src/auth/scopes.ts,
// `station:<address>`); which records it may count is this station's
// collections, checked here.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform, type ActionInvokeActor } from "@cobblr/platform-contract";
import {
  DEFAULT_STATION_SETTINGS,
  isStationAddress,
  stationLabelOf,
  stationOffersAction,
  stationQrMay,
  stationReaches,
  stationSettingsOf,
  type StationLookup,
  type StationMove,
  type StationRecord,
  type StationRecordNow,
  type StationActionRun,
  type StationSettings,
} from "@cobblr/platform-contract/station-screen";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { INTERNAL_API } from "./inbox.js";
import { findTracked } from "../services/entity-match.js";
import { matchQuery, trackedMatchStampAt } from "../services/tracked-stamp.js";
import { moveQuantity, scanTargetOf } from "../services/scan-target.js";
import { isActionStep, type ActionUndoStep } from "@cobblr/platform-contract/action-undo";
import { optionalText } from "@cobblr/platform-contract/optional-fields";

export const stationsRouter = Router({ mergeParams: true });

type Db = ReturnType<typeof tenantDb>;

/** The station's tablet, as opposed to a person signed in. */
function isStationDevice(req: Request): boolean {
  const scopes = (req as unknown as { session?: { token_scopes?: string[] | null } }).session?.token_scopes ?? [];
  return scopes.some((s) => s.startsWith("station:"));
}

/** A phone holding the station's kitchen QR (#5353): it may press only what
 *  the owner ticked (stationQrMay), and not too fast. */
function isQrPhone(req: Request): boolean {
  const scopes = (req as unknown as { session?: { token_scopes?: string[] | null } }).session?.token_scopes ?? [];
  return scopes.some((s) => s.startsWith("station-qr:"));
}

// SINGLE-PROCESS-SAFE: a soft brake on one phone's presses; a second api process only lets it press a little more.
const qrPresses = new Map<string, number[]>();
const QR_PRESSES_PER_MINUTE = 30;
/** True when this QR phone has pressed too often in the last minute. */
function qrTooFast(req: Request): boolean {
  const id = (req as unknown as { session?: { api_token_id?: string | null } }).session?.api_token_id ?? "";
  const now = Date.now();
  const recent = (qrPresses.get(id) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  qrPresses.set(id, recent);
  if (qrPresses.size > 5_000) qrPresses.delete(qrPresses.keys().next().value as string);
  return recent.length > QR_PRESSES_PER_MINUTE;
}

/** The QR's refusal, said once for every press it does not allow. */
function refuseQr(req: Request, res: Parameters<Parameters<typeof asyncHandler>[0]>[1], settings: StationSettings, press: { op?: string; action_id?: string }): boolean {
  if (!isQrPhone(req)) return false;
  if (qrTooFast(req)) {
    res.status(429).json({ error: { code: "too_fast", message: "That is a lot of presses. Wait a minute, then try again." } });
    return true;
  }
  if (stationQrMay(settings, press)) return false;
  res.status(403).json({ error: { code: "not_on_qr", message: "The kitchen QR can't do that. Sign in to do more." } });
  return true;
}

function addressOf(req: Request): string | null {
  const a = req.params.address;
  return isStationAddress(a) ? a : null;
}

/** The station's row, made with the defaults the first time it is read. */
async function screenOf(db: Db, address: string): Promise<{ label: string; settings: StationSettings; has_pin: boolean; pin_hash: string | null }> {
  await db
    .insertInto("core_scan_station_screens")
    .values({ address, label: stationLabelOf(address), settings: JSON.stringify(DEFAULT_STATION_SETTINGS) })
    .onConflict((oc) => oc.column("address").doNothing())
    .execute();
  const row = await db.selectFrom("core_scan_station_screens").selectAll().where("address", "=", address).executeTakeFirstOrThrow();
  return { label: row.label, settings: stationSettingsOf(row.settings), has_pin: !!row.pin_hash, pin_hash: row.pin_hash };
}

function hashPin(pin: string): string {
  const salt = randomBytes(12).toString("base64url");
  return `${salt}:${scryptSync(pin, salt, 32).toString("base64url")}`;
}

function pinMatches(stored: string | null, pin: unknown): boolean {
  if (!stored || typeof pin !== "string") return false;
  const [salt, want] = stored.split(":");
  if (!salt || !want) return false;
  const got = scryptSync(pin, salt, 32);
  const exp = Buffer.from(want, "base64url"); // b64-lenient-ok: the hash this server stored, never a value from the request
  return got.length === exp.length && timingSafeEqual(got, exp);
}

/** A few wrong PINs per station per minute, then a wait. */
const pinTries = new Map<string, number[]>();
function pinThrottled(key: string): boolean {
  const now = Date.now();
  const recent = (pinTries.get(key) ?? []).filter((t) => now - t < 60_000);
  pinTries.set(key, recent);
  return recent.length >= 5;
}

stationsRouter.get(
  "/stations/screens/:address",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const s = await screenOf(tenantDb(req), address);
    res.json({ address, label: s.label, settings: s.settings, has_pin: s.has_pin, device: isStationDevice(req) });
  }),
);

const SettingsBody = z.object({
  label: z.string().trim().min(1).max(60).optional(), // none-refused-ok: a column that cannot hold null
  settings: z.record(z.string(), z.unknown()).optional(),
  /** The PIN, when the tablet itself is making the change. */
  pin: optionalText(12),
  /** A new PIN (4 to 8 digits), or null to take it away. */
  new_pin: z.string().regex(/^\d{4,8}$/).nullable().optional(),
});

// AI-REACH: exempt, a station's screen settings are set on the tablet or by its owner beside it; the assistant has no screen to set.
stationsRouter.put(
  "/stations/screens/:address",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const parsed = SettingsBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const cur = await screenOf(db, address);
    if (isStationDevice(req)) {
      // The tablet changes its own settings only with the owner's PIN, and
      // never sets or takes away the PIN itself.
      const key = `${tenantContext(req).org.id}:${address}`;
      if (pinThrottled(key)) return void res.status(429).json({ error: { code: "pin_wait", message: "Too many tries. Wait a minute." } });
      if (!pinMatches(cur.pin_hash, parsed.data.pin)) {
        pinTries.get(key)!.push(Date.now());
        return void res.status(403).json({
          error: cur.pin_hash
            ? { code: "pin_wrong", message: "That PIN is not this station's." }
            : { code: "pin_none", message: "This station has no PIN. Change its settings from a signed-in phone or computer, or set a PIN there." },
        });
      }
      if (parsed.data.new_pin !== undefined) {
        return void res.status(403).json({ error: { code: "pin_owner_only", message: "Set the PIN from a signed-in phone or computer." } });
      }
    }
    const settings = parsed.data.settings ? stationSettingsOf({ ...cur.settings, ...parsed.data.settings }) : cur.settings;
    await db
      .updateTable("core_scan_station_screens")
      .set({
        label: parsed.data.label ?? cur.label,
        settings: JSON.stringify(settings),
        ...(parsed.data.new_pin !== undefined ? { pin_hash: parsed.data.new_pin ? hashPin(parsed.data.new_pin) : null } : {}),
        updated_at: new Date(),
      })
      .where("address", "=", address)
      .execute();
    const next = await screenOf(db, address);
    res.json({ address, label: next.label, settings: next.settings, has_pin: next.has_pin });
  }),
);

/** A record as the station shows it. */
async function stationRecord(orgId: string, e: { kind: string; id: string; title: string; image_path?: string | null; detailUrl?: string | null; detail_url?: string | null; fields?: Record<string, unknown>; qty?: number | null; location_id?: string | null; instance?: string | null }): Promise<{ record: StationRecord; countable: boolean }> {
  const target = await scanTargetOf(orgId, e.kind, e.instance ?? null);
  const field = target?.scannable.qtyField ?? null;
  const raw = e.qty ?? (field ? e.fields?.[field] : null);
  const n = typeof raw === "number" ? raw : raw != null ? Number(raw) : NaN;
  const location_id = e.location_id ?? (typeof e.fields?.location_id === "string" ? (e.fields.location_id as string) : null);
  const place = location_id
    ? await platform().entities.lookupMany(orgId, [{ kind: "core-locations:location", id: location_id }]).then((r) => r[0]?.title ?? null)
    : null;
  return {
    record: {
      kind: e.kind,
      id: e.id,
      instance: target?.instance ?? e.instance ?? null,
      title: e.title,
      image_path: e.image_path ?? null,
      qty: field && Number.isFinite(n) ? n : null,
      location_id,
      location_name: place,
      detail_url: e.detailUrl ?? e.detail_url ?? null,
    },
    countable: !!field,
  };
}

/** The record as it stands now, for the card to show after a write. */
async function recordNow(orgId: string, kind: string, id: string): Promise<StationRecordNow | null> {
  const e = await platform().entities.lookup(orgId, kind, id);
  return e ? stationRecord(orgId, e) : null;
}

const LookupBody = z.union([
  z.object({ code: z.string().trim().min(1).max(512) }),
  z.object({ record: z.object({ kind: z.string().min(1), id: z.string().min(1) }) }),
]);

// AI-REACH: exempt, a read the tablet makes for one scan; the assistant finds a record by its code with search_records.
stationsRouter.post(
  "/stations/screens/:address/lookup",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const parsed = LookupBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = tenantContext(req).org.id;
    const { settings } = await screenOf(tenantDb(req), address);
    let out: StationLookup = { found: "none" };
    if ("record" in parsed.data) {
      // A Cobblr label: the screen resolved it to its record.
      const e = await platform().entities.lookup(orgId, parsed.data.record.kind, parsed.data.record.id);
      if (e) {
        const r = await stationRecord(orgId, e);
        out = stationReaches(settings, r.record.kind) ? { found: "record", ...r, matched_by: "label" } : { found: "outside", title: r.record.title };
      }
    } else {
      // A barcode or an identifier: exact matches only. A name is never
      // enough for a station to count something without asking.
      const tracked = await findTracked(
        orgId,
        matchQuery({ barcode_text: parsed.data.code, suggested_name: null, suggested_metadata: null, suggested_manufacturer: null }, null, null),
      );
      const stamp = await trackedMatchStampAt(orgId, tracked, { place_choice: null, location_id: settings.new_location_id });
      const best = tracked.barcode_matches.find((m) => m.id === stamp?.id) ?? tracked.barcode_matches[0];
      if (stamp && best) {
        const r = await stationRecord(orgId, { ...best, id: stamp.id, qty: stamp.qty ?? best.qty });
        out = stationReaches(settings, r.record.kind)
          ? { found: "record", ...r, matched_by: best.matched_by === "identifier" ? "identifier" : "barcode" }
          : { found: "outside", title: r.record.title };
      }
    }
    res.json(out);
  }),
);

const CountBody = z.object({
  request_id: z.string().trim().min(8).max(80),
  kind: z.string().min(1),
  entity_id: z.string().min(1),
  op: z.enum(["add", "use", "total"]),
  /** How many to add or use (default 1), or the new total. */
  value: z.number().finite().min(0).max(1_000_000).optional(), // none-refused-ok: a column that cannot hold null
});

function moveOf(row: { request_id: string; op: string; delta: string | number; qty: string | number | null; note: string | null }): StationMove {
  return {
    request_id: row.request_id,
    op: row.op as StationMove["op"],
    delta: Number(row.delta),
    qty: row.qty == null ? null : Number(row.qty),
    note: row.note,
  };
}

function doorOf(req: Request, slug: string) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return {
    baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
    slug,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
}

// AI-REACH: exempt, a station's count is the tablet's own button; the assistant changes a count through the record's own stock actions (inventory:adjust-stock, inventory:set-stock).
stationsRouter.post(
  "/stations/screens/:address/count",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const parsed = CountBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { org } = tenantContext(req);
    const db = tenantDb(req);
    const { settings, label } = await screenOf(db, address);
    const b = parsed.data;
    if (!stationReaches(settings, b.kind)) {
      return void res.status(403).json({ error: { code: "outside_station", message: `${label} does not keep that.` } });
    }
    if (refuseQr(req, res, settings, { op: b.op })) return;
    const target = await scanTargetOf(org.id, b.kind);
    if (!target?.scannable.qtyField) {
      return void res.status(409).json({ error: { code: "no_count", message: "That keeps no count." } });
    }
    // The claim: a retry of a request this station already made is answered
    // from the journal, never counted twice.
    const claimed = await db
      .insertInto("core_scan_station_moves")
      .values({ address, request_id: b.request_id, kind: b.kind, entity_id: b.entity_id, instance: target.instance, op: b.op, delta: 0, qty: null })
      .onConflict((oc) => oc.columns(["address", "request_id"]).doNothing())
      .returning(["request_id"])
      .executeTakeFirst();
    if (!claimed) {
      const prior = await db.selectFrom("core_scan_station_moves").selectAll().where("address", "=", address).where("request_id", "=", b.request_id).executeTakeFirstOrThrow();
      return void res.json({ ...moveOf(prior), replayed: true });
    }
    const e = await platform().entities.lookup(org.id, b.kind, b.entity_id);
    if (!e) {
      await db.deleteFrom("core_scan_station_moves").where("address", "=", address).where("request_id", "=", b.request_id).execute();
      return void res.status(404).json({ error: { code: "not_found", message: "That record is gone." } });
    }
    const cur = Number(e.fields[target.scannable.qtyField] ?? 0);
    const have = Number.isFinite(cur) ? cur : 0;
    const n = b.value ?? 1;
    const delta = b.op === "add" ? n : b.op === "use" ? -n : n - have;
    const moved =
      delta === 0
        ? { ok: true, delta: 0, newQty: have }
        : await moveQuantity(org.id, target, { kind: b.kind, id: b.entity_id }, delta, {
            userId: sessionUser(req).id,
            reason: b.op === "add" ? `added at ${label}` : b.op === "use" ? `used, at ${label}` : `counted at ${label}`,
            ...(b.op === "add" ? { restock: true } : {}),
            ...(b.op === "total" ? { correction: true } : {}),
            source: { kind: "core-scan:station", id: address },
            door: doorOf(req, org.slug),
            current: have,
          });
    if (!moved.ok) {
      await db.deleteFrom("core_scan_station_moves").where("address", "=", address).where("request_id", "=", b.request_id).execute();
      return void res.status(409).json({ error: { code: "count_refused", message: ("refused" in moved && moved.refused) || "That count could not be changed." } });
    }
    const note = "note" in moved && moved.note ? moved.note : null;
    const qty = moved.newQty ?? have + moved.delta;
    await db
      .updateTable("core_scan_station_moves")
      .set({ delta: moved.delta, qty, note })
      .where("address", "=", address)
      .where("request_id", "=", b.request_id)
      .execute();
    res.json({ request_id: b.request_id, op: b.op, delta: moved.delta, qty, note } satisfies StationMove);
  }),
);

// AI-REACH: exempt, the tablet's Undo for its own last move.
stationsRouter.post(
  "/stations/screens/:address/undo",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const requestId = typeof req.body?.request_id === "string" ? req.body.request_id : "";
    const { org } = tenantContext(req);
    const db = tenantDb(req);
    const { label } = await screenOf(db, address);
    // The claim on the undo is the same row: whoever marks it undone first is
    // the one that moves the count back.
    const move = await db
      .updateTable("core_scan_station_moves")
      .set({ undone_at: new Date() })
      .where("address", "=", address)
      .where("request_id", "=", requestId)
      .where("undone_at", "is", null)
      .returning(["kind", "entity_id", "delta", "op"])
      .executeTakeFirst();
    if (!move) return void res.status(404).json({ error: { code: "nothing_to_undo", message: "Nothing to undo." } });
    const delta = Number(move.delta);
    const target = await scanTargetOf(org.id, move.kind);
    const e = await platform().entities.lookup(org.id, move.kind, move.entity_id);
    if (!target?.scannable.qtyField || !e || delta === 0) return void res.json({ ok: true, qty: null });
    const cur = Number(e.fields[target.scannable.qtyField] ?? 0);
    const moved = await moveQuantity(org.id, target, { kind: move.kind, id: move.entity_id }, -delta, {
      userId: sessionUser(req).id,
      reason: `undo at ${label}`,
      correction: true,
      source: { kind: "core-scan:station", id: address },
      door: doorOf(req, org.slug),
      current: Number.isFinite(cur) ? cur : 0,
    });
    if (!moved.ok) {
      await db.updateTable("core_scan_station_moves").set({ undone_at: null }).where("address", "=", address).where("request_id", "=", requestId).execute();
      return void res.status(409).json({ error: { code: "undo_refused", message: moved.refused ?? "That could not be undone." } });
    }
    res.json({ ok: true, qty: moved.newQty });
  }),
);

const MoveBody = z.object({ kind: z.string().min(1), entity_id: z.string().min(1), location_id: z.string().min(1) });

// Move to…: the placement kernel, as every other move is, named by the station.
// AI-REACH: exempt, the tablet's Move button; the assistant moves a record through the placement tools.
stationsRouter.post(
  "/stations/screens/:address/move",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const parsed = MoveBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { org } = tenantContext(req);
    const { settings, label } = await screenOf(tenantDb(req), address);
    if (!stationReaches(settings, parsed.data.kind)) {
      return void res.status(403).json({ error: { code: "outside_station", message: `${label} does not keep that.` } });
    }
    try {
      await platform().placement.place({
        orgId: org.id,
        containee: { kind: parsed.data.kind, id: parsed.data.entity_id },
        container: { kind: "core-locations:location", id: parsed.data.location_id },
        placedBy: sessionUser(req).id,
        via: label,
      });
    } catch (e) {
      return void res.status(409).json({ error: { code: "move_refused", message: e instanceof Error ? e.message : "That could not be moved there." } });
    }
    res.json({ ok: true });
  }),
);

// ── A known thing's own record actions (#4640) ──────────────────────────
//
// The owner: "the buttons on a known thing are that record's own actions"
// (Log service, Lend, Mark service done), not a grocery set. A kiosk token
// runs them only here, never at the general invoke door, and only what this
// door offers: an entity action a person may press whose every effect stays
// in this workspace and can be put back (`undoable`, the same line Cobb's
// auto mode and a label's one tap draw), on a record this station keeps. The
// way back is kept here by the run's request id, so the tablet's Undo runs
// exactly what the action handed over and never steps of its own.

type StationAction = { id: string; label: string; icon: string | null; description: string | null; args_schema: unknown; group: string | null; primary: boolean };

/** The actions a station offers on a record of this kind. */
export async function stationActionsFor(orgId: string, kind: string) {
  const all = await platform().actions.listApplicable(kind, orgId);
  // One clear set per card (#5710): not a stock move the card already shows,
  // never an editor. The same rule answers the list and the run.
  const countable = !!(await scanTargetOf(orgId, kind))?.scannable.qtyField;
  return all.filter(
    (a) => a.scope === "entity" && a.user_invokable && !a.internal && !a.wire_only && a.undoable === true && !!a.invoke_handler && stationOffersAction(a, { countable }),
  );
}

// AI-REACH: exempt, the tablet's list of a record's buttons; the assistant lists a record's actions through list_actions.
stationsRouter.get(
  "/stations/screens/:address/actions",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const kind = typeof req.query.kind === "string" ? req.query.kind : "";
    if (!kind) return void res.status(400).json({ error: { code: "kind_required", message: "Say which kind of record." } });
    const { org } = tenantContext(req);
    const { settings, label } = await screenOf(tenantDb(req), address);
    if (!stationReaches(settings, kind)) {
      return void res.status(403).json({ error: { code: "outside_station", message: `${label} does not keep that.` } });
    }
    // A kitchen QR phone sees only the presses the owner ticked.
    const offered = (await stationActionsFor(org.id, kind)).filter((a) => !isQrPhone(req) || stationQrMay(settings, { action_id: a.id }));
    // The same picker a record page offers: "who has it" is the workspace's
    // People by name, never an id box a kiosk cannot fill.
    const choose = await platform().actions.argChoices(org.id, kind, offered.map((a) => a.args_schema));
    const items: StationAction[] = offered.map((a) => ({
      id: a.id,
      label: a.label,
      icon: a.icon,
      description: a.description,
      args_schema: choose(a.args_schema),
      group: a.group ?? null,
      primary: !!a.primary,
    }));
    res.json({ items });
  }),
);

const ActionRunBody = z.object({
  request_id: z.string().min(8).max(80),
  action_id: z.string().min(1),
  kind: z.string().min(1),
  entity_id: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});

function actorOf(req: Request): ActionInvokeActor {
  const s = sessionUser(req) as { id: string; display_name?: string | null; auth_method?: string; api_token_id?: string | null };
  const auth_method = s.auth_method === "session" ? "session" : "api_token";
  return { user_id: s.id, display_name: s.display_name ?? null, auth_method, api_token_id: s.api_token_id ?? null, api_token_name: null };
}

// AI-REACH: exempt, the tablet's press of a record's own action; the assistant runs the same action through invoke_action.
stationsRouter.post(
  "/stations/screens/:address/actions/run",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const parsed = ActionRunBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const b = parsed.data;
    const { org } = tenantContext(req);
    const db = tenantDb(req);
    const { settings, label } = await screenOf(db, address);
    if (!stationReaches(settings, b.kind)) {
      return void res.status(403).json({ error: { code: "outside_station", message: `${label} does not keep that.` } });
    }
    if (refuseQr(req, res, settings, { action_id: b.action_id })) return;
    const action = (await stationActionsFor(org.id, b.kind)).find((a) => a.id === b.action_id);
    if (!action) {
      return void res.status(403).json({ error: { code: "not_offered", message: `${label} does not offer that here.` } });
    }
    const claimed = await db
      .insertInto("core_scan_station_actions")
      .values({ address, request_id: b.request_id, action_id: action.id, kind: b.kind, entity_id: b.entity_id, label: action.label, ok: null, undo: null })
      .onConflict((oc) => oc.columns(["address", "request_id"]).doNothing())
      .returning(["request_id"])
      .executeTakeFirst();
    if (!claimed) {
      const prior = await db.selectFrom("core_scan_station_actions").selectAll().where("address", "=", address).where("request_id", "=", b.request_id).executeTakeFirstOrThrow();
      const replay: StationActionRun = { request_id: b.request_id, ok: prior.ok === true, undoable: Array.isArray(prior.undo) && prior.undo.length > 0, replayed: true, now: await recordNow(org.id, b.kind, b.entity_id) };
      return void res.json(replay);
    }
    const forget = () => db.deleteFrom("core_scan_station_actions").where("address", "=", address).where("request_id", "=", b.request_id).execute();
    const e = await platform().entities.lookup(org.id, b.kind, b.entity_id);
    if (!e) {
      await forget();
      return void res.status(404).json({ error: { code: "not_found", message: "That record is gone." } });
    }
    let result: unknown;
    try {
      result = await platform().actions.invoke(action.id, {
        orgId: org.id,
        userId: sessionUser(req).id,
        scope: "entity",
        entity: { kind: b.kind, id: b.entity_id, fields: e.fields },
        event: { name: null, payload: b.args ?? {}, actor: actorOf(req), timestamp: new Date().toISOString(), trigger_type: "user-invoked" },
        args: b.args ?? {},
      });
    } catch (err) {
      await forget();
      const refusal = (err as { name?: string; message?: string } | null)?.name === "ActionRefusal" ? (err as Error).message : null;
      console.error(`[core-scan] station ${address} ${action.id} failed:`, err);
      return void res.status(409).json({ error: { code: "action_refused", message: refusal ?? `${action.label} could not run.` } });
    }
    const r = result as { ok?: unknown; error?: unknown; summary?: unknown } | null;
    if (r?.ok !== true) {
      await forget();
      return void res.status(409).json({ error: { code: "action_refused", message: typeof r?.error === "string" && r.error ? r.error : `${action.label} could not run.` } });
    }
    const raw = await platform().actions.undoFor(action.id, result, { orgId: org.id, entity: { kind: b.kind, id: b.entity_id } }).catch(() => null);
    const undo: ActionUndoStep[] = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    await db
      .updateTable("core_scan_station_actions")
      .set({ ok: true, undo: undo.length ? JSON.stringify(undo) : null })
      .where("address", "=", address)
      .where("request_id", "=", b.request_id)
      .execute();
    const ran: StationActionRun = { request_id: b.request_id, ok: true, summary: typeof r.summary === "string" ? r.summary : null, undoable: undo.length > 0, now: await recordNow(org.id, b.kind, b.entity_id) };
    res.json(ran);
  }),
);

// AI-REACH: exempt, the tablet's Undo for its own last action run.
stationsRouter.post(
  "/stations/screens/:address/actions/undo",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const requestId = typeof req.body?.request_id === "string" ? req.body.request_id : "";
    const { org } = tenantContext(req);
    const db = tenantDb(req);
    const run = await db
      .updateTable("core_scan_station_actions")
      .set({ undone_at: new Date() })
      .where("address", "=", address)
      .where("request_id", "=", requestId)
      .where("undone_at", "is", null)
      .where("ok", "=", true)
      .returning(["kind", "entity_id", "undo", "label"])
      .executeTakeFirst();
    if (!run) return void res.status(404).json({ error: { code: "nothing_to_undo", message: "Nothing to undo." } });
    const steps = (Array.isArray(run.undo) ? run.undo : []) as ActionUndoStep[];
    const putBack = () => db.updateTable("core_scan_station_actions").set({ undone_at: null }).where("address", "=", address).where("request_id", "=", requestId).execute();
    if (!steps.length || steps.some((s) => !isActionStep(s))) {
      await putBack();
      return void res.status(409).json({ error: { code: "undo_refused", message: `${run.label} can't be undone here. Open the record to change it.` } });
    }
    for (const step of steps) {
      if (!isActionStep(step)) continue;
      const kind = step.entity_kind ?? run.kind;
      const id = step.entity_id ?? run.entity_id;
      const r = (await platform()
        .actions.invoke(step.action_id, {
          orgId: org.id,
          userId: sessionUser(req).id,
          entity: { kind, id },
          event: { name: null, payload: step.args, actor: actorOf(req), timestamp: new Date().toISOString(), trigger_type: "user-invoked" },
          args: step.args,
        })
        .catch((err: unknown) => ({ ok: false, error: (err as Error)?.message ?? String(err) }))) as { ok?: boolean; error?: string } | null;
      if (r?.ok !== true) {
        await putBack();
        return void res.status(409).json({ error: { code: "undo_refused", message: r?.error ?? `${run.label} could not be undone.` } });
      }
    }
    res.json({ ok: true, now: await recordNow(org.id, run.kind, run.entity_id) });
  }),
);

// ── A bridge's codes for a screen with no scanner of its own ──────────────
const SCAN_TTL_MS = 2 * 60_000;

// AI-REACH: exempt, spoken by a scanner bridge on the bench, not by a person or the assistant.
// UI-REACH: a scanner bridge's wire (scripts/scan-bridge posts here); the station screen takes them through /scans/next
stationsRouter.post(
  "/stations/screens/:address/scans",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    const code = typeof req.body?.code === "string" ? req.body.code.trim().slice(0, 512) : "";
    if (!address || !code) return void res.status(400).json({ error: { code: "invalid_body", message: "Say the code." } });
    const db = tenantDb(req);
    await db.deleteFrom("core_scan_station_scans").where("created_at", "<", new Date(Date.now() - SCAN_TTL_MS)).execute();
    await db.insertInto("core_scan_station_scans").values({ address, code }).execute();
    res.status(202).json({ ok: true });
  }),
);

// The screen takes the oldest code waiting for it. Claimed in one statement,
// so two tabs on one station never both act on a scan.
// AI-REACH: exempt, the station screen's own poll.
stationsRouter.post(
  "/stations/screens/:address/scans/next",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const address = addressOf(req);
    if (!address) return void res.status(404).json({ error: { code: "not_found", message: "No such station." } });
    const r = await sql<{ code: string }>`
      update core_scan_station_scans set taken_at = now()
       where id = (select id from core_scan_station_scans
                    where address = ${address} and taken_at is null and created_at > ${new Date(Date.now() - SCAN_TTL_MS)}
                    order by id limit 1 for update skip locked)
      returning code`.execute(tenantDb(req));
    res.json({ code: r.rows[0]?.code ?? null });
  }),
);
