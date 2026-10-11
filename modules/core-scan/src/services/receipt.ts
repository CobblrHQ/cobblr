import { readRenewalPeriod } from "./renewal-draft.js";
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
//   scanned PDF  → no text → the photo of the page it carries, read as an
//                  image (OCR, then vision): a scanner's PDF is a photo of the
//                  paper in a PDF wrapper (#4523)
//
// The text tier only wins when the line items ADD UP to the receipt's own
// subtotal, so it can never beat AI with a confident wrong answer — see
// receipt-text.ts.
//
// The caller drops one scan-inbox row per line item (source_kind "receipt") so
// each line rides the SAME matchmaker + confirm flow a barcode/photo scan does
// — a receipt becomes N parts without retyping. Mirrors the invoice-parse path.

import { platform } from "@cobblr/platform-contract";
import { readPersonalDocumentLocally } from "./personal-document.js";
import { classifyAiFailure } from "@cobblr/platform-contract/ai-refusal";
import { providerReasonOf } from "@cobblr/platform-contract/provider-reason";
import { receiptReadWords } from "@cobblr/platform-contract/scan-session";
import { HOSTED_RECEIPT_QUEUED_WORDS, hostedIdentifyJob, hostedIdentifyWhy, receiptAsModelReply } from "./hosted-identify.js";

/** The hosted identify queued the picture and the workspace's own AI could
 *  not read it either: the read finishes when the job does
 *  (hosted-identify-job.ts), never the old way. */
export class HostedReadQueued extends Error {
  constructor(readonly jobId: string) {
    super(`the hosted identify queued this receipt as ${jobId}`);
    this.name = "HostedReadQueued";
  }
}

/** What the receipt read is told about the hosted service's queue: a job
 *  that has finished (collect its answer instead of asking again), and
 *  whether the caller will wait for one (`queueIfBusy`). */
export interface HostedReadOpts {
  hostedJobId?: string;
  queueIfBusy?: boolean;
}
import {
  buildReceipt,
  type ParsedReceipt,
  type ParseMethod,
  type ReceiptResult,
  type ReceiptSource,
  enrichReceiptFromText,
} from "./receipt-shared.js";
import {
  enrichReceiptMeta,
  parseCsvReceipt,
  parsePdfTableReceipt,
} from "./receipt-deterministic.js";
import { detectOrderRef, parseTextReceipt } from "./receipt-text.js";
import { parseOrderEmail } from "./receipt-order-email.js";
import { asBillOfSale, looksLikeBillOfSale, looksLikeTransaction, markCharges, readBillOfSale } from "./bill-of-sale.js";
import { ocrImageText } from "./ocr.js";
import { looksLikeFullPage, ocrFormText } from "./form-ocr.js";
import { checkedByCode, readCheckedDocument, withTextChecks } from "./document-read.js";
import sharp from "sharp";
import { documentImages } from "@cobblr/platform-contract/document-images";
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

async function chatExtract(orgId: string, text: string, sourceId: string, userId?: string | null): Promise<string> {
  const r = await platform().ai.invoke({
    orgId,
    userId: userId ?? undefined,
    capability: "read-document-text",
    input: {
      messages: [
        {
          role: "system",
          content: "You read a purchase receipt or invoice and extract its line items. " + SCHEMA_INSTRUCTION,
        },
        { role: "user", content: text.slice(0, 12_000) },
      ],
      output_schema: RECEIPT_OUTPUT_SCHEMA,
    },
    source: { kind: "core-scan:receipt", id: sourceId },
  });
  return r.text;
}

const numOrNull = { type: ["number", "null"] };
const textOrNull = { type: ["string", "null"] };
/** The shape `shapeReceipt` reads, sent with every receipt read so a model
 *  answering in a layout of its own is caught, never quietly dropped (#5790):
 *  an object with `items`, each with its description and its money. */
export const RECEIPT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    vendor: textOrNull,
    order_ref: textOrNull,
    date: textOrNull,
    currency: textOrNull,
    total: numOrNull,
    items: {
      type: "array",
      items: {
        type: "object",
        // The money keys too: held to a schema, a model leaves out what it
        // may (Gemma 4 gave unit_price alone), and a line with no line_total
        // counts as nothing on the purchase. Each may still be null.
        required: ["description", "qty", "unit_price", "line_total"],
        properties: {
          description: { type: "string" },
          qty: numOrNull,
          unit_price: numOrNull,
          line_total: numOrNull,
          discount: numOrNull,
          code: textOrNull,
          model: textOrNull,
          weight: numOrNull,
          weight_unit: textOrNull,
        },
      },
    },
  },
} as const;

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
  hostedRead: HostedReadOpts = {},
): Promise<string> {
  // A queued read that finished: its answer, collected, not asked again.
  if (hostedRead.hostedJobId) {
    const job = await hostedIdentifyJob(hostedRead.hostedJobId);
    if (job.state === "done" && job.answer.kind === "receipt" && job.answer.receipt) return receiptAsModelReply(job.answer.receipt);
  }
  // Hosted first (see hosted-identify.ts). The endpoint returns core's own
  // receipt schema, so a stringify is the whole shim and the parser downstream
  // never learns which engine answered. We send OUR receipt prompt - its
  // recorded fixtures pin the exact text, and the endpoint honors the override.
  let queued: string | null = null;
  {
    const why = await hostedIdentifyWhy({ orgId, imageB64, receiptPrompt: RECEIPT_VISION_PROMPT, visitorIp, userId });
    const hosted = why.answer;
    if (hosted?.kind === "receipt" && hosted.receipt) return receiptAsModelReply(hosted.receipt);
    // Every engine the service has is busy or out: it reads this later.
    if (why.queued) queued = why.queued.jobId;
    // Any other outcome - an item mistaken for a receipt upstream, a hosted
    // outage - falls through to the tenant path this call always had.
  }
  try {
    return await tenantVisionExtract(orgId, imageB64, mediaType, sourceId, userId);
  } catch (e) {
    // The workspace's own AI could not read it either, and the hosted
    // service has it queued: wait for that, for a caller that will.
    if (queued && hostedRead.queueIfBusy) throw new HostedReadQueued(queued);
    throw e;
  }
}

async function tenantVisionExtract(orgId: string, imageB64: string, mediaType: string, sourceId: string, userId?: string | null): Promise<string> {
  const r = await platform().ai.invoke({
    orgId,
    userId: userId ?? undefined,
    capability: "classify-image",
    input: {
      image_b64: imageB64,
      image_media_type: mediaType,
      prompt: RECEIPT_VISION_PROMPT,
      output_schema: RECEIPT_OUTPUT_SCHEMA,
    },
    source: { kind: "core-scan:receipt", id: sourceId },
  });
  return r.text;
}

/** The AI failed: the router's coded reason rides the result (the session's
 *  verdict reads the code), and the sentence is for the toast. */
function aiFailed(e: unknown, userId: string | null | undefined): Extract<ReceiptResult, { ok: false }> {
  const ai = classifyAiFailure(e, { hadUser: !!userId });
  const ai_reason = providerReasonOf(e) ?? undefined;
  const words = receiptReadWords({ code: "ai_unavailable", ai, ai_reason, reason: "" });
  return { ok: false, reason: words.sentence, code: "ai_unavailable", ai, ...(ai_reason ? { ai_reason } : {}) };
}

/** A PDF's own words, without the "-- 1 of 1 --" line pdf-parse writes
 *  between pages. Left in, a scanned PDF with no text read as having some:
 *  the page marker went to the model as the receipt and came back as "no
 *  line items" instead of the page's photo being read (#4523). */
export function pdfPageText(raw: string): string {
  return raw.replace(/^\s*-- \d+ of \d+ --\s*$/gm, "");
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
    const text = pdfPageText((await parser.getText()).text ?? "");
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
  // A document read by its own labels (a bill of sale) already took what it
  // prints; a till's header rules would read the form's title as the shop.
  if (receipt.document) return receipt;
  const withRef = { ...receipt, renewal: { ...readRenewalPeriod(text), ...receipt.renewal }, order_ref: receipt.order_ref ?? detectOrderRef(text) };
  return enrichReceiptFromText(enrichReceiptMeta(withRef, text), text);
}

/** The photo of the page a scanned PDF carries: its largest embedded image
 *  on the first pages, or null when it carries none (or no reader is
 *  registered). A scanner writes one image per page; a text PDF with a logo
 *  never reaches here, because it has text. */
async function pageScanOf(bytes: Buffer): Promise<{ png: Buffer } | null> {
  const images = await documentImages(new Uint8Array(bytes), { maxPages: 2, minSide: 300 });
  const first = images?.[0];
  return first ? { png: first.png } : null;
}

export async function parseReceipt(
  orgId: string,
  fileId: string,
  userId?: string | null,
  visitorIp?: string | null,
  /** `requireTransaction`: a document put on a RECORD may be a manual, a
   *  warranty card or a photo of a label, not a sale. The model is asked only
   *  when the text shows one (a price, a total, a bill of sale), so pasting a
   *  manual never spends an AI read, and a picture with no text to judge is
   *  not sent at all. The inbox's own reads keep today's behaviour. */
  /** `noModel`: the caller already holds the lines from somewhere better
   *  than a model (the store's own order page): only the free tiers run, and
   *  a receipt they cannot read fails with no model asked. */
  opts: { requireTransaction?: boolean; noModel?: boolean } & HostedReadOpts = {},
): Promise<ReceiptResult> {
  const file = await platform().files.read(orgId, fileId, "original");
  if (!file) return { ok: false, reason: "Couldn't read that file.", code: "unreadable" };
  const bytes = Buffer.from(file.bytes);
  const mime = file.mimeType || "";
  if ((await readPersonalDocumentLocally({ bytes, mime })).privacy === "personal") {
    return { ok: false, code: "unreadable", reason: "This is a personal document. Read it with Personal documents in the scan inbox." };
  }
  return readReceiptBytes(orgId, bytes, mime, fileId, userId, visitorIp, opts);
}

/** A personal document's sale, read by the receipt reader's code alone
 *  (#5331): the same tiers (a PDF's text and table, form OCR of a scanned
 *  page, OCR and the line parser for a photo), the same checks and date
 *  rules, and no model at all. The page is in hand and never stored; what
 *  code could not read is the personal path's to ask (personal-bill-of-sale.ts). */
export async function readPersonalReceiptByCode(orgId: string, bytes: Buffer, mime: string): Promise<ReceiptResult> {
  return readReceiptBytes(orgId, bytes, mime, null, null, null, { noModel: true });
}

async function readReceiptBytes(
  orgId: string,
  bytes: Buffer,
  mime: string,
  /** The stored original, for a model's call to cite; null when none was kept. */
  fileId: string | null,
  userId: string | null | undefined,
  visitorIp: string | null | undefined,
  opts: { requireTransaction?: boolean; noModel?: boolean } & HostedReadOpts,
): Promise<ReceiptResult> {
  // A model is asked only about a stored original (it cites it); a page in
  // hand and not kept is read by code alone.
  const mayAsk = (text: string | null | undefined): boolean => !opts.noModel && !!fileId && (!opts.requireTransaction || (!!text && looksLikeTransaction(text)));
  const sourceId = fileId ?? "";
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
  const done = async (parsed: ParsedReceipt, method: ParseMethod, text: string | null, source: ReceiptSource): Promise<ReceiptResult> => {
    // Whatever read the lines, a bill of sale is one thing and its charges,
    // and on any receipt a fee or a tax is a line on the purchase, never an
    // inbox item (charge-lines.ts).
    const receipt = printedReceiptMeta(markCharges(asBillOfSale(parsed, text)), text);
    const reading: ReceiptDateReading = readReceiptDate({
      text,
      iso: receipt.date,
      workspace: text ? await workspaceDateConvention(orgId) : null,
    });
    return { ok: true, receipt: { ...receipt, date: reading.date ?? receipt.date }, method, date_reading: reading, source };
  };
  // The toast and the session say the same sentence, about what was given.
  const failed = (r: Extract<ReceiptResult, { ok: false }>, source: ReceiptSource): ReceiptResult =>
    r.code === "ai_unavailable" ? { ...r, source } : { ...r, source, reason: receiptReadWords({ ...r, source }).sentence };

  // A picture of a receipt: the OCR engine and the line parser first, then the
  // model looking at the picture. A photo, and the page of a scanned PDF.
  // A sale document read off a page: checked, made right by its VIN, and
  // read by the document model when a check fails (document-read.ts). Busy
  // models mean the engine's read is filed with its doubts marked and the
  // page waits for one; nothing at all to file is "the AI is busy".
  const readDocument = async (img: Buffer, ocr: { receipt: ParsedReceipt; text: string } | null, method: ParseMethod, source: ReceiptSource): Promise<ReceiptResult | null> => {
    // No model to ask: the code checks still run, and the VIN still makes
    // the vehicle right (the page's misread model line, #4571).
    if (opts.noModel || !fileId) return ocr ? done(await checkedByCode(orgId, ocr), method, ocr.text, source) : null;
    const checked = await readCheckedDocument({ orgId, page: img, sourceId: fileId, userId, ocr });
    if (!checked) return null;
    if ("busy" in checked) {
      if (checked.partial) return done(checked.partial.receipt, method, checked.partial.text, source);
      return failed({ ok: false, reason: "Every AI that reads documents is busy. It will read this when one is free.", code: "ai_unavailable" }, source);
    }
    return done(checked.receipt, checked.method === "ai-document" ? "ai-document" : method, checked.text, source);
  };

  const readPicture = async (img: Buffer, imgMime: string, source: ReceiptSource): Promise<ReceiptResult> => {
    // A full page (a scanned sheet) is a form, not a till receipt: read the
    // way a form is (form-ocr.ts). A dealer's carbon copy read the receipt way
    // came back as "C1yTe WATCU Ey oL 4" (#4571).
    const meta = await sharp(img).metadata().catch(() => null);
    const fullPage = source === "scanned-pdf" || (meta?.width && meta.height ? looksLikeFullPage(meta.width, meta.height) : false);
    if (fullPage) {
      const form = await ocrFormText(img).catch(() => null);
      if (form && looksLikeBillOfSale(form.text)) {
        const sale = readBillOfSale(form.text);
        const read = await readDocument(img, sale ? { receipt: sale, text: form.text } : null, "ocr-form", source);
        if (read) return read;
      }
    }
    // The engine is optional and the parse is gated: it only wins when the
    // lines add up to the receipt's own subtotal, so a mangled read declines
    // to the model rather than shipping a wrong answer that looks right. The
    // fallback is vision, not chat on the OCR text: if the text was not good
    // enough to reconcile, the text is the weak link, and the model should
    // look at the picture itself (no-ai-receipt-reading.md §5.3).
    const read = await ocrImageText(img);
    if (read) {
      // A bill of sale has one thing on it and no lines to add up; it is read
      // by its own labels before the till parser looks for line items.
      const sale = readBillOfSale(read.text);
      if (sale) {
        const checked = await readDocument(img, { receipt: sale, text: read.text }, "ocr-lines", source);
        if (checked) return checked;
      }
      const byLine = parseTextReceipt(read.text);
      if (byLine) return done(byLine.receipt, "ocr-lines", read.text, source);
    }
    if (!mayAsk(read?.text)) return failed({ ok: false, reason: "It does not read as a sale.", code: "no_line_items" }, source);
    try {
      const receipt = shapeReceipt(await visionExtract(orgId, img.toString("base64"), imgMime, sourceId, userId, visitorIp, { hostedJobId: opts.hostedJobId, queueIfBusy: opts.queueIfBusy }));
      if (!receipt) return failed({ ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" }, source);
      // The engine's text, when it read any, is the evidence for the date
      // even though the lines came from the model.
      return done(receipt, "ai-vision", read?.text ?? null, source);
    } catch (e) {
      if (e instanceof HostedReadQueued) return { ok: false, code: "ai_unavailable", reason: HOSTED_RECEIPT_QUEUED_WORDS, hosted_job: e.jobId, source };
      return failed(aiFailed(e, userId), source);
    }
  };

  // ── Tier 1: CSV (deterministic) ────────────────────────────────────────────
  if (looksCsv && !isPdf && !isImage) {
    const csv = parseCsvReceipt(bytes.toString("utf8"));
    if (csv) return done(csv, "csv", bytes.toString("utf8"), "csv");
    // A text file that isn't a recognisable CSV → let AI read it as text below.
  }

  // ── Tier 2: PDF — deterministic table first, AI on the text otherwise ───────
  if (isPdf) {
    const pdf = await readPdf(bytes);
    if (!pdf) return failed({ ok: false, reason: "Couldn't read that PDF.", code: "unreadable" }, "pdf");
    const table = parsePdfTableReceipt(pdf.tables);
    if (table) return done(table, "pdf-table", pdf.text, "pdf");
    if (!pdf.text.trim()) {
      // No text layer: a scanner's PDF, one photo of the paper per page. Read
      // that photo the way a photo of the receipt is read.
      const scan = await pageScanOf(bytes);
      if (scan) return readPicture(scan.png, "image/png", "scanned-pdf");
      return failed(
        {
          ok: false,
          reason: "That PDF has no text and no scanned page in it.",
          // Not recoverable by replaying the same bytes.
          code: "unreadable",
        },
        "scanned-pdf",
      );
    }
    const sale = readBillOfSale(pdf.text);
    if (sale) return done(withTextChecks(sale), "text-lines", pdf.text, "pdf");
    // No ruled table, but a till-style PDF is still line-structured. Free, and
    // it only accepts a parse whose items reconcile.
    const byLine = parseTextReceipt(pdf.text);
    if (byLine) return done(byLine.receipt, "text-lines", pdf.text, "pdf");
    if (!mayAsk(pdf.text)) return failed({ ok: false, reason: "It does not read as a sale.", code: "no_line_items" }, "pdf");
    try {
      const receipt = shapeReceipt(await chatExtract(orgId, pdf.text, sourceId, userId));
      if (!receipt) return failed({ ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" }, "pdf");
      // The model is asked for line items; the totals, the seller, the ETA
      // and the order reference are read from the same text at the door.
      return done(receipt, "ai-chat", pdf.text, "pdf");
    } catch (e) {
      return failed(aiFailed(e, userId), "pdf");
    }
  }

  // ── Tier 3: image → OCR + the line parser, then AI vision ──────────────────
  if (isImage) return readPicture(bytes, mime, "photo");

  // ── Non-CSV text file → line-wise parse first, AI on the raw text ──────────
  const asText = bytes.toString("utf8");
  const sale = readBillOfSale(asText);
  if (sale) return done(withTextChecks(sale), "text-lines", asText, "text");
  // A store's order email, its lines named the store's way and checked
  // against its own subtotal, before the till parser that misreads the layout.
  const ordered = parseOrderEmail(asText);
  if (ordered) return done(ordered, "order-email", asText, "text");
  const byLine = parseTextReceipt(asText);
  if (byLine) return done(byLine.receipt, "text-lines", asText, "text");
  if (!mayAsk(asText)) return failed({ ok: false, reason: "It does not read as a sale.", code: "no_line_items" }, "text");
  try {
    const receipt = shapeReceipt(await chatExtract(orgId, asText, sourceId, userId));
    if (!receipt) return failed({ ok: false, reason: "Couldn't find any line items on that receipt.", code: "no_line_items" }, "text");
    return done(receipt, "ai-chat", asText, "text");
  } catch (e) {
    return failed(aiFailed(e, userId), "text");
  }
}
