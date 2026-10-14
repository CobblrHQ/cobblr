// "A record in this workspace changed", told to the workspace's open tabs the
// moment its activity row is written (#6337). The owner's Dremel was set to
// loaned through MCP while its page was open, and the page kept saying
// REBUILDING with a History that ended 13 days earlier: nothing told it.
// In-process, like the notification stream: every write, MCP's included, is
// made by the api that serves the tabs.
import type { RecordStreamChange } from "@cobblr/platform-contract/record-stream";

type Listener = (change: RecordStreamChange) => void;

const listeners = new Map<string, Set<Listener>>();

export function onRecordChange(orgId: string, fn: Listener): () => void {
  let set = listeners.get(orgId);
  if (!set) listeners.set(orgId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(orgId);
  };
}

export function announceRecordChange(orgId: string, change: RecordStreamChange): void {
  for (const fn of listeners.get(orgId) ?? []) {
    try {
      fn(change);
    } catch {
      // One closed tab must not stop the others hearing it.
    }
  }
}
