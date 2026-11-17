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
