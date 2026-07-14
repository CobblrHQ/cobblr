// Edit a text field's dropdown CHOICES.
//
// The choices are SUGGESTIONS, never constraints: the value is stored as free
// text, so changing the list can't orphan anything already saved, and the record
// form's dropdown carries a "+ add new…" option that appends whatever someone
// types back into this list. So the goal here is a good STARTING set, not an
// exhaustive one — say that plainly rather than making people feel they have to
// enumerate the world before they can save.
//
// Used by the /fields create form and the field detail modal, so the two can't
// drift into two different ideas of what a choice list is.

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

export function ChoicesInput({ value, onChange, placeholder }: Props) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    // Paste a comma-separated list and get one chip each — people paste far more
    // often than they type them out one at a time.
    const added = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !value.includes(s))
      .slice(0, 40);
    if (added.length) onChange([...value, ...added]);
    setDraft("");
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (draft.trim()) commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5 focus-within:border-cobble-500 transition">
        {value.map((c) => (
          <span
            key={c}
            className="inline-flex items-center gap-1 rounded-full bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 pl-2 pr-1 py-0.5 text-xs text-content dark:text-mortar-100"
          >
            {c}
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x !== c))}
              className="rounded-full p-0.5 text-faint hover:text-ember-500 transition"
              aria-label={`Remove ${c}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && commit(draft)}
          placeholder={value.length ? "" : (placeholder ?? "Type a choice, press Enter")}
          className="flex-1 min-w-[10rem] bg-transparent text-sm text-content dark:text-mortar-100 placeholder:text-faint outline-none py-0.5"
        />
      </div>
      <span className="mt-1 block text-[10px] text-faint dark:text-slate-600">
        Enter or comma to add. These are suggestions: the record's dropdown has a
        <span className="font-mono"> + add new</span> option, so anyone can add one
        on the fly and it lands back in this list. Leave it empty for a plain text box.
      </span>
    </div>
  );
}
