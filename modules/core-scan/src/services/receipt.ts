// Receipt / invoice parsing — turn an uploaded receipt into line items.
//
// A receipt PDF (or a photo of one) → text → ONE metered core-ai call that
// extracts the vendor, date, and per-line items as JSON. The caller drops one
// scan-inbox row per line item (source_kind "receipt") so each line rides the
// SAME matchmaker + confirm flow a barcode/photo scan does — a receipt becomes
// N parts without retyping. Mirrors companion app's parseInvoice* → ParsedOrderDraft.
//
// Two read paths: a text PDF goes via `pdf-parse` → core-ai `chat`; an image
// goes straight to a vision `classify-image` call (OCR + structuring folded
// into one). A scanned (image-only) PDF has no extractable text — we degrade
// with a clear "upload a photo instead" message rather than guess.

import { platform } from "@cobblr/platform-contract";

export interface ReceiptLine {
  description: string;
  qty: number;
  unit_price: number | null;
  line_total: number | null;
}

export interface ParsedReceipt {
  vendor: string | null;
  /** ISO YYYY-MM-DD when the receipt's date is parseable, else null. */
  date: string | null;
  /** ISO-4217 code, uppercased, when stated. */
  currency: string | null;
  total: number | null;
  items: ReceiptLine[];
}

export type ReceiptResult =
  | { ok: true; receipt: ParsedReceipt }
  | { ok: false; reason: string };

const SCHEMA_INSTRUCTION =
  "Reply with ONLY a JSON object, no prose:\n" +
  '{"vendor":<string|null>,"date":<"YYYY-MM-DD"|null>,"currency":<ISO-4217 code|null>,' +
  '"total":<number|null grand total>,"items":[{"description":<string>,"qty":<number>,' +
  '"unit_price":<number|null>,"line_total":<number|null>}]}\n' +
  "One entry per PURCHASED line item. Skip subtotal / tax / shipping / discount / " +
  "total rows — capture the grand total in \"total\" instead. qty defaults to 1 when " +
  "no count is shown. Prices are numbers only (strip currency symbols and thousands " +
  "separators). Use null for anything not printed on the receipt.";

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Shape a model's (possibly messy) JSON reply into a ParsedReceipt. Pure +
 *  tolerant (extracts the first JSON object, coerces price strings, drops
 *  blank lines) so it's unit-testable without an AI call. Returns null when
 *  the reply has no parseable line items. */
export function shapeReceipt(raw: string): ParsedReceipt | null {
  const m = raw.match(/\{[\s\S]*\}/);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(m ? m[0] : raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
  const items: ReceiptLine[] = [];
  for (const it of itemsRaw) {
    const o = (it ?? {}) as Record<string, unknown>;
    const description = str(o.description);
    if (!description) continue;
    items.push({
      description: description.slice(0, 300),
      qty: num(o.qty) ?? 1,
      unit_price: num(o.unit_price),
      line_total: num(o.line_total),
    });
  }
  if (items.length === 0) return null;
  const currency = str(parsed.currency);
  return {
    vendor: str(parsed.vendor),
    date: isoDate(parsed.date),
    currency: currency ? currency.toUpperCase().slice(0, 3) : null,
    total: num(parsed.total),
    items,
  };
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

/** Parse a receipt file (PDF or image, already stored in core-files) into a
 *  ParsedReceipt. Never throws — every failure is a typed `{ ok:false, reason }`
 *  with a user-facing message. */
export async function parseReceipt(orgId: string, fileId: string): Promise<ReceiptResult> {
  const file = await platform().files.read(orgId, fileId, "original");
  if (!file) return { ok: false, reason: "Couldn't read that file." };
  const bytes = Buffer.from(file.bytes);
  const isPdf =
    file.mimeType === "application/pdf" || bytes.subarray(0, 5).toString("latin1").startsWith("%PDF");

  let raw: string;
  try {
    if (isPdf) {
      let text = "";
      try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(bytes) });
        text = (await parser.getText()).text ?? "";
      } catch {
        return { ok: false, reason: "Couldn't read that PDF." };
      }
      if (!text.trim()) {
        return {
          ok: false,
          reason: "That PDF has no extractable text (a scan?). Upload a photo of the receipt instead.",
        };
      }
      raw = await chatExtract(orgId, text, fileId);
    } else if (file.mimeType.startsWith("image/")) {
      raw = await visionExtract(orgId, bytes.toString("base64"), file.mimeType, fileId);
    } else {
      return { ok: false, reason: "Upload a PDF or a photo of the receipt." };
    }
  } catch (e) {
    const provider = e instanceof Error && /provider|capability|budget/i.test(e.message);
    return {
      ok: false,
      reason: provider
        ? "No AI provider is set up for this workspace yet (Configuration → AI)."
        : "AI is unavailable right now.",
    };
  }

  const receipt = shapeReceipt(raw);
  if (!receipt) return { ok: false, reason: "Couldn't find any line items on that receipt." };
  return { ok: true, receipt };
}
