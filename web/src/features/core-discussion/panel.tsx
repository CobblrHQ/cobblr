// A record's conversation, as a contributed panel.
//
// The web app's own detail pages (records, assets, machines, locations) reach
// discussion through EntityAttachments. A module's detail page cannot: it may
// not import from web/src, which is the isolation rule working as intended.
// The consequence was that inventory parts — the most-used record type in the
// product — had no way to reach discussion at all.
//
// So the same seam that lets purchases put price history on a part carries the
// conversation too. The panel declares `target: "*"`, and any detail view that
// renders <ContributedDetailPanels> gets it, including ones written after this.

import type { EntityDetailPanelCtx } from "@cobblr/platform-web";
import { DiscussionPreview } from "../../components/DiscussionTab";

export function DiscussionPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  // `kind` is filled in by ContributedDetailPanels from its own target, so a
  // universal panel still knows what it is looking at.
  const [moduleName, sourceType] = (ctx.kind ?? "").split(":");
  if (!moduleName || !sourceType) return null;
  return (
    <DiscussionPreview sourceModule={moduleName} sourceType={sourceType} sourceId={ctx.entityId} />
  );
}
