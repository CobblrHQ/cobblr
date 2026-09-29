// What a bridge picker's value means, in one place (#3904).
//
// BridgePicker hands back null for "Default bridge", a real choice: the
// workspace's own, unnamed bridge. Only "Other id…" left empty is no choice
// at all. The Part-DB import read null as "nothing picked", so choosing the
// default bridge could never submit, even with the bridge online.
export function bridgeChosen(value: string | null): boolean {
  return value === null || value.trim() !== "";
}

/** Why "Connect & import" cannot run yet, in words, or null when it can. */
export function liveImportBlocker(s: { url: string; token: string; onLan: boolean; bridge: string | null; addressLabel: string }): string | null {
  if (!s.url.trim()) return `Fill in the ${s.addressLabel}.`;
  if (!s.token.trim()) return "Paste the API token.";
  if (s.onLan && !bridgeChosen(s.bridge)) return "Type the name you gave the new bridge, or pick one of yours.";
  return null;
}

export { bridgeDisplayName } from "@cobblr/platform-contract/edge-channel";
