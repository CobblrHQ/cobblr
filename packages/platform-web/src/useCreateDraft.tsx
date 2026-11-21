// A create form half filled survives what a phone does to a page (#4115).
//
// A new part's name typed on a phone was gone after a reload, after the
// browser dropped the tab in the background, or after a stray Escape closed
// the form. A create form now keeps what it holds on this device as it is
// typed, under the workspace, the signed-in person and the form, so a draft
// never shows to another account on a shared phone. Opening the form again
// brings it back, says so, and offers to start over; it is forgotten once the
// create lands, and when the person signs out.
//
//   const draft = useCreateDraft({ form: "inventory:new-part", slug, token, values: { name, qty }, restore: (v) => { setName(v.name); setQty(v.qty); }, open });
//   <CreateDraftNote draft={draft} />      // inside the form
//   draft.clear()                           // when the create succeeds
//
// A draft is the form's own values as JSON in localStorage (text, small);
// a picture or a file is never part of one. Only a form the person has typed
// into is kept: values equal to the form's empty state are not a draft.
import { useCallback, useEffect, useRef, useState } from "react";
import { writerOf } from "./waiting-writes";

const PREFIX = "cobblr:create-draft:";

export type DraftValues = Record<string, string | number | boolean | null>;

interface Kept {
  values: DraftValues;
  at: number;
}

/** The store key: workspace, signed-in person, form. */
export function draftKey(form: string, slug: string, token: string | null | undefined): string | null {
  const person = writerOf(token ? `Bearer ${token}` : "");
  if (!slug || !person) return null;
  return `${PREFIX}${slug}:${person}:${form}`;
}

function read(key: string | null): Kept | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const k = raw ? (JSON.parse(raw) as Kept) : null;
    return k && typeof k === "object" && k.values ? k : null;
  } catch {
    return null;
  }
}

function write(key: string | null, values: DraftValues | null): void {
  if (!key) return;
  try {
    if (values) localStorage.setItem(key, JSON.stringify({ values, at: Date.now() } satisfies Kept));
    else localStorage.removeItem(key);
  } catch {
    /* a full or refused store keeps nothing; the form works as before */
  }
}

/** Every draft on this device, for sign-out: another person must never see one. */
export function forgetCreateDrafts(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* nothing to forget */
  }
}

export interface CreateDraft {
  /** The form was filled from a draft kept on this device. */
  restored: boolean;
  /** Forget the draft and empty the form. */
  startOver: () => void;
  /** The create landed: forget the draft. */
  clear: () => void;
}

export function useCreateDraft<V extends DraftValues>(o: {
  form: string;
  slug: string;
  token: string | null | undefined;
  /** The form's values now. */
  values: V;
  /** The values of an empty form: a form still equal to them is no draft. */
  empty: V;
  /** Puts kept values back into the form. */
  restore: (values: V) => void;
  /** Whether the form is open (a modal); a closed form neither restores nor keeps. */
  open?: boolean;
}): CreateDraft {
  const key = draftKey(o.form, o.slug, o.token);
  const open = o.open !== false;
  const [restored, setRestored] = useState(false);
  const restoreRef = useRef(o.restore);
  restoreRef.current = o.restore;
  // Restore once per opening, before anything typed is kept over it.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      setRestored(false);
      return;
    }
    if (seeded.current) return;
    seeded.current = true;
    const kept = read(key);
    if (kept) {
      restoreRef.current(kept.values as V);
      setRestored(true);
    }
  }, [open, key]);

  const json = JSON.stringify(o.values);
  const emptyJson = JSON.stringify(o.empty);
  useEffect(() => {
    if (!open || !seeded.current) return;
    write(key, json === emptyJson ? null : (JSON.parse(json) as DraftValues));
  }, [open, key, json, emptyJson]);

  const clear = useCallback(() => {
    write(key, null);
    setRestored(false);
  }, [key]);
  const startOver = useCallback(() => {
    write(key, null);
    setRestored(false);
    restoreRef.current(JSON.parse(emptyJson) as V);
  }, [key, emptyJson]);
  return { restored, startOver, clear };
}

/** Said inside a form filled from a draft: where it came from, and a way back to empty. */
export function CreateDraftNote({ draft }: { draft: CreateDraft }) {
  if (!draft.restored) return null;
  return (
    <div data-testid="create-draft" role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle/60 px-3 py-2 text-sm text-muted dark:border-slate-700 dark:text-slate-300">
      <span className="min-w-0 flex-1">What you were typing here was kept on this device.</span>
      <button type="button" className="min-h-[44px] px-2 text-sm underline-offset-2 hover:underline" onClick={draft.startOver}>
        Start over
      </button>
    </div>
  );
}
