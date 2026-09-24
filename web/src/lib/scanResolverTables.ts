// The workspace's scan menu as the row-state resolver reads it. The builder
// lives in the contract (scan-triage.ts, scanResolverTables) so the server's
// readers of an item's destination hand the resolver the same tables the
// card does (#3618); this is the web's door to it.
import { scanResolverTables as fromContract, type ScanMenuTableEntry, type ScanResolverTable } from "@cobblr/platform-contract/scan-triage";
import type { ScanMenuEntry } from "./api";

export function scanResolverTables(menu: readonly ScanMenuEntry[] | null | undefined): ScanResolverTable[] {
  return fromContract(menu as readonly ScanMenuTableEntry[] | null | undefined);
}
