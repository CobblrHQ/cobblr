// Edit a text field's dropdown CHOICES.
//
// The choices are SUGGESTIONS, never constraints: the value is stored as free
// text, so changing the list can't orphan anything already saved, and on a
// field that remembers new entries (LearnsToggle) whatever someone types on a
// record lands back in this list. So the goal here is a good STARTING set, not
// an exhaustive one — say that plainly rather than making people feel they have
// to enumerate the world before they can save.
//
// Used by the /fields create form and the field detail modal, so the two can't
// drift into two different ideas of what a choice list is.

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { choiceLearns } from "@cobblr/platform-contract/field-choices";

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
              title={`Remove ${c}`}
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
          aria-label="Add a choice"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && commit(draft)}
          placeholder={value.length ? "" : (placeholder ?? "Type a choice, press Enter")}
          className="flex-1 basis-40 min-w-0 bg-transparent text-sm text-content dark:text-mortar-100 placeholder:text-faint outline-none py-0.5"
        />
      </div>
      <span className="mt-1 block text-[10px] text-faint dark:text-slate-600">
        Enter or comma to add. These are suggestions: on a record anyone can type a
        value that is not on the list. Leave it empty for a plain text box.
      </span>
    </div>
  );
}

/** "Remember new entries": a value a person types on a record becomes a choice
 *  for the next one (undoable from the toast that says so). On by default for a
 *  person's own field with choices; a bundle's or a module's field says so
 *  itself (field-choices.ts holds the rule). Off, the list stays as written. */
export function LearnsToggle({
  def,
  onChange,
  disabled,
}: {
  def: { choices?: string[] | null; learns?: boolean | null; bundle_id?: string | null; source_module?: string | null };
  onChange: (learns: boolean) => void;
  disabled?: boolean;
}) {
  const on = choiceLearns({ type: "text", ...def });
  return (
    <label className="mt-2 flex items-start gap-2 text-xs text-content dark:text-mortar-100">
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-cobble-500" />
      <span>
        Remember new entries
        <span className="block text-[10px] text-faint dark:text-slate-500">
          {(def.choices?.length ?? 0) > 0
            ? "A value someone types on a record is offered as a choice from then on."
            : "Offers what has been typed before as choices, even with none listed here."}
        </span>
      </span>
    </label>
  );
}
