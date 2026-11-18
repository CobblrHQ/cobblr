// What a document attached in Cobb's chat became, said in the conversation
// (#9517). The chat's attach took one kind of personal document and refused
// everything else ("This attachment is not a registration renewal"), leaving
// a typed "File that receipt." unsent beside the refused file.
import { countOf } from "@cobblr/platform-contract/plural";

export type ReceiptReadResult = {
  duplicate?: boolean;
  existing?: { item_count: number; vendor: string | null };
  items?: unknown[];
  receipt?: { vendor?: string | null } | null;
  queued?: { job_id: string };
  message?: string;
};

export function personalKeptOff(fileName: string): string {
  return `✗ ${fileName} looks like a personal document, so it was not put in the workspace's files. Only a registration renewal is read here.`;
}

export function receiptReadSaid(fileName: string, r: ReceiptReadResult): string {
  if (r.duplicate && r.existing) {
    return `✓ That receipt was read before: ${countOf(r.existing.item_count, "line")} in the scan inbox${r.existing.vendor ? ` from ${r.existing.vendor}` : ""}.`;
  }
  if (r.queued) return `✓ ${fileName} is in the scan inbox, waiting to be read.${r.message ? ` ${r.message}` : ""}`;
  const vendor = r.receipt?.vendor ? ` from ${r.receipt.vendor}` : "";
  return `✓ Read ${fileName} into the scan inbox: ${countOf(r.items?.length ?? 0, "line")}${vendor}.`;
}

/** What the chat does with an attached document. A registration renewal
 *  opens its card. Anything else goes through the shared upload door, which
 *  is the one that judges whether a file is personal: the personal-document
 *  read is a vault read and calls every file personal, so taking its privacy
 *  as the verdict refused every receipt (re-walk of #9517). A file the door
 *  refuses as personal is said so; one it takes is read as a receipt. */
export async function fileAttachment(
  fileName: string,
  read: { kind: string; renewalType?: string },
  door: { upload: () => Promise<{ id: string }>; scan: (fileId: string) => Promise<ReceiptReadResult> },
): Promise<{ card: true } | { said: string }> {
  if (read.kind === "registration" || read.renewalType) return { card: true };
  let stored: { id: string };
  try {
    stored = await door.upload();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "personal_document") return { said: personalKeptOff(fileName) };
    throw error;
  }
  return { said: receiptReadSaid(fileName, await door.scan(stored.id)) };
}
