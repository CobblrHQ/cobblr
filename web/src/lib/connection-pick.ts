// What the provider picker holds before anyone picks: the person's CHOICE so
// far, which may be nothing. It never reads the provider catalogue (it is not
// given it): the catalogue arrives after the first render, and a value captured
// from it then is "" forever (ConnectionsPage.tsx says how that looked).
//
// Editing a stored service names it by its manifest id, which is no entry of
// the picker, so it opens as the service kind it is; an adapter is its own
// entry (adapter:<id>). A link that asked for a kind (?add=service) is a choice.
export function initialPick(existing: { kind: string; provider_id: string } | null | undefined, asked: string | null): string | null {
  if (existing?.kind === "service" && !existing.provider_id.startsWith("adapter:")) return "service";
  return existing?.provider_id ?? asked;
}
