// Why an action is off on this record now, or null (#7921 class 2).
//
// The bar's list of actions is asked per kind, so every drill offered Return
// home, and a drill bolted to the bench refused it after the tap. The record's
// own answer (GET /actions/off, registerRecordCheck on the server) is asked
// here, and the run refuses with the same sentence. A thing lent out is off
// for moving and labelling the same way (RecordLoan).
import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import { useOffWhileLent } from "./RecordLoan";

export function useActionOff(kind: string, id: string, actionId: string): string | null {
  const { api, orgSlug } = usePlatformWeb();
  const lent = useOffWhileLent(kind, id, actionId);
  const { data } = useQuery({
    queryKey: ["actions-off", orgSlug, kind, id],
    queryFn: () => api.actionsOffOn!(orgSlug, kind, id),
    enabled: !!api.actionsOffOn && !!id,
    staleTime: 0,
  });
  return lent ?? data?.off?.[actionId] ?? null;
}
