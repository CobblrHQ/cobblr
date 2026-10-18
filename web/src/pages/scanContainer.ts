// The "this scan IS a container" one-shot: an inbox item (a scanned storage
// tote) becomes a core-locations bin in one action — location created, the
// product identity written onto it (confirm-into-location), and optionally
// armed as the standing file-bin so the very next scans land inside it.
// These two helpers are the pure logic behind that sheet; unit-tested.

/** Does this scan look like a storage container? ONE rule, the platform
 *  contract's (scan-tools.ts), which the served row's `tool_hints.bin`
 *  already applied; kept exported here for the sheet and its tests. */
export { looksLikeContainer } from "@cobblr/platform-contract/scan-tools";

/** The next free "Bin N" name: the contract's, shared with the server's
 *  one-tap new bin (#6891). */
export { nextBinName } from "@cobblr/platform-contract/scan-tools";
