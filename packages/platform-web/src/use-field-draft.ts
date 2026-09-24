// The draft a field editor holds over one of a record's values.
//
// It follows the record while the person is not changing the field, and keeps
// what they typed while they are. Editors used to take the record's value once
// (`useState(initial)`, or an input's `defaultValue`) and never look again, so
// an action that moved the record (Restock one: quantity 2, bought today) left
// the open detail saying 1 and the old date until it was closed and reopened,
// however fresh the query behind it was; and the next blur on such a field
// compared the stale text with the new value and wrote the old one back over
// what the action did (#3615). lint:record-fields-follow-the-record keeps a
// new editor on this hook.
import { useCallback, useEffect, useRef, useState } from "react";

export interface FieldDraft {
  draft: string;
  setDraft: (v: string) => void;
  /** The person has typed something the record does not hold. */
  dirty: boolean;
  /** Put the record's value back (Escape). */
  reset: () => void;
  /** Say the draft was just written: the record's answer, however it spells
   *  the value back ("1.50" for "1.5"), replaces it. */
  committed: (v: string) => void;
}

export function useFieldDraft(recordValue: string): FieldDraft {
  const [draft, setDraft] = useState(recordValue);
  // What the field last took from the record (or last wrote to it). A draft
  // still equal to it is untouched, so the record's new value replaces it.
  const base = useRef(recordValue);
  useEffect(() => {
    const before = base.current;
    base.current = recordValue;
    setDraft((d) => (d === before ? recordValue : d));
  }, [recordValue]);
  const reset = useCallback(() => setDraft(base.current), []);
  const committed = useCallback((v: string) => {
    base.current = v;
  }, []);
  return { draft, setDraft, dirty: draft !== recordValue, reset, committed };
}
