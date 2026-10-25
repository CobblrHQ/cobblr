// A record written elsewhere shows on the page that has it open (#6337).
//
// The owner set his Dremel to loaned through MCP while its page was open, and
// the page kept saying REBUILDING, with a History that ended 13 days earlier,
// until a reload. The workspace's record stream says which record was written
// the moment its activity row lands (another device, MCP, an automation,
// another person), and this refreshes what showed it: the record by its id,
// and every query of its kind, through the same rule an action's own refresh
// uses. A burst (an import, a bulk edit) is gathered into one refresh.
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryShowsKinds } from "@cobblr/platform-web";
import { RECORD_STREAM_EVENT, type RecordStreamChange } from "@cobblr/platform-contract/record-stream";
import { api } from "../lib/api";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { STREAM_LINGER_MS } from "./useNotificationStream";

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const GATHER_MS = 400;

/** Refresh every query that showed one of these records or their kinds. */
export function refreshForChanges(qc: QueryClient, changes: readonly RecordStreamChange[]): void {
  if (changes.length === 0) return;
  const kinds = [...new Set(changes.map((c) => c.kind))];
  const ids = new Set(changes.map((c) => c.id));
  void qc.invalidateQueries({
    predicate: (q) => queryShowsKinds(q, kinds) || q.queryKey.some((part) => typeof part === "string" && ids.has(part)),
  });
}

/** One stream per workspace for the tab. It outlives the shell that opened it
 *  by STREAM_LINGER_MS: the shell can be drawn twice as a page loads, and the
 *  stream was shut and opened again, two tickets asked for on every load and
 *  one of them thrown away (#6881). */
const streams = new Map<string, { users: number; stop: () => void; linger?: ReturnType<typeof setTimeout> }>();

export function useRecordStream(slug: string | null | undefined, role: string | null | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!slug || typeof EventSource === "undefined") return;
    if (!roleSatisfies(role, ["member"])) {
      // Made a guest: the stream another view may still be lingering on is
      // shut now, not when the linger ends (a guest is told no record's
      // changes).
      const lingering = streams.get(slug);
      if (lingering && lingering.users === 0) {
        clearTimeout(lingering.linger);
        lingering.stop();
        streams.delete(slug);
      }
      return;
    }
    let mine = streams.get(slug);
    if (mine) {
      clearTimeout(mine.linger);
      mine.users++;
    } else {
      mine = { users: 1, stop: openRecordStream(slug, qc) };
      streams.set(slug, mine);
    }
    const held = mine;
    return () => {
      held.users--;
      if (held.users > 0) return;
      clearTimeout(held.linger);
      held.linger = setTimeout(() => {
        if (held.users > 0 || streams.get(slug) !== held) return;
        held.stop();
        streams.delete(slug);
      }, STREAM_LINGER_MS);
    };
  }, [slug, role, qc]);
}

function openRecordStream(slug: string, qc: QueryClient): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let gather: ReturnType<typeof setTimeout> | undefined;
  let pending: RecordStreamChange[] = [];
  let wait = RETRY_MIN_MS;
  const again = () => {
    if (closed) return;
    retry = setTimeout(() => void connect(), wait);
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  };
  const heard = (change: RecordStreamChange) => {
    pending.push(change);
    if (gather) return;
    gather = setTimeout(() => {
      gather = undefined;
      const batch = pending;
      pending = [];
      refreshForChanges(qc, batch);
    }, GATHER_MS);
  };
  const connect = async () => {
    let ticket: string;
    try {
      ticket = (await api.recordStreamTicket(slug)).ticket;
    } catch {
      again();
      return;
    }
    if (closed) return;
    es = new EventSource(`/api/v1/orgs/${encodeURIComponent(slug)}/records/stream?ticket=${encodeURIComponent(ticket)}`);
    es.onopen = () => {
      wait = RETRY_MIN_MS;
    };
    es.addEventListener(RECORD_STREAM_EVENT, (e) => {
      try {
        const change = JSON.parse((e as MessageEvent<string>).data) as RecordStreamChange;
        if (typeof change?.kind === "string" && typeof change?.id === "string") heard(change);
      } catch {
        // A malformed line is ignored; the next write says it again.
      }
    });
    es.onerror = () => {
      es?.close();
      es = null;
      again();
    };
  };
  void connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    clearTimeout(gather);
    es?.close();
  };
}
