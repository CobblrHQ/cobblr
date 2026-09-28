// The access levels a personal API token can carry, and the words a person
// reads for each. One list for the api (which enforces it, in
// api/src/auth/token-access.ts) and the web (which offers it), so the dialog
// can never offer a level the server does not know.

export const TOKEN_ACCESS = ["look", "change", "full"] as const;
export type TokenAccess = (typeof TOKEN_ACCESS)[number];

export function isTokenAccess(v: unknown): v is TokenAccess {
  return typeof v === "string" && (TOKEN_ACCESS as readonly string[]).includes(v);
}

export const TOKEN_ACCESS_LABEL: Record<TokenAccess, string> = {
  look: "Look only",
  change: "Look and make changes",
  full: "Full access",
};

export const TOKEN_ACCESS_MEANS: Record<TokenAccess, string> = {
  look: "Reads records. Changes nothing.",
  change: "Reads, adds, edits and moves records, and runs actions. Never touches settings, members, connections or other tokens.",
  full: "Everything you can do yourself, including settings and minting other tokens.",
};

/** What a new token starts as, wherever one is minted from a screen: the
 *  workspace in front of the person, able to make changes, never full. */
export const DEFAULT_TOKEN_ACCESS: TokenAccess = "change";
