import { type ScanHistoryEntryStored } from "@cobblr/platform-contract/scan-history-words";
import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

// "Put back" on the card's History and Undo on its toast (#6100): every
// rewrite of a scan row records the row first, and this restores it.
const tool: WorkspaceTool = {
  name: "put_back_scan_item",
  description:
    "Put a scan inbox item back as it was before a step in its History (a lookup that renamed it wrongly). Omit revision to undo the newest change; get_scan_item's history_words gives each step's revision.",
  mode: "write",
  params: {
    id: z.string().describe("An id from list_scan_inbox"),
    revision: z.string().optional().describe("A step's revision from get_scan_item history_words"),
  },
  execute: async (api, args) => {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) return toolFail("id is required: take one from list_scan_inbox");
    let revision = typeof args.revision === "string" ? args.revision.trim() : "";
    if (!revision) {
      const got = await api.request("GET", `/modules/core-scan/inbox/${encodeURIComponent(id)}`);
      if (got.status >= 400) return toolFail(apiErrorMessage(got, "couldn't read that scan item"));
      const history = ((got.body as { suggested_metadata?: { history?: ScanHistoryEntryStored[] } }).suggested_metadata?.history ?? []);
      revision = [...history].reverse().find((h) => h.revision)?.revision ?? "";
      if (!revision) return toolFail("nothing on this item recorded an earlier version to put back");
    }
    const res = await api.request("POST", `/modules/core-scan/inbox/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/restore`, {});
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't put that item back"));
    const back = res.body as { id?: string; suggested_name?: string | null; suggested_metadata?: { history?: ScanHistoryEntryStored[] } };
    // The put-back recorded the row before it restored: its own entry's
    // revision is what takes the put-back back.
    const undo = back.suggested_metadata?.history?.at(-1)?.revision ?? null;
    return toolOk({ id: back.id ?? id, name: back.suggested_name ?? null, put_back: revision, undo_revision: undo });
  },
};

export default tool;
