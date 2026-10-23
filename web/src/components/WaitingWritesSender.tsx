// Sends the writes an earlier page left waiting on this device (#7863): once
// this page opens online, and again whenever the connection returns. Each
// lands in the order it was made; then everything on screen is read again.
// A write the server refuses (the record went, a rule says no) is said, never
// left to wait forever. And while more of this page's writes wait than it
// kept on the device (a photo, which uploads another way), leaving asks first.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { browserOffline, keptByThisPage, useToast } from "@cobblr/platform-web";
import { subscribeConnectivity } from "../lib/api";
import { sendWaitingWritesNow } from "../lib/offline-writes";

export function WaitingWritesSender() {
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    let sending = false;
    const send = async () => {
      if (sending || browserOffline()) return;
      sending = true;
      try {
        const { landed, refused } = await sendWaitingWritesNow();
        if (landed) {
          toast.success(landed === 1 ? "Saved the change you made offline." : `Saved the ${landed} changes you made offline.`);
          void qc.invalidateQueries();
        }
        for (const { reason } of refused) toast.error(`A change you made offline was not saved: ${reason || "it was refused."}`);
      } finally {
        sending = false;
      }
    };
    void send();
    const off = subscribeConnectivity((down) => {
      if (!down) void send();
    });
    const leaving = (e: BeforeUnloadEvent) => {
      const waiting = qc.getMutationCache().getAll().filter((m) => m.state.isPaused).length;
      if (waiting <= keptByThisPage()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("online", send);
    window.addEventListener("beforeunload", leaving);
    return () => {
      off();
      window.removeEventListener("online", send);
      window.removeEventListener("beforeunload", leaving);
    };
  }, [qc, toast]);
  return null;
}
