// A bill of sale read on the personal path (#5331). A vehicle's bill of sale
// is a personal document (#5243, decision 40397), so it never reaches shared
// Files or the receipt pipeline that reads them. It is read here, transiently:
// its text by code (the PDF's text layer, or local OCR of the page), the sale
// by code (readBillOfSale: the vehicle, its price, date, seller, the fees and
// tax), and only what code could not read is asked of an AI, through the
// personal path, which asks this machine's readers unless the workspace's
// owner consented to one cloud connection (#5621). Nothing is stored: the
// caller files what was read (one vehicle, its purchase), never the document.

import { platform } from "@cobblr/platform-contract";
import { refusalCodeOf } from "@cobblr/platform-contract/ai-refusal";
import type { DocumentInput } from "@cobblr/platform-contract/personal-documents";
import { personalDocumentText } from "./personal-document.js";
import { looksLikeBillOfSale, readBillOfSale, readVin, readVinAsPrinted } from "./bill-of-sale.js";
import type { ParsedReceipt, ReceiptResult } from "./receipt-shared.js";
import { settleWithTypedVin, withTextChecks } from "./document-read.js";
import { readPersonalReceiptByCode } from "./receipt.js";

export type PersonalBillOfSale =
  | { ok: true; result: Extract<ReceiptResult, { ok: true }>; read_by: "code" | "local-ai" | "cloud-ai"; sent_to: string | null }
  | { ok: false; code: "not_a_bill_of_sale" | "unreadable" | "reader_failed" | "vin_unreadable"; message: string };

/** A read that names a vehicle files only on a proved VIN (#5921): a VIN that
 *  failed its check digit, or none read off a vehicle's form, stops here, and
 *  the VIN the person types (when it passes) makes the vehicle right. A sale
 *  of anything else (no VIN asked) goes as it was read. */
async function onProvedVin(orgId: string, receipt: ParsedReceipt, typed: string | undefined, printedText?: string): Promise<{ ok: true; receipt: ParsedReceipt } | { ok: false; code: "vin_unreadable"; message: string }> {
  // A read's own checks doubt an OCR'd VIN; text (a text layer, an AI's
  // answer) is held to the same rule: a VIN it prints that fails its check
  // digit names no vehicle.
  const printed = printedText ? readVinAsPrinted(printedText) : null;
  const vinDoubted = (receipt.checks?.fields ?? []).includes("vin") || (!!printed && !readVin(printedText!));
  if (typed) {
    const settled = await settleWithTypedVin(orgId, receipt, typed);
    if (!settled) return { ok: false, code: "vin_unreadable", message: "That VIN does not pass its check digit. Check each character and type it again." };
    return { ok: true, receipt: settled };
  }
  if (vinDoubted) return { ok: false, code: "vin_unreadable", message: "Couldn't read the VIN on this bill of sale. Type it, then file it; nothing was filed." };
  return { ok: true, receipt };
}

/** The labels the AI is asked to copy, as the form prints them, so code
 *  reads its answer the way it reads a typed form. */
const ASK = "Copy this bill of sale's printed values as labelled lines, one per line, only what is printed: BILL OF SALE (first line), Date:, Seller:, Buyer:, Year:, Make:, Model:, VIN:, Mileage:, Price of Unit:, then each fee or tax as its own line with its amount, then Total:. Do not guess.";

export async function readPersonalBillOfSale(input: DocumentInput & { orgId: string; userId: string | null; vin?: string }): Promise<PersonalBillOfSale> {
  // The receipt reader's own code tiers, no model: a PDF's text and table,
  // form OCR of a scanned page, OCR and the line parser for a photo, each
  // with its checks (a seller read as a sentence is doubted) and date rule.
  const byCode = await readPersonalReceiptByCode(input.orgId, Buffer.from(input.bytes), input.mime);
  // The page reader stopped partway: said, and nothing else is asked to make
  // something of a page it did not finish (#5921).
  if (!byCode.ok && byCode.code === "reader_failed") return { ok: false, code: "reader_failed", message: "The page reader could not finish reading this page. Nothing was filed; read it again." };
  if (byCode.ok && byCode.receipt.document === "bill-of-sale") {
    const proved = await onProvedVin(input.orgId, byCode.receipt, input.vin);
    if (!proved.ok) return proved;
    return { ok: true, result: { ...byCode, receipt: proved.receipt }, read_by: "code", sent_to: null };
  }
  if (byCode.ok) return { ok: false, code: "not_a_bill_of_sale", message: "This reads as a receipt, not a bill of sale. Add it in the scan inbox." };
  let firstPage: Uint8Array | undefined;
  const text = await personalDocumentText({ ...input, vault: true }, () => {}, (bytes) => { if (!firstPage) firstPage = bytes; });
  const byText = readBillOfSale(text);
  if (byText) {
    const proved = await onProvedVin(input.orgId, withTextChecks(byText), input.vin, text);
    if (!proved.ok) return proved;
    return { ok: true, result: { ok: true, receipt: proved.receipt, method: "text-lines", source: input.mime === "application/pdf" ? "pdf" : input.mime.startsWith("image/") ? "photo" : "text" }, read_by: "code", sent_to: null };
  }
  // Code read the page but it is no bill of sale: never ask a model to make
  // one out of it.
  if (text.trim().length > 40 && !looksLikeBillOfSale(text)) return { ok: false, code: "not_a_bill_of_sale", message: "This does not read as a bill of sale." };
  try {
    const image = firstPage ? { image_b64: Buffer.from(firstPage).toString("base64"), image_media_type: "image/png" } : input.mime.startsWith("image/") ? { image_b64: Buffer.from(input.bytes).toString("base64"), image_media_type: input.mime } : {};
    // FREE-TEXT: labelled lines (Price of Unit:, VIN:), read by readBillOfSale
    const answer = await platform().ai.invoke({ orgId: input.orgId, userId: input.userId, privacy: "personal", capability: "personal-document-read", input: { prompt: `${ASK}\n${text}`, ...image } });
    const byAiRead = readBillOfSale(answer.text.startsWith("BILL OF SALE") ? answer.text : `BILL OF SALE\n${answer.text}`);
    if (!byAiRead) return { ok: false, code: "unreadable", message: "The bill of sale could not be read. Check the page is clear and try again." };
    const proved = await onProvedVin(input.orgId, withTextChecks(byAiRead), input.vin, answer.text);
    if (!proved.ok) return proved;
    const byAi = proved.receipt;
    const def = answer.provider_id ? platform().ai.getProvider?.(answer.provider_id) : null;
    const cloud = !!def && def.locality !== "local";
    return { ok: true, result: { ok: true, receipt: byAi, method: "text-lines", source: "photo" }, read_by: cloud ? "cloud-ai" : "local-ai", sent_to: cloud ? (def!.company ?? def!.label) : null };
  } catch (error) {
    // Only the AI saying no is a reading failure; anything else is a fault.
    if (!refusalCodeOf(error)) throw error;
    return { ok: false, code: "unreadable", message: "Code could not read this bill of sale, and no local AI could help. Connect one in Configuration, AI." };
  }
}
