import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EDITED_FROM_HEADER, decodeEditedFrom, encodeEditedFrom } from "@cobblr/platform-contract/edited-from";
import { subscribeSavedEdit, useToast, type SavedEdit } from "@cobblr/platform-web";
import { request } from "../lib/api/client";

/** Saves of one record in a row are one Undo: each field goes back to what it
 *  was before the first of them, judged against what the last one left. */
export function mergeSavedEdits(earlier: SavedEdit, later: SavedEdit): SavedEdit {
  const now = { ...(decodeEditedFrom(earlier.headers[EDITED_FROM_HEADER]) ?? {}), ...(decodeEditedFrom(later.headers[EDITED_FROM_HEADER]) ?? {}) };
  return { ...later, back: { ...later.back, ...earlier.back }, headers: { ...later.headers, [EDITED_FROM_HEADER]: encodeEditedFrom(now) } };
}

/** The Undo for every field a person saves on a page (saved-edit-undo.ts). */
export function SavedEditUndo() {
  const toast = useToast();
  const qc = useQueryClient();
  const offered = useRef<{ edit: SavedEdit; toast: number } | null>(null);
  const { mutateAsync: putBack } = useMutation({
    mutationFn: async (edit: SavedEdit) => {
      await request(edit.method, edit.path, edit.back, edit.headers);
      await qc.invalidateQueries();
    },
  });
  useEffect(() => subscribeSavedEdit((saved) => {
    const last = offered.current;
    const edit = last && last.edit.path === saved.path ? mergeSavedEdits(last.edit, saved) : saved;
    if (last) toast.dismiss(last.toast);
    // UNDO: puts back the fields this save changed, judged against what it wrote, so a later change by anyone is refused, never reversed
    const id = toast.action("Saved.", {
      actionLabel: "Undo",
      duration: 8000,
      onAction: async () => {
        if (offered.current?.toast === id) offered.current = null;
        await putBack(edit);
        toast.success("Put back.");
      },
    });
    offered.current = { edit, toast: id };
  }), [toast, putBack]);
  return null;
}
