// A tiny SSE reader over fetch.
//
// The browser's EventSource cannot send an Authorization header, and this app
// authenticates with a Bearer token, not a cookie - so a native EventSource
// against our api is always 401. fetch + a streaming body reader speaks the
// same wire format and carries the header. It also lets a caller abort, which
// EventSource only does by close().
//
// Reconnect is the caller's job (they know the last seq they saw and can pass
// ?after=N); this reads one connection to its end.

import { getToken } from "./api";

export interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

export async function readSse(
  url: string,
  onEvent: (ev: SseEvent) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: opts.signal });
  if (!res.ok || !res.body) {
    let msg = `stream ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      msg = j.error?.message ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let cur: { id: string | null; event: string; data: string[] } = { id: null, event: "message", data: [] };
  const flush = () => {
    if (cur.data.length) onEvent({ id: cur.id, event: cur.event, data: cur.data.join("\n") });
    cur = { id: null, event: "message", data: [] };
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        flush();
        continue;
      }
      if (line.startsWith(":")) continue; // comment / heartbeat
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") cur.event = value;
      else if (field === "data") cur.data.push(value);
      else if (field === "id") cur.id = value;
    }
  }
  flush();
}
