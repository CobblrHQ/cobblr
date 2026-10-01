// Your notifications, live: a stream the server writes to the moment one
// arrives or one is read, deleted or cleared in another tab. Every
// notification query refreshes on it (the bell's count and open list, the
// notifications page), instead of the bell waiting up to 15 s to show a new
// one and its open list never refreshing. While the stream is up the polls
// slow down; when it drops they carry on as before, and it reconnects.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { notificationKeys } from "../lib/notification-keys";
import { NOTIFICATION_STREAM_EVENT } from "@cobblr/platform-contract/notification-stream";

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/** Returns whether the stream is up (so a caller can relax its poll). */
export function useNotificationStream(enabled = true): boolean {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let closed = false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = RETRY_MIN_MS;
    const again = () => {
      if (closed) return;
      retry = setTimeout(() => void connect(), wait);
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    };
    const connect = async () => {
      let ticket: string;
      try {
        ticket = (await api.meNotificationStreamTicket()).ticket;
      } catch {
        again();
        return;
      }
      if (closed) return;
      es = new EventSource(`/api/v1/me/notifications/stream?ticket=${encodeURIComponent(ticket)}`);
      es.onopen = () => {
        wait = RETRY_MIN_MS;
        setLive(true);
      };
      es.addEventListener(NOTIFICATION_STREAM_EVENT, () => void qc.invalidateQueries({ queryKey: notificationKeys.all() }));
      es.onerror = () => {
        es?.close();
        es = null;
        setLive(false);
        again();
      };
    };
    void connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
      setLive(false);
    };
  }, [enabled, qc]);
  return live;
}
