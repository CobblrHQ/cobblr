// A picture handed to the inbox is on screen before its upload is (#3852).
//
// A screenshot pasted into the inbox showed nothing until its upload and
// its scan had both come back, a few seconds on a good day, and it was
// pasted again, so the inbox held two identical items. Every door the
// intake has (paste, drop, the photo button, the dashboard tile) adds the
// picture here the moment it lands; the inbox draws it at the top with its
// stage, and it gives way to the real row once that row is in the list.

import { useSyncExternalStore } from "react";

export type PendingStage = "uploading" | "reading" | "failed";

export interface PendingPicture {
  key: string;
  /** A local preview of the picture itself. */
  url: string;
  name: string;
  stage: PendingStage;
  /** The row the scan made, once it answered. */
  rowId?: string;
  /** The stored file, once the upload finished: from here Undo can read it again. */
  fileId?: string;
  at: number;
}

const bySlug = new Map<string, PendingPicture[]>();
const listeners = new Set<() => void>();
let seq = 0;
const EMPTY: PendingPicture[] = [];

function changed(slug: string, next: PendingPicture[]): void {
  bySlug.set(slug, next);
  for (const l of listeners) l();
}

function objectUrl(file: File): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return "";
  }
}

export function addPending(slug: string, files: File[]): string[] {
  const now = Date.now();
  const added = files.map((f) => ({ key: `p${++seq}`, url: objectUrl(f), name: f.name, stage: "uploading" as const, at: now }));
  changed(slug, [...added, ...(bySlug.get(slug) ?? [])]);
  return added.map((a) => a.key);
}

export function updatePending(slug: string, key: string, patch: Partial<Pick<PendingPicture, "stage" | "rowId" | "fileId">>): void {
  changed(slug, (bySlug.get(slug) ?? []).map((p) => (p.key === key ? { ...p, ...patch } : p)));
}

/** What the door that started a picture needs to stop or redo it (#9271). */
const doors = new Map<string, { abort: AbortController; again: () => void }>();
const takenBack = new Set<string>();

export function openPendingDoor(key: string, again: () => void): AbortSignal {
  const abort = new AbortController();
  doors.set(key, { abort, again });
  return abort.signal;
}

/** The picture's door, for its X: stops the upload, and answers from then on that
 *  this picture was taken back, however late its answers come. */
export function markTakenBack(key: string): { again: () => void } | null {
  takenBack.add(key);
  const door = doors.get(key) ?? null;
  door?.abort.abort();
  doors.delete(key);
  return door ? { again: door.again } : null;
}

export function wasTakenBack(key: string): boolean {
  return takenBack.has(key);
}

const expiries = new Map<string, ReturnType<typeof setTimeout>>();

/** Drop this picture after `ms` if nothing else has. Its row may land
 *  outside the view (another session's filter), so a placeholder never
 *  outstays its upload by long. Held here, not by the component that
 *  started the upload: the dashboard's door navigates away mid-upload. */
export function expirePending(slug: string, key: string, ms: number): void {
  const prev = expiries.get(key);
  if (prev !== undefined) clearTimeout(prev);
  expiries.set(
    key,
    setTimeout(() => {
      expiries.delete(key);
      dropPending(slug, key);
    }, ms),
  );
}

export function dropPending(slug: string, key: string): void {
  const expiry = expiries.get(key);
  if (expiry !== undefined) {
    clearTimeout(expiry);
    expiries.delete(key);
  }
  doors.delete(key);
  const gone = (bySlug.get(slug) ?? []).find((p) => p.key === key);
  if (gone?.url) {
    try {
      URL.revokeObjectURL(gone.url);
    } catch {
      /* nothing to free */
    }
  }
  changed(slug, (bySlug.get(slug) ?? []).filter((p) => p.key !== key));
}

/** The pictures on their way into this workspace's inbox, newest first. */
export function usePendingPictures(slug: string | null | undefined): PendingPicture[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (slug ? (bySlug.get(slug) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}

const pulses = new Map<string, ReturnType<typeof setTimeout>>();

/** Draw attention to a row already in the inbox: scroll to it and pulse it. */
export function pulseRow(rowId: string): void {
  const el = typeof document !== "undefined" ? document.getElementById(`scan-item-${rowId}`) : null;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("ring-2", "ring-accent", "animate-pulse");
  const prev = pulses.get(rowId);
  if (prev !== undefined) clearTimeout(prev);
  pulses.set(
    rowId,
    setTimeout(() => {
      pulses.delete(rowId);
      el.classList.remove("ring-2", "ring-accent", "animate-pulse");
    }, 2500),
  );
}
