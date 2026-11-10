// A record's main photo, put back (core-scan:put-back-main-photo): the Undo
// of making a picture main, from the photo search, a paste or the star on a
// photo tile. It used to write the old address back whatever the record
// showed by then, so a photo a teammate chose since was replaced, or cleared
// when the record had none before (#9377's class). It puts the old photo back
// only while the record still shows the one that change set, and says why
// when it does not. Issued only to whoever made the change (entity-image.ts).
// Wired in ./index.ts.
import { platform } from "@cobblr/platform-contract";
import { setMainPhoto, writeImagePath } from "../services/entity-image.js";
import { fileIdOfImagePath } from "../services/record-photo-searches.js";

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The same photo: one address, or two spellings of one stored file. */
function samePhoto(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  const fa = fileIdOfImagePath(a);
  return !!fa && fa === fileIdOfImagePath(b);
}

export function registerPutBackMainPhotoAction(): void {
  platform().actions.registerHandler("core-scan.put-back-main-photo", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const entityKind = text(a.entity_kind);
    const entityId = text(a.entity_id);
    const made = text(a.made);
    const previous = text(a.previous);
    if (!entityKind || !entityId || !made) return { ok: false, error: "Say which record and which photo: entity_kind, entity_id and made." };
    const now = await platform().entities.lookup(ctx.orgId, entityKind, entityId).catch(() => null);
    if (!now) return { ok: false, error: "That record is gone, so there is no photo to put back." };
    const shown = (now.image_path ?? (now.fields as { image_path?: unknown } | undefined)?.image_path ?? null) as string | null;
    if (!samePhoto(shown, made)) {
      return { ok: false, error: "Kept: this record's photo was changed since, so the old one was not put back over it." };
    }
    const orgSlug = (await platform().orgs.get(ctx.orgId).catch(() => null))?.slug ?? "";
    const bearer = ctx.userId && orgSlug ? await platform().auth.mintSession({ userId: ctx.userId }).catch(() => null) : null;
    if (!bearer) return { ok: false, error: "Nobody to put it back as: sign in again." };
    const target = { orgId: ctx.orgId, orgSlug, bearer, entityKind, entityId, instance: text(a.instance) ?? now.instance ?? null };
    const previousFile = fileIdOfImagePath(previous);
    const put = previousFile ? await setMainPhoto({ ...target, fileId: previousFile }) : await writeImagePath(target, previous);
    if ("refused" in put) return { ok: false, error: put.refused.message };
    return { ok: true, summary: previous ? "The photo it had is back." : "The photo is off the record again; it stays in its photos." };
  });
}
