import { useQuery } from "@tanstack/react-query";
import { scanDeclinesRecord, scanMatchTier } from "@cobblr/platform-contract/scan-triage";
import { api, type ScanInboxItem } from "./api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

/** The records this scan could already be, as the banner offers them: one
 *  read, shared by the banner and the sheet around it, so the sheet knows a
 *  scan is something you have from the same answer the banner shows. */
export function useTrackedMatchList(item: ScanInboxItem | null) {
  const { activeSlug } = useActiveOrg();
  const matches = useQuery({
    queryKey: ["scan-tracked", activeSlug, item?.id, item?.barcode_text, item?.suggested_name],
    queryFn: () => api.scanTrackedMatches(activeSlug, item!.id),
    enabled: !!item?.id && item.status === "pending" && (!!item.barcode_text || !!item.suggested_name),
    staleTime: 60_000,
  });
  // A record the person said this is not stays said: the card files the
  // scan as a new item, so the banner does not offer to add to it. A record
  // holding the scanned code is the answer; look-alikes by name are offered
  // only when no code matched (scanMatchTier, #6248).
  const all = item
    ? scanMatchTier({ barcode_matches: matches.data?.barcode_matches ?? [], name_matches: matches.data?.name_matches ?? [] }).filter(
        (m) => !scanDeclinesRecord(item, { kind: m.kind, id: m.id, instance: m.instance }),
      )
    : [];
  return { matches, all };
}

