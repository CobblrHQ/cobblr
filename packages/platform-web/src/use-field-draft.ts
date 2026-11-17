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
  /** Ask before writing the draft. False once when the record's value
   *  changed while the person was typing (another tab, another person, an
   *  action): nothing is written, `movedTo` says what it holds now, and the
   *  next ask writes, the person having seen it (#9534). */
  mayWrite: () => boolean;
  /** What the record changed to under the draft, said beside the field until
   *  the person writes again, puts it back (Escape), or types it themselves. */
  movedTo: string | null;
}

/** What a field says when the record changed while the person typed: the
 *  same words a save refused by the server answers with (#7925). */
export function movedUnderSentence(movedTo: string): string {
  return `Changed to "${movedTo}" after you opened this, so nothing was saved. Save again to replace it, or press Escape to keep it.`;
}

export function useFieldDraft(recordValue: string): FieldDraft {
  const [draft, setDraftState] = useState(recordValue);
  const typed = useRef(recordValue);
  // What the field last took from the record (or last wrote to it). A draft
  // still equal to it is untouched, so the record's new value replaces it.
  const base = useRef(recordValue);
  // The record's value that arrived while the person was typing over an
  // older one. Their write would be judged against the record as it is now
  // and replace it without their having seen it, so the next ask is refused.
  const moved = useRef<string | null>(null);
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const setDraft = useCallback((v: string) => {
    typed.current = v;
    setDraftState(v);
    if (v === base.current) {
      moved.current = null;
      setMovedTo(null);
    }
  }, []);
  useEffect(() => {
    const before = base.current;
    base.current = recordValue;
    if (recordValue === before) return;
    if (typed.current === before) {
      typed.current = recordValue;
      setDraftState(recordValue);
    } else if (typed.current !== recordValue) {
      moved.current = recordValue;
    } else {
      moved.current = null;
      setMovedTo(null);
    }
  }, [recordValue]);
  const reset = useCallback(() => {
    moved.current = null;
    setMovedTo(null);
    typed.current = base.current;
    setDraftState(base.current);
  }, []);
  const committed = useCallback((v: string) => {
    base.current = v;
    moved.current = null;
    setMovedTo(null);
  }, []);
  const mayWrite = useCallback(() => {
    if (moved.current !== null) {
      setMovedTo(moved.current);
      moved.current = null;
      return false;
    }
    return true;
  }, []);
  return { draft, setDraft, dirty: draft !== recordValue, reset, committed, mayWrite, movedTo };
}
