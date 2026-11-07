// Take back a picture (core-scan:take-back-picture, #9271): the assistant's door
// to the card's X (services/take-back-picture.ts). Wired in ./index.ts.
import { platform } from "@cobblr/platform-contract";
import { takeBackPicture } from "../services/take-back-picture.js";
import { door } from "./undo-split-action.js";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function registerTakeBackPictureAction(): void {
  platform().actions.registerHandler("core-scan.take-back-picture", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const itemId = str(args.item_id);
    const fileId = str(args.file_id);
    if (!itemId && !fileId) return { ok: false, error: "Say which picture: item_id from the scan inbox, or file_id." };
    const { db } = await door(ctx);
    const r = await takeBackPicture(db, ctx.orgId, { itemId, fileId });
    switch (r.outcome) {
      case "row":
        return { ok: true, summary: `${r.name ?? "That picture"} was taken back and is in Recently deleted.`, data: r };
      case "removed":
        return { ok: true, summary: "That picture was taken back. Nothing was made from it.", data: r };
      case "joined":
        return { ok: false, error: `That picture joined ${r.name ?? "a scan"}, which was already waiting, so it was left there.` };
      case "filed":
        return { ok: false, error: `${r.name ?? "That scan"} is already filed. Undo it from Recently committed instead.` };
      case "nothing":
        return { ok: false, error: "That scan is not in the inbox." };
    }
  });
}
