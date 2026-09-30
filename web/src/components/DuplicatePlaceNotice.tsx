// A place already has a child with the name someone typed. The server refuses
// (duplicate_sibling) in words written for the assistant ("ask again with
// allow_duplicate"), which left a person reading a sentence about a flag with
// nothing to press. This says it in their words and offers the two ways on:
// open the one that is there, or make a second one anyway.
import { AlertTriangle } from "lucide-react";
import { ApiError } from "../lib/api";

/** The place a duplicate_sibling refusal found, when it is one. */
export function duplicatePlaceOf(err: unknown): { existingId: string } | null {
  if (!(err instanceof ApiError) || err.code !== "duplicate_sibling") return null;
  const id = (err.details as { existing_id?: unknown } | undefined)?.existing_id;
  return typeof id === "string" ? { existingId: id } : null;
}

export function DuplicatePlaceNotice({
  name,
  parentName,
  onOpen,
  onKeepBoth,
  keepBothLabel,
}: {
  name: string;
  parentName: string | null;
  onOpen: () => void;
  onKeepBoth: () => void;
  keepBothLabel: string;
}) {
  return (
    <div role="alert" className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm space-y-2">
      <div className="flex items-start gap-2 text-content dark:text-mortar-100">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          {parentName ? `${parentName} already has` : "There is already"} a place called <b>{name.trim()}</b>
          {parentName ? "" : " at the top level"}.
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onOpen} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white">
          Open it
        </button>
        <button type="button" onClick={onKeepBoth} className="px-3 py-1.5 text-sm rounded border border-line dark:border-slate-700 text-content hover:bg-subtle dark:hover:bg-slate-800">
          {keepBothLabel}
        </button>
      </div>
    </div>
  );
}
