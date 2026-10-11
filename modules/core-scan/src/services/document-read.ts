// A document read off a page, checked, made right by its VIN, and read again
// by the document model only when a check fails (#4571).
//
// The order is the platform's rule (heuristic first, AI last):
//   1. the engine's read (a form read the way a form is, form-ocr.ts);
//   2. the checks (document-checks.ts): the VIN's check digit, the year
//      against the VIN, the lines against the taxable amount and the total,
//      the deposit against the total less the balance, a name that is words;
//   3. a VIN the check digit proves is the authority for what the vehicle IS:
//      its model year offline (position 10), its make and model from the
//      vehicle database (vPIC, cached, the same lookup the record's Decode
//      button makes), and its name ("2019 Honda Civic Hatchback EX");
//   4. only when a check still fails, the whole page goes to the workspace's
//      document model (the `document-read` capability, a Flash-class model on
//      every provider, never a Lite one), and its answer goes through the SAME
//      reader and the SAME checks: every tier makes mistakes (a measured Lite
//      read misread a VIN's first character; a Sonnet read a deposit off by a
//      hundred), and the arithmetic is what catches them;
//   5. what still does not pass is marked for a person to check, field by
//      field. When every document model is busy the document waits for one
//      ("will read when the AI is free"); it is never read by a weaker model.

import sharp from "sharp";
import { platform } from "@cobblr/platform-contract";
import { refusalCodeOf } from "@cobblr/platform-contract/ai-refusal";
import { isSaleDocumentLabel, readBillOfSale, readDocumentFigures, readVin } from "./bill-of-sale.js";
import { checkBillOfSale, confirmVinCandidate, fieldsToCheck, looksLikeWords, NO_FIGURES, type DocumentVerdict } from "./document-checks.js";
import { decodeVin, vinTitle } from "./vin-decode.js";
import { decodeCacheKey, readDecodeCache, writeDecodeCache } from "./decode-cache.js";
import type { DecodeResult } from "./identifier-registry.js";
import type { ParsedReceipt } from "./receipt-shared.js";

/** What the document model is asked. Every value copied as printed, so the
 *  checks can judge it; a field the page does not print is null. */
export const DOCUMENT_READ_PROMPT = [
  "You are reading one scanned page of a sale document (a dealer's retail order, a bill of sale, an invoice).",
  "Copy what the page PRINTS. Do not correct, guess or complete anything; a field the page does not show is null.",
  "Reply with ONLY this JSON:",
  '{"document": "bill-of-sale" | "invoice" | "receipt" | "other",',
  ' "seller": the dealer or seller\'s name as printed (the business name, not a d/b/a line), or null,',
  ' "date": the sale date as printed, or null,',
  ' "vehicle": {"year": "...", "make": "...", "model": "...", "vin": "the 17 characters exactly as printed", "odometer": "..."} or null,',
  ' "lines": [{"label": "the line\'s caption as printed", "amount": "the amount as printed"}] for EVERY priced line in order down the page, the price of the thing first, fees and taxes after,',
  ' "taxable": the taxable amount as printed, or null,',
  ' "total": the total as printed, or null,',
  ' "deposit": the deposit or amount paid down as printed, or null,',
  ' "balance": the balance due on delivery as printed, or null}',
  "Where a value was written over by hand, give the one the page's own arithmetic supports, and copy nothing you cannot read.",
].join("\n");

const valueOrNull = { type: ["string", "number", "null"] };
/** The shape DOCUMENT_READ_PROMPT asks for, sent with the read so a model
 *  answering in a layout of its own is caught (#5790). */
export const DOCUMENT_READ_OUTPUT_SCHEMA = {
  type: "object",
  required: ["document", "lines"],
  properties: {
    document: { type: ["string", "null"] },
    seller: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    vehicle: { type: ["object", "null"], properties: { year: valueOrNull, make: valueOrNull, model: valueOrNull, vin: valueOrNull, odometer: valueOrNull } },
    lines: { type: ["array", "null"], items: { type: "object", properties: { label: { type: ["string", "null"] }, amount: valueOrNull } } },
    taxable: valueOrNull,
    total: valueOrNull,
    deposit: valueOrNull,
    balance: valueOrNull,
  },
} as const;

interface DocumentJson {
  document?: string | null;
  seller?: string | null;
  date?: string | null;
  vehicle?: { year?: string | number | null; make?: string | null; model?: string | null; vin?: string | null; odometer?: string | number | null } | null;
  lines?: Array<{ label?: string | null; amount?: string | number | null }> | null;
  taxable?: string | number | null;
  total?: string | number | null;
  deposit?: string | number | null;
  balance?: string | number | null;
}

/** The model's answer as the text a form read gives ("Label: value" lines and
 *  money lines), so it goes through the same reader and the same checks as
 *  the engine's read. Null when the reply is not the JSON asked for. */
export function documentJsonAsText(reply: string): string | null {
  const m = /\{[\s\S]*\}/.exec(reply);
  if (!m) return null;
  let j: DocumentJson;
  try {
    j = JSON.parse(m[0]) as DocumentJson;
  } catch {
    return null;
  }
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
  const out: string[] = [];
  if (str(j.seller)) out.push(str(j.seller));
  // Whatever the model called it, a page of the sale-document family is read
  // as the sale it records; one it named as something else is not a sale.
  if (isSaleDocumentLabel(j.document)) out.push("BILL OF SALE");
  const v = j.vehicle ?? {};
  if (str(v.vin)) out.push(`VIN: ${str(v.vin)}`);
  if (str(v.year)) out.push(`Year: ${str(v.year)}`);
  if (str(v.make)) out.push(`Make: ${str(v.make)}`);
  if (str(v.model)) out.push(`Model: ${str(v.model)}`);
  if (str(v.odometer)) out.push(`Odometer: ${str(v.odometer)}`);
  if (str(j.date)) out.push(`Date: ${str(j.date)}`);
  const amount = (a: unknown) => {
    const n = Number(str(a).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n.toFixed(2) : null;
  };
  (j.lines ?? []).forEach((l, i) => {
    const a = amount(l.amount);
    if (!a || !str(l.label)) return;
    // The first line is the thing sold; say so in the words the reader keys
    // on, whatever the form called it.
    out.push(`${i === 0 && !/price|unit|vehicle/i.test(str(l.label)) ? "PRICE OF UNIT" : str(l.label).toUpperCase()} ${a}`);
  });
  for (const [label, value] of [["TAXABLE AMOUNT", j.taxable], ["TOTAL", j.total], ["DEPOSIT", j.deposit], ["BALANCE ON DELIVERY", j.balance]] as const) {
    const a = amount(value);
    if (a) out.push(`${label} ${a}`);
  }
  return out.join("\n");
}

/** A VIN through the vehicle database, cached the way the scan path's decode
 *  is (a decode is forever, an outage never cached). */
async function decodeVinFor(orgId: string, vin: string): Promise<DecodeResult> {
  let db: Parameters<typeof readDecodeCache>[0] | null = null;
  try {
    db = (await platform().tenants.getDb(orgId)) as unknown as Parameters<typeof readDecodeCache>[0];
  } catch {
    db = null;
  }
  const key = decodeCacheKey(vin);
  const cached = db ? await readDecodeCache(db, "vin", key).catch(() => null) : null;
  if (cached) return cached;
  const result = await decodeVin(vin);
  if (db) await writeDecodeCache(db, "vin", key, result).catch(() => {});
  return result;
}

/** The unit line made right by its VIN: the year from the VIN, the make and
 *  model and the name from the vehicle database. What the page printed stays
 *  where the database is silent. */
function withVinAuthority(receipt: ParsedReceipt, vin: string, year: number | null, decoded: DecodeResult | null): ParsedReceipt {
  const unit = receipt.items[0];
  if (!unit) return receipt;
  const prior = (unit as { decoded?: { fields?: Record<string, unknown> } }).decoded?.fields ?? {};
  const hit = decoded && (decoded.outcome === "hit" || decoded.outcome === "partial") ? decoded.fields : {};
  const fields: Record<string, string | number> = {};
  for (const [k, val] of Object.entries({ ...prior, ...hit })) if (typeof val === "string" || typeof val === "number") fields[k] = val;
  fields.vin = vin;
  if (year) fields.year = year;
  const named = hit.make || hit.model ? vinTitle(fields) : "";
  const facts = { ...((unit as { facts?: Record<string, unknown> }).facts ?? {}), ...(year ? { "year-made": year } : {}) };
  const description = named || (looksLikeWords(unit.description) ? unit.description : `${year ?? ""} vehicle`.trim());
  const items = [
    {
      ...unit,
      description,
      ...(typeof hit.make === "string" ? { manufacturer: hit.make } : {}),
      ...(typeof hit.model === "string" ? { model: hit.model } : {}),
      facts,
      decoded: { decoder_id: "vin", code: vin, fields },
    },
    ...receipt.items.slice(1),
  ] as ParsedReceipt["items"];
  return { ...receipt, items };
}

export interface CheckedDocument {
  receipt: ParsedReceipt;
  verdict: DocumentVerdict;
}

/** Check a read and let a proved VIN set what the vehicle is. */
export async function checkAndSettle(orgId: string, receipt: ParsedReceipt, text: string, now: Date = new Date()): Promise<CheckedDocument> {
  const raw = readVin(text);
  let verdict = checkBillOfSale(receipt, raw, readDocumentFigures(text), now);
  let decoded: DecodeResult | null = null;
  if (verdict.vin_candidate) {
    // A look-alike swap made good only by the vehicle database decoding it,
    // to the make the page prints.
    const cand = await decodeVinFor(orgId, verdict.vin_candidate);
    const formMake = ((receipt.items[0] as { decoded?: { fields?: { make?: unknown } } } | undefined)?.decoded?.fields?.make as string | undefined) ?? null;
    const clean = cand.outcome === "hit";
    verdict = confirmVinCandidate(verdict, { clean, make: typeof cand.fields?.make === "string" ? (cand.fields.make as string) : null }, formMake, now);
    if (verdict.vin) decoded = cand;
  }
  if (!verdict.vin) return { receipt, verdict };
  decoded ??= await decodeVinFor(orgId, verdict.vin);
  return { receipt: withVinAuthority(receipt, verdict.vin, verdict.vin_year, decoded), verdict };
}

/** The page read by the workspace's document model, or why not. `busy`: every document model is busy now. `limit`: its allowance is used
 *  up for now (a daily quota, the workspace's plan). Either way the document
 *  waits for a read, and never takes a weaker one meanwhile (#4633). */
export type DocumentAiRead = { ok: true; text: string; model: string | null } | { ok: false; busy: boolean; limit?: boolean; error?: unknown };

export async function readPageWithDocumentModel(orgId: string, page: Buffer, sourceId: string, userId?: string | null): Promise<DocumentAiRead> {
  // Page images only (a PDF is not every provider's to take); a page past
  // the size a vision model reads well is brought down to it.
  const png = await sharp(page).rotate().resize({ width: 1700, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  try {
    const r = await platform().ai.invoke({
      orgId,
      userId: userId ?? undefined,
      capability: "document-read",
      input: { image_b64: png.toString("base64"), image_media_type: "image/png", prompt: DOCUMENT_READ_PROMPT, output_schema: DOCUMENT_READ_OUTPUT_SCHEMA },
      source: { kind: "core-scan:document", id: sourceId },
    });
    const text = documentJsonAsText(r.text);
    if (!text) return { ok: false, busy: false };
    return { ok: true, text, model: (r as { model?: string }).model ?? null };
  } catch (e) {
    // Every document model busy: the document waits for one. Never read by a
    // weaker model (the capability's ladder never steps down to one).
    // Read by its shape, not instanceof: a second copy of the contract module
    // (a bundled provider, a test) makes a refusal that is not "an instance".
    if (refusalCodeOf(e) === "provider_error" && (e as { reason?: unknown }).reason === "busy") return { ok: false, busy: true, error: e };
    // Out of its allowance for now: the same wait, said as what it is.
    if (refusalCodeOf(e) === "not_entitled" || (refusalCodeOf(e) === "provider_error" && (e as { reason?: unknown }).reason === "quota")) return { ok: false, busy: false, limit: true, error: e };
    return { ok: false, busy: false, error: e };
  }
}

/** The fields to check and why, on a receipt, from a verdict. */
export function withChecks(receipt: ParsedReceipt, verdict: DocumentVerdict, waitingForAi: false | "busy" | "limit" | true = false): ParsedReceipt {
  if (verdict.ok && !waitingForAi) {
    const { checks: _c, ...rest } = receipt;
    return rest;
  }
  return {
    ...receipt,
    checks: {
      fields: fieldsToCheck(verdict),
      why: verdict.failed.map((f) => f.why),
      ...(waitingForAi ? { waiting_for_ai: true, ...(waitingForAi === "limit" ? { waiting_reason: "limit" as const } : {}) } : {}),
    },
  };
}

/** Why a read waits, or false when it does not. */
export function waitsFor(ai: DocumentAiRead): false | "busy" | "limit" {
  if (ai.ok) return false;
  return ai.limit ? "limit" : ai.busy ? "busy" : false;
}

/** A page the engine read, checked and made right by its VIN by code alone:
 *  no model (a personal document, #5331; a read told to ask none). What fails
 *  a check is marked to check, as on any read. */
export async function checkedByCode(orgId: string, ocr: { receipt: ParsedReceipt; text: string }, now: Date = new Date()): Promise<ParsedReceipt> {
  const first = await checkAndSettle(orgId, ocr.receipt, ocr.text, now);
  return withChecks(first.receipt, first.verdict);
}

/**
 * A document page, read by the engine, checked, and read by the document
 * model when a check fails. `ocr` is the engine's read (text and the receipt
 * the reader made of it); null when the engine read nothing a reader could
 * use, which goes straight to the model.
 */
export async function readCheckedDocument(opts: {
  orgId: string;
  page: Buffer;
  sourceId: string;
  userId?: string | null;
  ocr: { receipt: ParsedReceipt; text: string } | null;
  now?: Date;
}): Promise<{ receipt: ParsedReceipt; text: string; method: "ocr" | "ai-document" } | { busy: true; partial: { receipt: ParsedReceipt; text: string } | null } | null> {
  const now = opts.now ?? new Date();
  const first = opts.ocr ? await checkAndSettle(opts.orgId, opts.ocr.receipt, opts.ocr.text, now) : null;
  if (first?.verdict.ok) return { receipt: withChecks(first.receipt, first.verdict), text: opts.ocr!.text, method: "ocr" };

  const ai = await readPageWithDocumentModel(opts.orgId, opts.page, opts.sourceId, opts.userId);
  if (ai.ok) {
    const sale = readBillOfSale(ai.text);
    if (sale) {
      const second = await checkAndSettle(opts.orgId, sale, ai.text, now);
      // The model's read wins when it passes, or when it fails fewer checks
      // than the engine's; either way what still fails is marked to check.
      if (!first || second.verdict.failed.length <= first.verdict.failed.length) {
        return { receipt: withChecks(second.receipt, second.verdict), text: ai.text, method: "ai-document" };
      }
    }
  }
  const waiting = waitsFor(ai);
  if (!first || !opts.ocr) return waiting ? { busy: true, partial: null } : null;
  if (waiting) return { busy: true, partial: { receipt: withChecks(first.receipt, first.verdict, waiting), text: opts.ocr.text } };
  return { receipt: withChecks(first.receipt, first.verdict), text: opts.ocr.text, method: "ocr" };
}

/**
 * A bill of sale read from TEXT (a PDF's text layer, an email): its
 * characters are exact, so the checks that catch a misread digit (the VIN's
 * check digit, the year against it, the sums) are not asked; the ones that
 * catch a value that is not one are: a seller that is a sentence of the form,
 * a make or model read across the form's captions (#4633).
 */
export function withTextChecks(receipt: ParsedReceipt, now: Date = new Date()): ParsedReceipt {
  const verdict = checkBillOfSale(receipt, null, NO_FIGURES, now);
  const failed = verdict.failed.filter((f) => f.check === "seller" || f.check === "title");
  return withChecks(receipt, { ...verdict, ok: failed.length === 0, failed });
}
