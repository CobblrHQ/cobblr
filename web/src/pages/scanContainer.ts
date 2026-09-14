// The "this scan IS a container" one-shot: an inbox item (a scanned storage
// tote) becomes a core-locations bin in one action — location created, the
// product identity written onto it (confirm-into-location), and optionally
// armed as the standing file-bin so the very next scans land inside it.
// These two helpers are the pure logic behind that sheet; unit-tested.

/** Does this scan look like a storage container? ONE rule, the platform
 *  contract's (scan-tools.ts), which the served row's `tool_hints.bin`
 *  already applied; kept exported here for the sheet and its tests. */
export { looksLikeContainer } from "@cobblr/platform-contract/scan-tools";

/** The next free "Bin N" name given the workspace's existing location names —
 *  "Bin 18" when Bin 17 is the highest, "Bin 1" when none exist yet. Matching
 *  is case-insensitive but the offered name uses the canonical spelling. */
export function nextBinName(existingNames: readonly string[]): string {
  let max = 0;
  for (const n of existingNames) {
    const m = /^\s*bin\s+(\d{1,5})\s*$/i.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Bin ${max + 1}`;
}
