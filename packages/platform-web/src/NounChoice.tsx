// "What do you call these?" for a table whose bundle offers words (#3650):
// Yarn counts in balls, skeins or hanks. One set of buttons for every place
// the question is asked (the install screen, the table's own Settings, and
// Presentation), so the three cannot drift into different wording or a
// different default. The host owns the save: an install sends the word with
// the install, a change re-applies the bundle.
import { SegmentedChoice } from "./SegmentedChoice";
import { chosenNoun, nounOptions, type NounChoiceDecl } from "@cobblr/platform-contract/kind-label";

export function NounChoiceButtons({
  offer,
  current,
  onPick,
  disabled,
  label = "What do you call these?",
}: {
  offer: NounChoiceDecl;
  /** The singular in force; null or a word no longer offered reads as the default. */
  current: string | null | undefined;
  onPick: (singular: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const on = chosenNoun(offer, current ? { singular: current } : null).singular;
  return (
    <SegmentedChoice
      label={label}
      value={on}
      disabled={disabled}
      onChange={onPick}
      options={nounOptions(offer).map((w) => ({ value: w.singular, label: w.plural }))}
    />
  );
}

/** The heading a picker sits under, by what the word names. */
export function nounChoiceHeading(offer: NounChoiceDecl): string {
  return offer.of === "unit" ? "What these are counted in" : "What one of these is called";
}
