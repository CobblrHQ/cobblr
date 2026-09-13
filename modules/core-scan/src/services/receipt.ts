// Receipt / invoice parsing — turn an uploaded receipt into line items.
//
// Tiered, deterministic-first (mirrors the barcode path's heuristic-floor →
// AI-fallback shape):
//
//   CSV          → parseCsvReceipt           (header-mapped, no AI)
//   text PDF     → parsePdfTableReceipt      (pdf-parse getTable, no AI)
//                  └ no usable table → parseTextReceipt (line-wise, no AI)
//                     └ doesn't reconcile → core-ai `chat` on the text
//   plain text   → parseTextReceipt (no AI) → core-ai `chat`
//   image        → OCR (tesseract, no AI) → parseTextReceipt
//                  └ no engine, or doesn't reconcile → core-ai `classify-image`
//   scanned PDF  → no text → "upload a photo instead"
//
// The text tier only wins when the line items ADD UP to the receipt's own
// subtotal, so it can never beat AI with a confident wrong answer — see
// receipt-text.ts.
//
// The caller drops one scan-inbox row per line item (source_kind "receipt") so
// each line rides the SAME matchmaker + confirm flow a barcode/photo scan does
// — a receipt becomes N parts without retyping. Mirrors the invoice-parse path.

import { platform } from "@cobblr/platform-contract";
import { classifyAiFailure } from "@cobblr/platform-contract/ai-refusal";
import { providerReasonOf } from "@cobblr/platform-contract/provider-reason";
import { receiptReadWords } from "@cobblr/platform-contract/scan-session";
import { hostedIdentify, hostedIdentifyEnabled, receiptAsModelReply } from "./hosted-identify.js";
import {
  buildReceipt,
  type ParsedReceipt,
  type ParseMethod,
  type ReceiptResult,
  enrichReceiptFromText,
} from "./receipt-shared.js";
import {
  enrichReceiptMeta,
  parseCsvReceipt,
  parsePdfTableReceipt,
} from "./receipt-deterministic.js";
import { detectOrderRef, parseTextReceipt } from "./receipt-text.js";
import { ocrImageText } from "./ocr.js";
import { readReceiptDate, workspaceConventionFrom, type DateConvention, type ReceiptDateReading } from "./receipt-date.js";

// Re-export the shared types + the pure shaper so existing importers (the route,
// the unit test) keep their import site.
export type { ReceiptLine, ParsedReceipt, ReceiptResult, ParseMethod } from "./receipt-shared.js";

const SCHEMA_INSTRUCTION =
  "Reply with ONLY a JSON object, no prose:\n" +
  '{"vendor":<string|null>,"order_ref":<string|null>,"date":<"YYYY-MM-DD"|null>,"currency":<ISO-4217 code|null>,' +
  '"total":<number|null grand total>,"items":[{"description":<string>,"qty":<number>,' +
  '"unit_price":<number|null>,"line_total":<number|null>,"discount":<number|null>,' +
  '"code":<string|null>,"model":<string|null>,"weight":<number|null>,"weight_unit":<"lb"|"kg"|"oz"|"g"|null>}]}\n' +
  "An item sold BY WEIGHT (a printed weight and a per-lb or per-kg price, e.g. 4.14 lb at 1.99/lb) " +
  "gets weight + weight_unit, qty 1, and unit_price = the per-unit price. Never round a weight into qty.\n" +
  "One entry per PURCHASED line item. Skip subtotal / tax / shipping / total rows — " +
  "capture the grand total in \"total\" instead. qty defaults to 1 when " +
  "no count is shown. Prices are numbers only (strip currency symbols and thousands " +
  'separators). "order_ref" is the order/invoice/confirmation number if the receipt ' +
  "states one (the bare identifier only, e.g. \"384602\" not \"Order #384602\"). " +
  "Use null for anything not printed on the receipt.\n" +
  // A coupon is not a thing anyone owns, so it must never become an item of its
  // own; but dropping it silently records the shopper paying the pre-coupon
  // price, which is simply wrong. It belongs to the line it discounts.
  "A COUPON or DISCOUNT line printed beneath an item (\"Points Coupon -0.49\", " +
  '"Member Savings -1.00") belongs to THAT item: add its amount to that item\'s ' +
  '"discount" as a positive number, and never give it an entry of its own. Two ' +
  "coupons under one item add together. Leave \"line_total\" as the price the item " +
  "was rung up at, before the coupon. A discount applying to the WHOLE order " +
  "rather than to one item is not an item either — leave it out; the grand total " +
  "already accounts for it.\n" +
  "The items you return, each less its own discount, should add up to the " +
  "subtotal printed on the receipt. If they do not, you have missed a line or a " +
  "coupon — re-read it.\n" +
  // Supermarket tills print the product's own UPC beside the description. It is
  // the single most useful thing on the line — it resolves to a real catalog
  // name and picture — and it was being thrown away.
  '"code" is the product number printed ON that line (a UPC/EAN/PLU, digits ' +
  "only, no spaces), when the receipt shows one. Read it verbatim, never guess " +
  "or complete a partial one, and leave it null when the line shows no code. Do " +
  "NOT put the receipt's own transaction, store, terminal or survey numbers " +
  "here: those belong to the visit, not to an item. " +
  '"model" is the MANUFACTURER model number when the line prints one ' +
  '("Model #: GA605WI-XS96", "Model/SKU", "Part #"). Alphanumeric and often ' +
  "hyphenated, so copy it exactly and do NOT reduce it to digits. It is a " +
  'DIFFERENT field from "code": a UPC identifies the package a shop sold, a ' +
  "model identifies the thing itself across every shop that sells it. Online " +
  "order emails print it routinely. Null when the line shows none.";

/** Shape a model's (possibly messy) JSON reply into a ParsedReceipt. Pure +
 *  tolerant (first JSON object, price coercion, blank-line drop) so it's
 *  unit-testable without an AI call. Returns null when there are no line items. */
export function shapeReceipt(raw: string): ParsedReceipt | null {
  const m = raw.match(/\{[\s\S]*\}/);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
  return buildReceipt({
    vendor: parsed.vendor,
    order_ref: parsed.order_ref,
    date: parsed.date,
    currency: parsed.currency,
    total: parsed.total,
    items: itemsRaw.map((it) => (it ?? {}) as Record<string, unknown>),
  });
}

function aiText(r: { result: unknown }): string {
  const res = r.result as { text?: string; content?: string };
  return res.text ?? res.content ?? "";
}

async function chatExtract(orgId: string, text: string, sourceId: string, userId?: string | null): Promise<string> {
  const r = await platform().ai.invoke({
    orgId,
    userId: userId ?? undefined,
    capability: "chat",
    input: {
      messages: [
        {
          role: "system",
          content: "You read a purchase receipt or invoice and extract its line items. " + SCHEMA_INSTRUCTION,
        },
        { role: "user", content: text.slice(0, 12_000) },
      ],
    },
    source: { kind: "core-scan:receipt", id: sourceId },
  });
  return aiText(r);
}

/** The exact instruction the image tier sends to the model.
 *
 *  Exported because the recorded receipt fixtures are captured against it: the
 *  recorder sends THIS string and the replay test asserts its cassette was
 *  recorded from THIS string. Editing the prompt then fails the test with
 *  "re-record" rather than silently replaying an answer to a question that is
 *  no longer being asked. One definition, two readers. */
export const RECEIPT_VISION_PROMPT =
  "This is a photo of a purchase receipt or invoice. Read it and extract its line items. " +
  SCHEMA_INSTRUCTION;

async function visionExtract(
  orgId: string,
  imageB64: string,
  mediaType: string,
  sourceId: string,
  userId?: string | null,
  visitorIp?: string | null,
): Promise<string> {
  // Hosted first (see hosted-identify.ts). The endpoint returns core's own
  // receipt schema, so a stringify is the whole shim and the parser downstream
  // never learns which engine answered. We send OUR receipt prompt - its
  // recorded fixtures pin the exact text, and the endpoint honors the override.
  if (hostedIdentifyEnabled()) {
    const hosted = await hostedIdentify({ orgId, imageB64, receiptPrompt: RECEIPT_VISION_PROMPT, visitorIp, userId });
    if (hosted?.kind === "receipt" && hosted.receipt) return receiptAsModelReply(hosted.receipt);
    // Any other outcome - an item mistaken for a receipt upstream, a hosted
    // outage - falls through to the tenant path this call always had.
  }
  const r = await platform().ai.invoke({
    orgId,
    userId: userId ?? undefined,
    capability: "classify-image",
    input: {
      image_b64: imageB64,
      image_media_type: mediaType,
      prompt: RECEIPT_VISION_PROMPT,
    },
    source: { kind: "core-scan:receipt", id: sourceId },
  });
  return aiText(r);
}

/** The AI failed: the router's coded reason rides the result (the session's
 *  verdict reads the code), and the sentence is for the toast. */
function aiFailed(e: unknown, userId: string | null | undefined): Extract<ReceiptResult, { ok: false }> {
  const ai = classifyAiFailure(e, { hadUser: !!userId });
  const ai_reason = providerReasonOf(e) ?? undefined;
  const words = receiptReadWords({ code: "ai_unavailable", ai, ai_reason, reason: "" });
  return { ok: false, reason: words.sentence, code: "ai_unavailable", ai, ...(ai_reason ? { ai_reason } : {}) };
}

/** Extract a text PDF's full text + discovered tables. Either may be empty. */
async function readPdf(bytes: Buffer): Promise<{ text: string; tables: string[][][] } | null> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    let tables: string[][][] = [];
    try {
      tables = (await parser.getTable()).mergedTables as string[][][];
    } catch {
      tables = [];
    }
    const text = (await parser.getText()).text ?? "";
    await parser.destroy().catch(() => {});
    return { text, tables };
  } catch {
    return null;
  }
}

/** The convention this workspace's earlier receipts established, read off
 *  their sessions; null with nothing to go on, or when the tenant cannot be
 *  read (a unit test's platform has no tenants). */
async function workspaceDateConvention(orgId: string): Promise<DateConvention | null> {
  try {
    const db = (await platform().tenants.getDb(orgId)) as unknown as {
      selectFrom: (t: string) => {
        select: (c: string[]) => {
          where: (c: string, op: string, v: unknown) => {
            orderBy: (c: string, d: string) => { limit: (n: number) => { execute: () => Promise<Array<{ date_convention: string | null; date_decided_by: string | null }>> } };
          };
        };
      };
    };
    const rows = await db
      .selectFrom("core_scan_batches")
      .select(["date_convention", "date_decided_by"])
      .where("date_convention", "is not", null)
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();
    return workspaceConventionFrom(rows);
  } catch {
    return null;
  }
}

/** Parse a receipt file (CSV, PDF, or image, already stored in core-files) into
 *  a ParsedReceipt. Deterministic tiers run first; AI is the fallback. Never
 *  throws — every failure is a typed `{ ok:false, reason }`. */
/**
 * What the receipt prints, read from its text onto a parse that left it
 * null: the order reference, then the header meta (vendor, date, total,
 * currency) and what the lines cannot say (seller, totals, arrival). The
 * one rule for every tier, so a field printed on the paper reaches the
 * session whether the lines came from a table, the line parser, the OCR
 * engine or a model. A value the tier established stands. No text, no
 * change.
 */
export function printedReceiptMeta(receipt: ParsedReceipt, text: string | null | undefined): ParsedReceipt {
  if (!text?.trim()) return receipt;
  const withRef = { ...receipt, order_ref: receipt.order_ref ?? detectOrderRef(text) };
  return enrichReceiptFromText(enrichReceiptMeta(withRef, text), text);
}

export async function parseReceipt(
  orgId: string,
  fileId: string,
  userId?: string | null,
  visitorIp?: string | null,
): Promise<ReceiptResult> {
  const file = await platform().files.read(orgId, fileId, "original");
  if (!file) return { ok: false, reason: "Couldn't read that file.", code: "unreadable" };
  const bytes = Buffer.from(file.bytes);
  const mime = file.mimeType || "";
  const isPdf = mime === "application/pdf" || bytes.subarray(0, 5).toString("latin1").startsWith("%PDF");
  const isImage = mime.startsWith("image/");
  const looksCsv = /csv|excel|spreadsheet/.test(mime) || (!isPdf && !isImage);

  // Every successful tier goes out through here. What the receipt PRINTS is
  // read from its own text at this one door, whichever tier read the lines:
  // the order reference and the header meta (printedReceiptMeta, #2964), and
  // the date by the platform's rule (receipt-date.ts), never left to a
  // model's habit, with the reading riding the result so the session can
  // record which way round a numeric date went (#2917). A value a tier
  // already established (a model-read order reference) stands; the text
  // fills only what the tier left null. A tier with no text (vision on a
  // machine with no OCR engine) keeps the model's answer and says so.
  const done = async (parsed: ParsedReceipt, method: ParseMethod, text: string | null): Promise<ReceiptResult> => {
    const receipt = printedReceiptMeta(parsed, text);
    const reading: ReceiptDateReading = readReceiptDate({
      text,
      iso: receipt.date,
      workspace: text ? await workspaceDateConvention(orgId) : null,
    });
    return { ok: true, receipt: { ...receipt, date: reading.date ?? receipt.date }, method, date_reading: reading };
  };

  // ── Tier 1: CSV (deterministic) ────────────────────────────────────────────
  if (looksCsv && !isPdf && !isImage) {
    const csv = parseCsvReceipt(bytes.toString("utf8"));
    if (csv) return done(csv, "csv", bytes.toString("utf8"));
    // A text file that isn't a recognisable CSV → let AI read it as text below.
  }

  // ── Tier 2: PDF — deterministic table first, AI on the text otherwise ───────
  if (isPdf) {
    const pdf = await readPdf(bytes);
    if (!pdf) return { ok: false, reason: "Couldn't read that PDF.", code: "unreadable" };
    const table = parsePdfTableReceipt(pdf.tables);
    if (table) return done(table, "pdf-table", pdf.text);
    if (!pdf.text.trim()) {
      return {
        ok: false,
        reason: "That PDF has no extractable text (a scan?). Upload a photo of the receipt instead.",
        // Not recoverable by replaying the same bytes: it needs a different
        // input, which is what the message asks for.
        code: "unreadable",
      };
    }
    // No ruled table, but a till-style PDF is still line-structured. Free, and
    // it only accepts a parse whose items reconcile.
    const byLine = parseTextReceipt(pdf.text);
    if (byLine) return done(byLine.receipt, "text-lines", pdf.text);
    try {
      const receipt = shapeReceipt(await chatExtract(orgId, pdf.text, fileId, userId));
      if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" };
      // The model is asked for line items; the totals, the seller, the ETA
      // and the order reference are read from the same text at the door.
      return done(receipt, "ai-chat", pdf.text);
    } catch (e) {
      return aiFailed(e, userId);
    }
  }

  // ── Tier 3: image → OCR + the line parser, then AI vision ──────────────────
  if (isImage) {
    // The engine is optional and the parse is gated: it only wins when the
    // lines add up to the receipt's own subtotal, so a mangled read declines
    // to the model rather than shipping a wrong answer that looks right. The
    // fallback is vision, not chat on the OCR text: if the text was not good
    // enough to reconcile, the text is the weak link, and the model should
    // look at the picture itself (no-ai-receipt-reading.md §5.3).
    const read = await ocrImageText(bytes);
    if (read) {
      const byLine = parseTextReceipt(read.text);
      if (byLine) return done(byLine.receipt, "ocr-lines", read.text);
    }
    try {
      const receipt = shapeReceipt(await visionExtract(orgId, bytes.toString("base64"), mime, fileId, userId, visitorIp));
      if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" };
      // The engine's text, when it read any, is the evidence for the date
      // even though the lines came from the model.
      return done(receipt, "ai-vision", read?.text ?? null);
    } catch (e) {
      return aiFailed(e, userId);
    }
  }

  // ── Non-CSV text file → line-wise parse first, AI on the raw text ──────────
  const asText = bytes.toString("utf8");
  const byLine = parseTextReceipt(asText);
  if (byLine) return done(byLine.receipt, "text-lines", asText);
  try {
    const receipt = shapeReceipt(await chatExtract(orgId, asText, fileId, userId));
    if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" };
    return done(receipt, "ai-chat", asText);
  } catch (e) {
    return aiFailed(e, userId);
  }
}
