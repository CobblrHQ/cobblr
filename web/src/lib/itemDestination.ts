// Where an item goes, or went, in words: the one answer for every surface
// that names it.
//
// A filed row names the table its commit recorded (filed_into, #3620). A
// pending row names the table the card resolves (the contract's resolver,
// over the same viewer the card reads, #3618). Neither reads the raw top
// candidate, which is how the live strip, the scanner queue and Recently
// committed each came to disagree with the card.
import { useQuery } from "@tanstack/react-query";
import { filedIntoOf, scanRowState, type ScanRowStateContext, type ScanTriageRow } from "@cobblr/platform-contract/scan-triage";
import { api } from "./api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useScanViewer } from "../pages/scanViewer";

export function itemDestinationLabel(row: ScanTriageRow & { suggested_metadata?: unknown }, viewer: ScanRowStateContext): string | null {
  if (row.status === "resolved") return filedIntoOf(row.suggested_metadata)?.label ?? null;
  return scanRowState(row, viewer).destination?.label?.trim() || null;
}

/** The same answer for a component: the viewer the card reads (its menu, the
 *  person's role and capabilities) is fetched through the shared cache. */
export function useItemDestinationLabel(row: (ScanTriageRow & { suggested_metadata?: unknown }) | null | undefined): string | null {
  const { activeSlug } = useActiveOrg();
  const menuQ = useQuery({ queryKey: ["scan-menu", activeSlug], queryFn: () => api.scanMenu(activeSlug), enabled: !!activeSlug, staleTime: 60_000 });
  const viewer = useScanViewer(menuQ.data?.items ?? null);
  return row ? itemDestinationLabel(row, viewer) : null;
}
