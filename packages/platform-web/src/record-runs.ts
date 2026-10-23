// What the record's bar may offer from its own parts: the actions list's
// `runs`, the door's own answer for each kernel action a part runs (#7922).
// A part names its action on RecordActionItem, which draws nothing where it
// would be refused; a host that sends no answer offers as before.
import { createContext, useContext } from "react";

export const RecordRunsContext = createContext<Partial<Record<string, boolean>> | null>(null);

/** Whether `actionId` runs for this viewer on this record's kind. */
export function useRecordRuns(): (actionId: string) => boolean {
  const runs = useContext(RecordRunsContext);
  return (actionId) => runs?.[actionId] !== false;
}
