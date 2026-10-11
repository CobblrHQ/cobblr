// A document put on a record, read and kept (#4523).
//
// The one pipeline behind every door that says "this paper belongs to this
// thing": a PDF pasted or dropped on a record's Files, "It's this one" on an
// inbox card whose VIN found a car the workspace already has, and the
// assistant. It reads the paper with the receipt reader (asking a model only
// when the text shows a sale), keeps the file on the record, records the
// purchase with every line and claims its unit line for the record, and fills
// the record's empty fields from what the paper says, returning each
// disagreement instead of writing over it. Nothing goes in the inbox: the
// thing is already here.

import { priceDoubted, sellerDoubted } from "./receipt-facts.js";
import { platform } from "@cobblr/platform-contract";
import { parseReceipt } from "./receipt.js";
import { lineDiscounted, lineNet, shareOrderDiscount, type ParsedReceipt, type ReceiptLine } from "./receipt-shared.js";
import { claimOrderLine, lineUnitCost } from "./receipt-order.js";
import { fillRecordFromPaperwork, paperworkDoubts, type PaperworkHeld, type PaperworkConflict, type PaperworkField, type PaperworkFill } from "./record-paperwork.js";
import type { Kysely } from "kysely";

export interface PaperworkHttp {
  baseUrl: string;
  slug: string;
  headers: Record<string, string>;
}

export type AttachPaperworkResult =
  | {
      read: true;
      document: "bill-of-sale" | "receipt";
      /** Who it says sold it. */
      from: string | null;
      total: number | null;
      order_id: string | null;
      purchases_off: boolean;
      filled: PaperworkFill[];
      conflicts: PaperworkConflict[];
      /** Values the page read that failed their check: shown under "Please
       *  check", written nowhere (#4633). */
      held: PaperworkHeld[];
      /** The document model could not read it now and will when it can:
       *  "busy" or "limit" (its allowance is used up for now). */
      waiting: "busy" | "limit" | null;
    }
  /** Kept as a file; it did not read as a sale. */
  | { read: false; reason: string };

/** The line a document is ABOUT when it is put on one record: a bill of
 *  sale's unit, or the one thing on a receipt that has only one. */
export function unitLineOf(receipt: ParsedReceipt): ReceiptLine | null {
  const things = receipt.items.filter((l) => !l.kind);
  if (receipt.document === "bill-of-sale") return things[0] ?? null;
  return things.length === 1 ? things[0]! : null;
}

/** The fields of a record this pass may fill: the kind's own columns (with
 *  their field roles and how money is kept) and the workspace's fields on it
 *  (with their field and decode roles). */
/** The decode role each of a kind's workspace fields declares (a vehicle's
 *  Year is decode:year), read from the field definitions themselves so a door
 *  with no request (the assistant's) fills what a paste fills. */
async function decodeRolesFor(orgId: string, kind: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const meta = platform().db.meta as unknown as Kysely<{
      module_field_defs: { org_id: string; entity_kind: string; name: string; decode_role: string | null };
    }>;
    const rows = await meta
      .selectFrom("module_field_defs")
      .select(["name", "decode_role"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", kind)
      .where("decode_role", "is not", null)
      .execute();
    for (const r of rows) if (r.decode_role) out.set(r.name, r.decode_role);
  } catch {
    // no defs, no decode roles; the field roles still fill
  }
  return out;
}

/** What the workspace says about the kind's own fields: the label it calls
 *  each (a vehicle's manufacturer is "Make", its serial number "VIN") and the
 *  roles a bundle gave them. A person's own row wins over a bundle's. */
async function nativeOverridesFor(orgId: string, kinds: string[]): Promise<Map<string, { label: string | null; decode_role: string | null; field_role: string | null }>> {
  const out = new Map<string, { label: string | null; decode_role: string | null; field_role: string | null }>();
  try {
    const meta = platform().db.meta as unknown as Kysely<{
      native_field_overrides: { org_id: string; entity_kind: string; name: string; display_label: string | null; bundle_id: string | null; overrides: unknown };
    }>;
    const rows = await meta
      .selectFrom("native_field_overrides")
      .select(["entity_kind", "name", "display_label", "bundle_id", "overrides"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "in", kinds)
      .execute();
    // Bundle rows first, a person's last, so theirs is what stays.
    rows.sort((a, b) => (a.bundle_id ? 0 : 1) - (b.bundle_id ? 0 : 1));
    for (const r of rows) {
      const o = (r.overrides ?? {}) as { decode_role?: unknown; field_role?: unknown };
      const had = out.get(r.name);
      out.set(r.name, {
        label: r.display_label ?? had?.label ?? null,
        decode_role: typeof o.decode_role === "string" ? o.decode_role : had?.decode_role ?? null,
        field_role: typeof o.field_role === "string" ? o.field_role : had?.field_role ?? null,
      });
    }
  } catch {
    // none, or not readable: the kind's own labels stand
  }
  return out;
}

/** A column's name in words, for a field nobody labelled. */
const inWords = (name: string) => {
  const w = name.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

export async function paperworkFieldsFor(orgId: string, kind: string): Promise<PaperworkField[]> {
  const out: PaperworkField[] = [];
  const kinds = await platform().entities.listScannableForOrg(orgId).catch(() => []);
  const rec = kinds.find((k) => k.kind === kind)?.record;
  const decodeRoles = await decodeRolesFor(orgId, kind);
  const base = await platform().entities.baseKindOf(orgId, kind).catch(() => kind);
  const overrides = await nativeOverridesFor(orgId, [...new Set([kind, base])]);
  const menuField = (name: string) => (decodeRoles.has(name) ? { decode_role: decodeRoles.get(name)!, label: undefined as string | undefined } : undefined);
  const natives = new Set<string>();
  for (const f of rec?.fields ?? []) {
    if (["id", "metadata", "created_at", "updated_at", "image_path", "location_id"].includes(f.name)) continue;
    natives.add(f.name);
    const mf = menuField(f.name);
    const ov = overrides.get(f.name);
    const role = ov?.field_role ?? f.fieldRole ?? null;
    out.push({
      name: f.name,
      label: ov?.label ?? f.label ?? inWords(f.name),
      native: true,
      money: f.money ?? null,
      field_role: role && role !== "identifier" ? role : null,
      decode_role: ov?.decode_role ?? mf?.decode_role ?? null,
    });
  }
  const custom = await platform().entities.fieldsFor(orgId, kind).catch(() => []);
  for (const d of custom) {
    if (natives.has(d.name)) continue;
    out.push({
      name: d.name,
      label: d.display_label,
      native: false,
      field_role: d.field_role ?? null,
      decode_role: menuField(d.name)?.decode_role ?? null,
    });
  }
  return out;
}

/** The kind a record really is. A record page can name it by its module's own
 *  kind (an asset) while it lives in a named copy of that module (Vehicles),
 *  and the copy is where its labels and roles were set: a vehicle's serial
 *  number is its VIN. The row says which copy it is in. */
export async function recordKindOf(orgId: string, kind: string, id: string): Promise<string> {
  try {
    const row = await platform().entities.snapshot(orgId, kind, id);
    const instance = row?.instance;
    if (typeof instance !== "string" || !instance) return kind;
    const candidate = `${instance}:item`;
    if (candidate === kind) return kind;
    const r = await platform().entities.resolveKind(orgId, candidate);
    return r.instance && r.base === (await platform().entities.baseKindOf(orgId, kind)) ? candidate : kind;
  } catch {
    return kind;
  }
}

export async function attachPaperwork(args: {
  orgId: string;
  userId: string | null;
  /** The stored original, or null for a personal document read on the
   *  personal path (#5331): its values fill the record and its purchase, and
   *  nothing is attached, because nothing was kept. */
  fileId: string | null;
  kind: string;
  id: string;
  /** Only for claiming a purchase line an inbox read already made. */
  http: PaperworkHttp | null;
  /** A document the reader already read (the inbox card's), to save a second read. */
  receipt?: ParsedReceipt;
  /** The purchase line this paper already has (an inbox read made the order
   *  when it read the paper): claimed for the record, never a second order. */
  existingLine?: { orderId: string; lineId: string } | null;
  /** Checks the inbox row failed (its check_fields), so a value doubted on
   *  the card is doubted here too, whatever this read says. */
  doubted?: readonly string[];
}): Promise<AttachPaperworkResult> {
  let receipt = args.receipt;
  if (!receipt) {
    if (!args.fileId) return { read: false, reason: "There is no document to read." };
    const r = await parseReceipt(args.orgId, args.fileId, args.userId, null, { requireTransaction: true });
    if (!r.ok) return { read: false, reason: r.reason };
    receipt = r.receipt;
  }
  receipt = shareOrderDiscount(receipt);
  const unit = unitLineOf(receipt);
  // A receipt with many things on it does not say which one this record is:
  // it is kept as a file, and its lines stay where the inbox would put them.
  if (!unit) return { read: false, reason: "It lists several things, so it does not say which one this is." };

  // The file stays on the record, whichever door brought it.
  const [sourceModule, sourceType] = args.kind.split(":");
  if (sourceModule && sourceType && args.fileId) {
    await platform().files.attach(args.orgId, { fileId: args.fileId, source_module: sourceModule, source_type: sourceType, source_id: args.id, role: null }).catch(() => null);
  }

  // Fill first, from the paper itself: the order's own stamp then finds the
  // fields already filled by this evidence and leaves them.
  const kind = await recordKindOf(args.orgId, args.kind, args.id);
  const fields = await paperworkFieldsFor(args.orgId, kind);
  const doubted = paperworkDoubts(receipt, args.doubted ?? []);
  const { filled, conflicts, held } = await fillRecordFromPaperwork({
    orgId: args.orgId,
    kind,
    id: args.id,
    receipt,
    line: unit,
    fields,
    // A value read from a personal document points at no file: none was kept.
    ref: args.fileId ? { kind: "core-files:file", id: args.fileId } : { kind: "core-scan:personal-document", id: args.id },
    doubted,
  });
  const waitingWhy = (receipt.checks as { waiting_for_ai?: unknown; waiting_reason?: unknown } | undefined) ?? undefined;
  const waiting: "busy" | "limit" | null = waitingWhy?.waiting_for_ai ? (waitingWhy.waiting_reason === "limit" ? "limit" : "busy") : null;
  // Who sold it and what it cost, only when the page's checks believed them:
  // the purchase is a record too, and a seller read as a sentence is not one.
  const sellerOk = !sellerDoubted(doubted);
  const priceOk = !priceDoubted(doubted);
  const from = sellerOk ? (receipt.vendor ?? receipt.seller) : null;

  if (args.existingLine && args.http) {
    await claimOrderLine({ ...args.http, orderId: args.existingLine.orderId, itemId: args.existingLine.lineId, partId: args.id, subjectKind: kind });
    return {
      read: true,
      document: receipt.document === "bill-of-sale" ? "bill-of-sale" : "receipt",
      from,
      total: priceOk ? receipt.total : null,
      order_id: args.existingLine.orderId,
      purchases_off: false,
      filled,
      conflicts,
      held,
      waiting,
    };
  }

  // The purchase, every line, its unit claimed for this record: in-process,
  // so the assistant's door records it exactly as a paste does.
  let orderId: string | null = null;
  let purchasesOff = false;
  try {
    const r = (await platform().actions.invoke("purchases:record-paperwork", {
      orgId: args.orgId,
      userId: args.userId,
      scope: "workspace",
      event: {
        name: null,
        payload: {},
        actor: { user_id: args.userId, display_name: null, auth_method: "session" },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      args: {
        vendor: from,
        ordered_at: receipt.date,
        currency: receipt.currency,
        order_ref: receipt.order_ref,
        total: priceOk ? receipt.total : null,
        source_file_id: args.fileId,
        lines: receipt.items.map((line) => ({
          description: line.description,
          qty: line.qty,
          unit_cost: priceOk ? lineUnitCost(lineDiscounted(line) ? null : line.unit_price, lineNet(line), line.qty) : null,
          line_amount: priceOk ? lineNet(line) : null,
          ...(line.kind ? { kind: line.kind } : {}),
        })),
        claim: { index: receipt.items.indexOf(unit), kind, id: args.id },
      },
    })) as { ok?: boolean; order_id?: string } | null;
    orderId = r?.ok ? (r.order_id ?? null) : null;
  } catch {
    // Purchases is off in this workspace: the record still gets its facts.
    purchasesOff = true;
  }
  return {
    read: true,
    document: receipt.document === "bill-of-sale" ? "bill-of-sale" : "receipt",
    from,
    total: priceOk ? receipt.total : null,
    order_id: orderId,
    purchases_off: purchasesOff,
    filled,
    conflicts,
    held,
    waiting,
  };
}
