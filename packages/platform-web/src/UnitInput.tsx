// UnitInput — a unit field backed by the core-units vocabulary. It's a
// free-text input (so any unit a user types still works) with a datalist
// of the workspace's known units as suggestions. Selecting a suggestion
// stores the canonical SYMBOL ("g"); the suggestion shows the full word so
// the picker reads plainly ("grams (g)"). A resolved value shows its full
// name beneath as confirmation; an unknown value is accepted as-is.
//
// Beside a count (`count`), the field READS the way the count does: 3 of a
// stored "hank" shows "hanks", 1 shows "hank". Focus shows the stored word to
// edit, and typing a declared plural ("hanks") stores its singular, so the
// stored unit stays one word whatever the count was when somebody typed it.

import { useId, useMemo, useState } from "react";
import { countWordsFor, type CountWords } from "@cobblr/platform-contract/plural";
import { useUnits } from "./useUnits";

interface Props {
  value: string | null | undefined;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** The quantity this unit sits beside, so the word agrees with it. */
  count?: number;
  /** The table's declared words for its units (a bundle's noun offer). */
  known?: readonly CountWords[];
}

export function UnitInput({ value, onCommit, placeholder = "unit", className, count, known }: Props) {
  const units = useUnits();
  const listId = useId();
  const [draft, setDraft] = useState(value ?? "");
  const [focused, setFocused] = useState(false);

  // Keep the draft in sync if the saved value changes underneath us.
  const initial = value ?? "";
  useMemo(() => setDraft(initial), [initial]);

  const resolved = units.resolve(draft);
  const commit = () => {
    setFocused(false);
    const typed = draft.trim();
    const v = typed ? countWordsFor(typed, known).singular : typed;
    if (v !== (value ?? "")) onCommit(v);
  };
  // A measured unit reads as its symbol whatever the count; only a counted
  // word (free text, or the vocabulary's count category) changes with it.
  const agrees =
    !focused && count != null && Number.isFinite(count) && !!value && (!resolved || resolved.category === "count");
  const shown = agrees && draft === (value ?? "") ? units.wordFor(count!, value, known) : draft;

  // Sort by category then name so the dropdown reads in sensible groups.
  const options = [...units.all].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );

  return (
    <div className={className}>
      <input
        list={listId}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder={placeholder}
        className="input w-full"
        autoComplete="off"
      />
      <datalist id={listId}>
        {options.map((u) => (
          // value = symbol (what gets stored); label = full word so the
          // suggestion list reads plainly.
          <option key={u.code} value={u.symbol} label={`${u.plural} (${u.symbol})`} />
        ))}
      </datalist>
      {resolved && resolved.symbol.toLowerCase() !== resolved.plural.toLowerCase() && (
        <span className="mt-0.5 block text-[10px] text-faint dark:text-slate-500">
          {resolved.plural}
        </span>
      )}
    </div>
  );
}
