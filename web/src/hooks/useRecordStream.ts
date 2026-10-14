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

export function useRecordStream(slug: string | null | undefined, role: string | null | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!slug || !roleSatisfies(role, ["member"]) || typeof EventSource === "undefined") return;
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
  }, [slug, role, qc]);
}
