// What the person who had a scan open hears when someone else files it
// (#8849). Two people on one inbox: Ben had the seam ripper open and was
// changing its count when Ana pressed Add on her phone. The screen moved on
// to the next item and nothing said why, so the count he was typing was
// lost unseen.
import { scanFiledBy } from "@cobblr/platform-contract/scan-recovery";
import type { ScanInboxItem } from "../lib/api";

export function filedWhileOpenWords(item: Pick<ScanInboxItem, "status" | "suggested_name" | "suggested_metadata">, me: string | null | undefined): string | null {
  if (item.status !== "resolved") return null;
  const by = scanFiledBy((item.suggested_metadata ?? null) as Record<string, unknown> | null);
  if (!by || (me && by.by === me)) return null;
  const what = item.suggested_name?.trim() || "this";
  return `${by.by_name} filed ${what} while you had it open. Anything you had not saved on it was not kept.`;
}
