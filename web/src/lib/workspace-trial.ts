// What kind of workspace this is (sandbox, trial, kept, set to be deleted):
// one read, under one key, for everything in the shell that asks. The state
// strip, the deletion notice and the update badge each asked under a key of
// their own, so a cold load sent GET /trial three times (#6613).
import { api } from "./api";

export const workspaceStateKey = (slug: string) => ["workspace-state", slug] as const;

/** The one query for a workspace's state: pass it to useQuery or fetchQuery. */
export function workspaceTrialQuery(slug: string) {
  return { queryKey: workspaceStateKey(slug), queryFn: () => api.workspaceTrial(slug), staleTime: 60_000 };
}
