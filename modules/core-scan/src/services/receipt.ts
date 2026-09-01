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
//   image        → core-ai `classify-image`  (vision OCR + structuring)
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
import { hostedIdentify, hostedIdentifyEnabled, receiptAsModelReply } from "./hosted-identify.js";
import {
  buildReceipt,
  type ParsedReceipt,
  type ReceiptResult,
  enrichReceiptFromText,
} from "./receipt-shared.js";
import {
  enrichReceiptMeta,
  parseCsvReceipt,
  parsePdfTableReceipt,
} from "./receipt-deterministic.js";
import { parseTextReceipt } from "./receipt-text.js";

// Re-export the shared types + the pure shaper so existing importers (the route,
// the unit test) keep their import site.
export type { ReceiptLine, ParsedReceipt, ReceiptResult, ParseMethod } from "./receipt-shared.js";

const SCHEMA_INSTRUCTION =
  "Reply with ONLY a JSON object, no prose:\n" +
  '{"vendor":<string|null>,"order_ref":<string|null>,"date":<"YYYY-MM-DD"|null>,"currency":<ISO-4217 code|null>,' +
  '"total":<number|null grand total>,"items":[{"description":<string>,"qty":<number>,' +
  '"unit_price":<number|null>,"line_total":<number|null>,"discount":<number|null>,' +
  '"code":<string|null>,"model":<string|null>}]}\n' +
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

function aiError(e: unknown): string {
  const provider = e instanceof Error && /provider|capability|budget/i.test(e.message);
  return provider
    ? "No AI provider is set up for this workspace yet (Configuration → AI)."
    : "AI is unavailable right now.";
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

/** Parse a receipt file (CSV, PDF, or image, already stored in core-files) into
 *  a ParsedReceipt. Deterministic tiers run first; AI is the fallback. Never
 *  throws — every failure is a typed `{ ok:false, reason }`. */
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

  // ── Tier 1: CSV (deterministic) ────────────────────────────────────────────
  if (looksCsv && !isPdf && !isImage) {
    const csv = parseCsvReceipt(bytes.toString("utf8"));
    if (csv) return { ok: true, receipt: csv, method: "csv" };
    // A text file that isn't a recognisable CSV → let AI read it as text below.
  }

  // ── Tier 2: PDF — deterministic table first, AI on the text otherwise ───────
  if (isPdf) {
    const pdf = await readPdf(bytes);
    if (!pdf) return { ok: false, reason: "Couldn't read that PDF.", code: "unreadable" };
    const table = parsePdfTableReceipt(pdf.tables);
    if (table) {
      return { ok: true, receipt: enrichReceiptMeta(table, pdf.text), method: "pdf-table" };
    }
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
    if (byLine) return { ok: true, receipt: byLine.receipt, method: "text-lines" };
    try {
      const receipt = shapeReceipt(await chatExtract(orgId, pdf.text, fileId, userId));
      if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" };
      // The model is asked for line items; the totals, the seller and the ETA
      // are read deterministically from the same text rather than trusted to it.
      return { ok: true, receipt: enrichReceiptFromText(receipt, pdf.text), method: "ai-chat" };
    } catch (e) {
      return { ok: false, reason: aiError(e), code: "ai_unavailable" };
    }
  }

  // ── Tier 3: image → AI vision ──────────────────────────────────────────────
  if (isImage) {
    try {
      const receipt = shapeReceipt(await visionExtract(orgId, bytes.toString("base64"), mime, fileId, userId, visitorIp));
      if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" };
      return { ok: true, receipt, method: "ai-vision" };
    } catch (e) {
      return { ok: false, reason: aiError(e), code: "ai_unavailable" };
    }
  }

  // ── Non-CSV text file → line-wise parse first, AI on the raw text ──────────
  const asText = bytes.toString("utf8");
  const byLine = parseTextReceipt(asText);
  if (byLine) return { ok: true, receipt: byLine.receipt, method: "text-lines" };
  try {
    const receipt = shapeReceipt(await chatExtract(orgId, asText, fileId, userId));
    if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" };
    return { ok: true, receipt: enrichReceiptFromText(receipt, asText), method: "ai-chat" };
  } catch (e) {
    return { ok: false, reason: aiError(e), code: "ai_unavailable" };
  }
}
