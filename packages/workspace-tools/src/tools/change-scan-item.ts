import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

// What a person does to scan inbox items from their cards (#6949), as one
// tool so the turn's tool list stays inside its budget. Each step calls the
// card's own route with the asker's sign-in, so the role and the item's own
// rules are the card's, and each says its way back.
const tool: WorkspaceTool = {
  name: "change_scan_item",
  module: "core-scan",
  description:
    "Tidy scan inbox items before filing. do: edit (name, quantity, location_id, empty_box, reviewed, keep_separate), discard (to Recently deleted), restore, send_back (a filed scan returns to the inbox), rerun (hint, wrong, more_detail), combine (ids, keep_id; quantities add), uncombine (either row), theme (ids, tag, category), photo (rotate, add_file_id, main_file_id or remove_file_id).",
  mode: "write",
  params: {
    do: z.enum(["edit", "discard", "restore", "send_back", "rerun", "combine", "uncombine", "theme", "photo"]),
    id: z.string().optional().describe("An id from list_scan_inbox"),
    ids: z.array(z.string()).max(200).optional(),
    name: z.string().optional(),
    quantity: z.number().optional(),
    location_id: z.string().nullable().optional(),
    empty_box: z.boolean().optional(),
    reviewed: z.boolean().optional(),
    keep_separate: z.boolean().optional(),
    hint: z.string().optional(),
    wrong: z.boolean().optional(),
    more_detail: z.boolean().optional(),
    keep_id: z.string().optional(),
    tag: z.string().optional(),
    category: z.string().optional(),
    rotate: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(),
    add_file_id: z.string().optional(),
    main_file_id: z.string().optional(),
    remove_file_id: z.string().optional(),
  },
  execute: async (api, args) => {
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
    const id = str(args.id);
    const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map(String).filter(Boolean) : [];
    const at = `/modules/core-scan/inbox/${encodeURIComponent(id)}`;
    const needId = () => (id ? null : toolFail("id is required: take one from list_scan_inbox"));
    const call = async (method: "POST" | "PATCH" | "DELETE", path: string, body: Record<string, unknown> | undefined, failed: string) => {
      const res = await api.request(method, path, body);
      return res.status >= 400 ? { fail: toolFail(apiErrorMessage(res, failed)) } : { body: res.body as Record<string, unknown> };
    };
    switch (args.do) {
      case "edit": {
        const miss = needId(); if (miss) return miss;
        const body: Record<string, unknown> = {};
        if (str(args.name)) body.name = str(args.name);
        if (typeof args.quantity === "number") body.quantity = args.quantity;
        if (args.location_id !== undefined) body.target_location_id = args.location_id;
        if (typeof args.empty_box === "boolean") body.box_state = args.empty_box ? "empty-box" : "item-in-box";
        if (typeof args.reviewed === "boolean") body.reviewed = args.reviewed;
        if (typeof args.keep_separate === "boolean") body.keep_separate = args.keep_separate;
        if (!Object.keys(body).length) return toolFail("say what to change");
        // An edit records no history step, so the way back is the item as it
        // was, read first and handed back as the edit that restores it.
        const was = await api.request("GET", at);
        if (was.status >= 400) return toolFail(apiErrorMessage(was, "couldn't read that item"));
        const r = await call("PATCH", at, body, "couldn't change that item");
        if (r.fail) return r.fail;
        const before = was.body as { suggested_name?: string | null; quantity?: number | null; target_location_id?: string | null };
        return toolOk({
          id,
          name: r.body.suggested_name ?? null,
          quantity: r.body.quantity ?? null,
          undo: { do: "edit", id, ...(body.name !== undefined ? { name: before.suggested_name ?? null } : {}), ...(body.quantity !== undefined ? { quantity: before.quantity ?? null } : {}), ...(body.target_location_id !== undefined ? { location_id: before.target_location_id ?? null } : {}) },
        });
      }
      case "discard": {
        const miss = needId(); if (miss) return miss;
        const r = await call("POST", `${at}/discard`, {}, "couldn't discard that item");
        return r.fail ?? toolOk({ id, discarded: true, undo: { do: "restore", id } });
      }
      case "restore": {
        const miss = needId(); if (miss) return miss;
        const r = await call("POST", `${at}/restore`, {}, "couldn't bring that item back");
        return r.fail ?? toolOk({ id, name: r.body.suggested_name ?? null, restored: true, undo: { do: "discard", id } });
      }
      case "send_back": {
        const miss = needId(); if (miss) return miss;
        const r = await call("POST", `${at}/unconfirm`, {}, "couldn't send that scan back");
        // Filing it again needs the list it goes to: file_inbox_items, by a person's word.
        return r.fail ?? toolOk({ id, back_in_inbox: true });
      }
      case "rerun": {
        const miss = needId(); if (miss) return miss;
        const body: Record<string, unknown> = {};
        if (str(args.hint)) body.hint = str(args.hint).slice(0, 500);
        if (args.wrong === true) body.wrong = true;
        if (args.more_detail === true) body.enrich = true;
        const r = await call("POST", `${at}/rerun-ai`, body, "the lookup did not run");
        // The lookup recorded the row first, so the newest put-back takes it back.
        return r.fail ?? toolOk({ id, name: r.body.suggested_name ?? null, undo: { put_back: id } });
      }
      case "combine": {
        if (ids.length < 2) return toolFail("give two or more ids from list_scan_inbox");
        const r = await call("POST", "/modules/core-scan/inbox/combine", { ids, ...(str(args.keep_id) ? { keep_id: str(args.keep_id) } : {}) }, "couldn't combine them");
        const keep = str(args.keep_id) || ids[0]!;
        return r.fail ?? toolOk({ ...r.body, undo: { do: "uncombine", id: keep } });
      }
      case "uncombine": {
        // From either row: the absorbed ones come back as they were and the
        // kept one gives back what the combine added. A combined-away row is
        // never restored on its own, which would count its quantity twice.
        const miss = needId(); if (miss) return miss;
        const r = await call("POST", `${at}/uncombine`, {}, "couldn't undo that combine");
        return r.fail ?? toolOk({ id, uncombined: true });
      }
      case "theme": {
        const tag = str(args.tag).slice(0, 60);
        const category = str(args.category).slice(0, 80);
        if (!ids.length || (!tag && !category)) return toolFail("give ids and a tag or a category");
        const r = await call("POST", "/modules/core-scan/inbox/apply-theme", {
          ...(tag ? { tag, tag_item_ids: ids } : {}),
          ...(category ? { category: { value: category, item_ids: ids } } : {}),
        }, "couldn't apply that");
        return r.fail ?? toolOk(r.body);
      }
      case "photo": {
        const miss = needId(); if (miss) return miss;
        const ops: Array<["POST" | "DELETE", string, Record<string, unknown> | undefined]> = [];
        if (args.rotate) ops.push(["POST", `${at}/rotate`, { deg: args.rotate }]);
        if (str(args.add_file_id)) ops.push(["POST", `${at}/photos`, { file_id: str(args.add_file_id) }]);
        if (str(args.main_file_id)) ops.push(["POST", `${at}/photos/primary`, { file_id: str(args.main_file_id) }]);
        if (str(args.remove_file_id)) ops.push(["DELETE", `${at}/photos/${encodeURIComponent(str(args.remove_file_id))}`, undefined]);
        if (ops.length !== 1) return toolFail("one photo change at a time: rotate, add_file_id, main_file_id or remove_file_id");
        const r = await call(ops[0]![0], ops[0]![1], ops[0]![2], "couldn't change that photo");
        return r.fail ?? toolOk({ id, main_photo: r.body.image_file_id ?? null });
      }
      default:
        return toolFail("do is one of edit, discard, restore, send_back, rerun, combine, uncombine, theme, photo");
    }
  },
};

export default tool;
