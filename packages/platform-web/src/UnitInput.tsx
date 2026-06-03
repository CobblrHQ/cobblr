// UnitInput — a unit field backed by the core-units vocabulary. It's a
// free-text input (so any unit a user types still works) with a datalist
// of the workspace's known units as suggestions. Selecting a suggestion
// stores the canonical SYMBOL ("g"); the suggestion shows the full word so
// the picker reads plainly ("grams (g)"). A resolved value shows its full
// name beneath as confirmation; an unknown value is accepted as-is.

import { useId, useMemo, useState } from "react";
import { useUnits } from "./useUnits";

interface Props {
  value: string | null | undefined;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function UnitInput({ value, onCommit, placeholder = "unit", className }: Props) {
  const units = useUnits();
  const listId = useId();
  const [draft, setDraft] = useState(value ?? "");

  // Keep the draft in sync if the saved value changes underneath us.
  const initial = value ?? "";
  useMemo(() => setDraft(initial), [initial]);

  const resolved = units.resolve(draft);
  const commit = () => {
    const v = draft.trim();
    if (v !== (value ?? "")) onCommit(v);
  };

  // Sort by category then name so the dropdown reads in sensible groups.
  const options = [...units.all].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );

  return (
    <div className={className}>
      <input
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
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
