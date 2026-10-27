// The edits a page makes to one record, each judged against that record as
// the page shows it (#7925).
//
// A detail page saves a field at a time, from the record it read. Each save
// goes through editOf against that copy, so a newer save from another tab or
// another person is not reversed in silence. Two saves this page makes one
// after the other must not refuse each other, so they run in turn, and each
// is judged against the copy with this page's own earlier saves applied. A
// fresh read of the record replaces the copy.
import { useCallback, useRef } from "react";
import { editOf, type Edit } from "./changed-from";
import { asAPersonsWrite, madeByAPerson } from "./waiting-writes";

const bag = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** `copy` with a sent body applied the way the server applies it: fields
 *  replaced, the `metadata` bag merged key by key. */
export function withSaved(copy: Record<string, unknown> | null, body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(copy ?? {}), ...body };
  if (body.metadata && typeof body.metadata === "object") out.metadata = { ...bag(copy?.metadata), ...bag(body.metadata) };
  return out;
}

/** `edit(next, send)`: builds the save of `next` against the record as this
 *  page knows it and hands it to `send` (the record's update helper). */
export function useRecordEdits(record: object | null | undefined) {
  const read = useRef<object | null | undefined>(undefined);
  const known = useRef<Record<string, unknown> | null>(null);
  const turn = useRef<Promise<unknown>>(Promise.resolve());
  if (record !== read.current) {
    read.current = record;
    known.current = record ? { ...(record as Record<string, unknown>) } : null;
  }
  return useCallback(<T extends object, R>(next: T, send: (edit: Edit<T>) => Promise<R>): Promise<R> => {
    const byAPerson = madeByAPerson();
    const run = turn.current.then(async () => {
      const edit = editOf(known.current, next);
      const answer = await (byAPerson ? asAPersonsWrite(() => send(edit)) : send(edit));
      known.current = withSaved(known.current, edit.body as Record<string, unknown>);
      return answer;
    });
    turn.current = run.catch(() => undefined);
    return run;
  }, []);
}
