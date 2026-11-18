// What a confirmed add says to the person (walk #9477).
//
// The intake's `next` is written for the model: "In the inbox for your
// person, ready to file", "Ask your person, then update the record", "file
// it with add_thing's file option". The card's done line showed it as it
// was, so the person read about "your person". This says the same outcome
// from the intake's own facts, in the person's words.

export interface AddFound {
  name?: string | null;
  goes_to?: { label?: string | null } | null;
  already_have?: { title?: string | null } | null;
  still_identifying?: boolean;
  hints?: ReadonlyArray<{ label?: string | null }>;
  fields_refused?: ReadonlyArray<{ name?: string; reason?: string }>;
  goes_to_refused?: string | null;
  filed?: { entity_id: string | null } | null;
  not_filed_because?: string | null;
}

const listOf = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The done line for an add, never the hint meant for the model. */
export function addedSaid(found: AddFound, label: string, askedToFile: boolean): string {
  const to = found.goes_to?.label?.trim();
  const empty = (found.hints ?? []).map((h) => h.label?.trim()).filter((x): x is string => !!x);
  const notKept = (found.fields_refused ?? []).map((r) => r.reason?.trim()).filter((x): x is string => !!x);
  if (found.goes_to_refused) notKept.push(found.goes_to_refused.replace(/^no list called/, "there is no list called"));
  const lead = found.filed?.entity_id
    ? `Added ${label}${to ? ` to ${to}` : ""}.`
    : found.already_have?.title
      ? `${label} looks like “${found.already_have.title.trim()}”, which you already have. It is in the scan inbox: add it to that one, or file it as a second.`
      : askedToFile && found.not_filed_because
        ? `${label} is in the scan inbox; it could not be filed: ${found.not_filed_because.replace(/[.\s]+$/, "")}.`
        : found.still_identifying
          ? `Added ${label} to the scan inbox; its photo is still being identified.`
          : `Added ${label} to the scan inbox, ready to file${to ? ` into ${to}` : ""}.`;
  const still = empty.length ? ` Still empty: ${listOf(empty)}.` : "";
  const kept = notKept.length ? ` Not kept: ${notKept.join("; ")}.` : "";
  return `${lead}${still}${kept}`;
}
