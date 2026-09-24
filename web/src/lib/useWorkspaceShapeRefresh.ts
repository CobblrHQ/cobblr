// When a workspace's shape moves (a module enabled, a collection or bundle
// added or removed, by this tab or any other door), everything this app
// cached about that workspace may be wrong: the menu, the filing
// destinations, the counts beside them. Mark all of it stale, so what is on
// screen refetches now and the rest on its next use. A shape change is rare
// (an install, an enable), so refetching the workspace is cheap next to a
// list of query keys that drifts from the screens reading them (#3582).
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeAiAvailability, subscribeWorkspaceShape, subscribeWorkspaceWrite } from "./api";
import { aiAvailabilityKeys } from "./ai-availability-keys";
import { navCountKeys } from "../components/useNavBadges";

export function useWorkspaceShapeRefresh(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribeWorkspaceShape((slug) => {
        void qc.invalidateQueries({ predicate: (q) => q.queryKey.includes(slug) });
      }),
    [qc],
  );
  // Any write can move a number in the nav (the last item filed, a task
  // closed), and the nav cannot know which, so every write asks again: a
  // handful of cheap counts, only the ones on screen refetch.
  useEffect(
    () =>
      subscribeWorkspaceWrite((slug) => {
        void qc.invalidateQueries({ queryKey: navCountKeys.all(slug) });
      }),
    [qc],
  );
  // A connection, share, provider or AI switch changed: whether AI works
  // here may have too, for Cobb, the scan's identify and the settings page
  // alike (#3654). A rare write, so the whole family asks again.
  useEffect(() => subscribeAiAvailability(() => void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.all() })), [qc]);
}

/** Mounted once, beside the other app-wide listeners. */
export function WorkspaceShapeRefresh(): null {
  useWorkspaceShapeRefresh();
  return null;
}
