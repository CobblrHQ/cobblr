// Mounted once in the shell: the blocked-action sheet's code loads only when
// something was refused, or a ?resume link was opened (#4945). The sheet
// subscribes again when it mounts, and a subscription replays the current
// refusal, so nothing raised before it arrives is missed.
import { lazy, Suspense, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { subscribeBlockedAction, type RaisedBlock } from "../lib/blocked-action";

const BlockedActionSheet = lazy(() => import("./BlockedActionSheet").then((m) => ({ default: m.BlockedActionSheet })));

export function BlockedActionHost() {
  const [raised, setRaised] = useState<RaisedBlock | null>(null);
  useEffect(() => subscribeBlockedAction(setRaised), []);
  const resume = new URLSearchParams(useLocation().search).has("resume");
  const [needed, setNeeded] = useState(false);
  if ((raised || resume) && !needed) setNeeded(true);
  if (!needed) return null;
  return (
    <Suspense fallback={null}>
      <BlockedActionSheet />
    </Suspense>
  );
}
