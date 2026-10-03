// Telling a share's people what happened, once per burst
// (docs/design-decisions/share-spaces.md §10).
//
// The owner hears "Vince suggested 6 edits on 3 things" (or "Vince changed 3
// things through your share" on a Direct share); the friend hears "Sam
// accepted 4 of your edits". Each event is a row (share_notices); a pass
// sends a link's unsent rows of one kind as ONE notification half a minute after
// the last of them, so a friend tidying twenty fields is one message, never
// twenty. Delivery windows then roll it into a digest like anything else.

import { countOf, platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import type { ShareNoticesTable } from "../db/schema.js";
import { kickShareSync, registerShareOp } from "./share-sync.js";

type NoticeKind = ShareNoticesTable["kind"];

export const SHARE_EDITS_SUGGESTED = "share.edits.suggested";
export const SHARE_EDITS_DECIDED = "share.edits.decided";

const SETTLE_MS = 30_000;

/** Something happened on a share that its people should hear about. */
export async function noteShare(linkId: string, kind: NoticeKind, title: string | null): Promise<void> {
  await meta.insertInto("share_notices").values({ link_id: linkId, kind, title }).execute();
  kickShareSync(SETTLE_MS + 2_000);
}

/** The friend's side hears what the owner decided about their edits. */
export function registerShareNoticeOps(): void {
  registerShareOp("edits.decided", async (link, p) => {
    const kind = p.decision;
    if (kind !== "accepted" && kind !== "rejected" && kind !== "undone") return;
    await noteShare(link.id, kind, typeof p.title === "string" ? p.title : null);
  });
}

function sentence(kind: NoticeKind, who: string, n: number, titles: string[]): string {
  const things = titles.length === 1 ? titles[0]! : countOf(titles.length, "thing");
  switch (kind) {
    case "suggested":
      return `${who} suggested ${countOf(n, "edit")} to ${things}`;
    case "applied":
      return `${who} changed ${things} through your share`;
    case "added":
      return `${who} added ${things} to the share`;
    case "accepted":
      return n === 1 ? `${who} accepted your edit to ${things}` : `${who} accepted ${n} of your edits`;
    case "rejected":
      return n === 1 ? `${who} kept their own value for ${things}` : `${who} turned down ${n} of your edits`;
    case "undone":
      return n === 1 ? `${who} undid your edit to ${things}` : `${who} undid ${n} of your edits`;
  }
}

/** Send what has settled: one notification per link and kind. */
export async function sendDueShareNotices(): Promise<void> {
  const settled = new Date(Date.now() - SETTLE_MS);
  const groups = await meta
    .selectFrom("share_notices")
    .select(["link_id", "kind", (eb) => eb.fn.max("created_at").as("last")])
    .where("sent_at", "is", null)
    .groupBy(["link_id", "kind"])
    .execute();
  for (const g of groups) {
    if (new Date(g.last as unknown as string) > settled) continue;
    try {
      const link = await meta.selectFrom("share_links").select(["org_id", "side", "status", "peer_name"]).where("id", "=", g.link_id).executeTakeFirst();
      const rows = await meta.selectFrom("share_notices").select(["id", "title"]).where("link_id", "=", g.link_id).where("kind", "=", g.kind).where("sent_at", "is", null).execute();
      await meta
        .updateTable("share_notices")
        .set({ sent_at: new Date() })
        .where("id", "in", rows.map((r) => r.id))
        .execute();
      if (!link || link.status !== "active" || !rows.length) continue;
      const who = link.peer_name ?? (link.side === "owner" ? "Someone you share with" : "The person who shared this");
      const titles = [...new Set(rows.map((r) => r.title).filter((t): t is string => !!t))];
      const message = sentence(g.kind, who, rows.length, titles.length ? titles : ["a thing"]);
      if (link.side === "owner") {
        const where = g.kind === "applied" ? "/configuration/sharing" : "/suggestions";
        for (const userId of await platform().notifications.audienceFor(link.org_id, SHARE_EDITS_SUGGESTED)) {
          await platform().notifications.dispatch({ orgId: link.org_id, userId, eventType: SHARE_EDITS_SUGGESTED, message, link_url: where, priority: "normal", triggeredBy: "activity" }); // dispatch-per-row-ok: one per person the kind is for; the rows were folded into this one message
        }
      } else {
        for (const userId of await platform().notifications.audienceFor(link.org_id, SHARE_EDITS_DECIDED)) {
          // PAGE-LINK: answers about several things at once; the share's page is where they are listed
          await platform().notifications.dispatch({ orgId: link.org_id, userId, eventType: SHARE_EDITS_DECIDED, message, link_url: "/configuration/sharing", priority: "normal", triggeredBy: "activity" }); // dispatch-per-row-ok: one per person the kind is for; the rows were folded into this one message
        }
      }
    } catch (err) {
      console.error(`[share] notice for ${g.link_id} failed:`, err);
    }
  }
}
