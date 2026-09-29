// A filed item says where it went, in the place it was (#3789).
//
// Filing a card used to make it vanish: the inbox read "Nothing pending", a
// toast faded, and a first-time visitor had no idea the yarn now lived in a
// Yarn table reachable from the menu. The owner watched every booth visitor
// get lost at exactly that moment.
//
// Now a filed card stays where it was, dimmed: its picture, its name, "Filed
// to Yarn", Go to Yarn (the record itself) and Undo. Several filed in a row
// read as one line, "Filed just now: 2 to Yarn, 1 to Pantry". It stays until
// the next scan arrives, until the inbox is left (the state lives with the
// page), or until ✕. Never on a timer: people look away, and a list must not
// jump under a thumb.
//
// The rows come from the one filing chokepoint (api.ts filed() →
// scanFiled.ts), so every door that files shows its result here, whichever
// button it was.

import { useEffect, useRef, useState } from "react";
import { filedIntoOf, type FiledInto } from "@cobblr/platform-contract/scan-triage";
import type { ScanInboxItem } from "./api";
import { onScanFiled } from "./scanFiled";
import { pointAtInNav } from "./navPointer";

export interface FiledRow {
  /** The row as the server returned it after filing. */
  item: ScanInboxItem;
  /** The record the filing made, or null when it filed into something that
   *  already existed. */
  createdId: string | null;
  /** The table it went to, as the person knows it ("Yarn"). */
  destination: string;
  /** The kind of the record it made, for its links. */
  kind: string | null;
  /** This was the workspace's first filing ever: the row also says where the
   *  table lives in the menu, once. */
  firstEver: boolean;
  /** What one record of the table is called ("spool"). */
  noun: string | null;
  /** The type the record was filed under (a spool under its filament type),
   *  and whether filing made it. */
  under: NonNullable<FiledInto["under"]> | null;
}

/** What a filed row says, in the person's terms. A record filed under a type
 *  names the thing added and its type, never the table of types: "Added 1
 *  spool of Royal Blue PLA (new type)" and Go to it (#3930). */
export function filedWords(row: Pick<FiledRow, "destination" | "noun" | "under">): { headline: string; go: string } {
  if (row.under) {
    const of = row.under.name.trim() ? ` of ${row.under.name.trim()}` : "";
    return { headline: `Added 1 ${row.noun ?? "item"}${of}${row.under.created ? " (new type)" : ""}`, go: "Go to it" };
  }
  return { headline: `Filed to ${row.destination}`, go: `Go to ${row.destination}` };
}

/** What a filed item is called in anything that reports the filing: the
 *  record as it was filed, which is what the person confirmed. The scan's own
 *  suggestion is a catalog's listing title as often as not ("... Yarn, 1 Pack
 *  Of 9 Skein go-upc"), and reporting it named a thing that does not exist
 *  (#4011). The suggestion stands in only for a row filed before the server
 *  said, and the code only when nothing named it. */
export function filedNameOf(item: Pick<ScanInboxItem, "suggested_metadata" | "suggested_name" | "barcode_text">): string {
  return filedIntoOf(item.suggested_metadata)?.name || item.suggested_name?.trim() || item.barcode_text || "Your item";
}

/** A filed row from the server's answer, or null when it did not say where it
 *  went (nothing to point at, so no row). */
export function filedRowOf(item: ScanInboxItem, createdId: string | null, firstEver = false): FiledRow | null {
  const into = filedIntoOf(item.suggested_metadata);
  if (!into) return null;
  return { item, createdId, destination: into.label, kind: into.kind, firstEver, noun: into.noun ?? null, under: into.under ?? null };
}

const newestFirst = (a: ScanInboxItem, b: ScanInboxItem) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));

/** The inbox list with each filed row kept where it was: pending rows as they
 *  come, filed rows put back among them in the list's own newest-first order.
 *  A row that is pending again (undone) is shown as pending, never twice. */
export function withFiledRows(items: readonly ScanInboxItem[], rows: readonly FiledRow[]): ScanInboxItem[] {
  if (!rows.length) return [...items];
  const present = new Set(items.map((i) => i.id));
  const phantoms = rows.filter((r) => !present.has(r.item.id)).map((r) => r.item);
  if (!phantoms.length) return [...items];
  // A stable merge by the list's order: items keep their relative order, and
  // each filed row lands where its created_at puts it.
  const out: ScanInboxItem[] = [];
  const ph = [...phantoms].sort(newestFirst);
  let j = 0;
  for (const it of items) {
    while (j < ph.length && newestFirst(ph[j]!, it) <= 0) out.push(ph[j++]!);
    out.push(it);
  }
  while (j < ph.length) out.push(ph[j++]!);
  return out;
}

/** "2 to Yarn, 1 to Pantry": each destination once, in the order they were
 *  filed into, with how many went there. */
export function filedSummary(rows: readonly FiledRow[]): Array<{ destination: string; kind: string | null; count: number }> {
  const out: Array<{ destination: string; kind: string | null; count: number }> = [];
  for (const r of rows) {
    const hit = out.find((o) => o.destination === r.destination);
    if (hit) hit.count++;
    else out.push({ destination: r.destination, kind: r.kind, count: 1 });
  }
  return out;
}

const FIRST_KEY = (slug: string) => `cobblr.first-filing-shown.${slug}`;

/** True exactly once per workspace (per browser): the first filing ever. */
export function claimFirstFiling(slug: string): boolean {
  try {
    if (localStorage.getItem(FIRST_KEY(slug))) return false;
    localStorage.setItem(FIRST_KEY(slug), new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

/** Whether the next scan has arrived: a pending row newer than every row the
 *  inbox held when the latest filing happened. Server timestamps on both
 *  sides; an older page loading in is not a scan. */
export function nextScanArrived(pending: ReadonlyArray<{ id: string; created_at?: string | null }>, knownNewest: string): boolean {
  return pending.some((p) => String(p.created_at ?? "") > knownNewest);
}

/** The filed rows of one inbox visit. `pending` is what the list holds now. */
export function useFiledRows(slug: string, pending: ReadonlyArray<{ id: string; created_at?: string | null }>) {
  const [rows, setRows] = useState<FiledRow[]>([]);
  // The newest row the inbox held when the latest filing happened.
  const knownNewest = useRef("");
  const latest = useRef(pending);
  latest.current = pending;

  useEffect(
    () =>
      onScanFiled(slug, (change) => {
        const undone = new Set(change.unfiled ?? []);
        const filed = (change.filed ?? [])
          .map((f) => filedRowOf(f.item, f.createdId))
          .filter((r): r is FiledRow => !!r);
        if (!filed.length && !undone.size) return;
        knownNewest.current = [...latest.current.map((p) => String(p.created_at ?? "")), ...filed.map((f) => String(f.item.created_at ?? "")), knownNewest.current].sort().at(-1) ?? "";
        // Claimed here, once, never inside the state updater (which may run twice).
        const first = filed.length > 0 && claimFirstFiling(slug);
        if (first) pointAtInNav(slug, filed[0]!.destination);
        setRows((prev) => {
          const kept = prev.filter((r) => !undone.has(r.item.id) && !filed.some((f) => f.item.id === r.item.id));
          return [...kept, ...filed.map((f, i) => (first && i === 0 ? { ...f, firstEver: true } : f))];
        });
      }),
    [slug],
  );

  // The next scan clears them.
  useEffect(() => {
    if (rows.length && nextScanArrived(pending, knownNewest.current)) setRows([]);
  }, [pending, rows.length]);

  return { rows, dismiss: () => setRows([]) };
}
