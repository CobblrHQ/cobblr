// A picture that is a receipt is known to be one before the row exists.
//
// The shape check used to run on the detached read, behind the wire and behind a
// workspace's first look, so a receipt spent its first seconds as an item: "Name
// this item", a quantity, a table and a Review button, then "still reading the
// picture", then, only at the end, "Receipt not read". The engine reads a receipt
// in a fraction of a second and its answer is memoised for the read that follows,
// so the door asks first and writes the answer on the row it inserts.
//
// Bounded, because intake stays instant: past the budget the row goes in unmarked
// and the read marks it as it always did.
import { platform } from "@cobblr/platform-contract";
import { ocrImageText } from "./ocr.js";
import { receiptLinesFound, scoreReceiptShape } from "./receipt-shape.js";

export const RECEIPT_FIRST_BUDGET_MS = 2_500;

export interface ReceiptStamp {
  reading_receipt: true;
  receipt_decided_by: "shape";
  receipt_shape: { verdict: "receipt"; score: number; lines?: number };
}

/** What the row carries when its picture's text has the shape of a receipt. */
export function receiptStampOf(text: string): ReceiptStamp | null {
  const shape = scoreReceiptShape(text);
  if (shape.verdict !== "receipt") return null;
  const lines = receiptLinesFound(text);
  return {
    reading_receipt: true,
    receipt_decided_by: "shape",
    receipt_shape: { verdict: "receipt", score: shape.score, ...(lines === null ? {} : { lines }) },
  };
}

/** The picture's stamp, or null: not a receipt, no engine, or not known in time.
 *  Never throws; a door does not refuse a photo over a look at its text. */
export async function receiptFirstLook(orgId: string, fileId: string, budgetMs = RECEIPT_FIRST_BUDGET_MS): Promise<ReceiptStamp | null> {
  const look = (async () => {
    const file = await platform().files.read(orgId, fileId, "original");
    if (!file) return null;
    const read = await ocrImageText(new Uint8Array(file.bytes));
    return read ? receiptStampOf(read.text) : null;
  })().catch((err: unknown) => {
    console.warn(`[core-scan] the first look at a photo's text failed: ${(err as Error).message}`);
    return null;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([look, late]);
  } finally {
    clearTimeout(timer);
  }
}
