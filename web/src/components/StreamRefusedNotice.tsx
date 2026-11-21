// The plain words a refused live stream leaves (lib/live-stream.ts, #4115): a
// member removed, or made a guest, while the phone was locked comes back to a
// page that has stopped updating, and is told why once, never left watching
// numbers that no longer move.
import { useSyncExternalStore } from "react";
import { FloatingChrome } from "@cobblr/platform-web";
import { streamRefusedNotice, subscribeStreamRefused } from "../lib/live-stream";

export function StreamRefusedNotice() {
  const notice = useSyncExternalStore(subscribeStreamRefused, streamRefusedNotice, () => null);
  if (!notice) return null;
  return (
    <FloatingChrome
      anchor="top"
      reserveTop
      yields={false}
      role="status"
      data-testid="stream-refused"
      className="z-[190] border-b border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-4 py-2 text-center text-sm"
    >
      {notice}
    </FloatingChrome>
  );
}
