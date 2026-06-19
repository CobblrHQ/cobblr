// Receipt / invoice parsing — turn an uploaded receipt into line items.
//
// Tiered, deterministic-first (mirrors the barcode path's heuristic-floor →
// AI-fallback shape):
//
//   CSV          → parseCsvReceipt           (header-mapped, no AI)
//   text PDF     → parsePdfTableReceipt      (pdf-parse getTable, no AI)
//                  └ no usable table → core-ai `chat` on the text
//   image        → core-ai `classify-image`  (vision OCR + structuring)
//   scanned PDF  → no text → "upload a photo instead"
//
// The caller drops one scan-inbox row per line item (source_kind "receipt") so
// each line rides the SAME matchmaker + confirm flow a barcode/photo scan does
// — a receipt becomes N parts without retyping. Mirrors companion app's parseInvoice*.

import { platform } from "@cobblr/platform-contract";
import {
  buildReceipt,
  type ParsedReceipt,
  type ReceiptResult,
} from "./receipt-shared.js";
import {
  enrichReceiptMeta,
  parseCsvReceipt,
  parsePdfTableReceipt,
} from "./receipt-deterministic.js";

// Re-export the shared types + the pure shaper so existing importers (the route,
// the unit test) keep their import site.
export type { ReceiptLine, ParsedReceipt, ReceiptResult, ParseMethod } from "./receipt-shared.js";

const SCHEMA_INSTRUCTION =
  "Reply with ONLY a JSON object, no prose:\n" +
  '{"vendor":<string|null>,"date":<"YYYY-MM-DD"|null>,"currency":<ISO-4217 code|null>,' +
  '"total":<number|null grand total>,"items":[{"description":<string>,"qty":<number>,' +
  '"unit_price":<number|null>,"line_total":<number|null>}]}\n' +
  "One entry per PURCHASED line item. Skip subtotal / tax / shipping / discount / " +
  "total rows — capture the grand total in \"total\" instead. qty defaults to 1 when " +
  "no count is shown. Prices are numbers only (strip currency symbols and thousands " +
  "separators). Use null for anything not printed on the receipt.";

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

async function chatExtract(orgId: string, text: string, sourceId: string): Promise<string> {
  const r = await platform().ai.invoke({
    orgId,
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

async function visionExtract(
  orgId: string,
  imageB64: string,
  mediaType: string,
  sourceId: string,
): Promise<string> {
  const r = await platform().ai.invoke({
    orgId,
    capability: "classify-image",
    input: {
      image_b64: imageB64,
      image_media_type: mediaType,
      prompt:
        "This is a photo of a purchase receipt or invoice. Read it and extract its line items. " +
        SCHEMA_INSTRUCTION,
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
export async function parseReceipt(orgId: string, fileId: string): Promise<ReceiptResult> {
  const file = await platform().files.read(orgId, fileId, "original");
  if (!file) return { ok: false, reason: "Couldn't read that file." };
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
    if (!pdf) return { ok: false, reason: "Couldn't read that PDF." };
    const table = parsePdfTableReceipt(pdf.tables);
    if (table) {
      return { ok: true, receipt: enrichReceiptMeta(table, pdf.text), method: "pdf-table" };
    }
    if (!pdf.text.trim()) {
      return {
        ok: false,
        reason: "That PDF has no extractable text (a scan?). Upload a photo of the receipt instead.",
      };
    }
    try {
      const receipt = shapeReceipt(await chatExtract(orgId, pdf.text, fileId));
      if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt." };
      return { ok: true, receipt, method: "ai-chat" };
    } catch (e) {
      return { ok: false, reason: aiError(e) };
    }
  }

  // ── Tier 3: image → AI vision ──────────────────────────────────────────────
  if (isImage) {
    try {
      const receipt = shapeReceipt(await visionExtract(orgId, bytes.toString("base64"), mime, fileId));
      if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt." };
      return { ok: true, receipt, method: "ai-vision" };
    } catch (e) {
      return { ok: false, reason: aiError(e) };
    }
  }

  // ── Non-CSV text file → AI on the raw text ─────────────────────────────────
  try {
    const receipt = shapeReceipt(await chatExtract(orgId, bytes.toString("utf8"), fileId));
    if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt." };
    return { ok: true, receipt, method: "ai-chat" };
  } catch (e) {
    return { ok: false, reason: aiError(e) };
  }
}
