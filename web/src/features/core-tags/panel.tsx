// A record's tags, as a contributed panel. Same reasoning as the discussion
// panel beside it: tags are about the record, and a module's own detail page
// cannot import the web app's EntityAttachments without breaking isolation.

import type { EntityDetailPanelCtx } from "@cobblr/platform-web";
import { TagsSection } from "../../components/EntityAttachments";

export function TagsPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const [moduleName, sourceType] = (ctx.kind ?? "").split(":");
  if (!moduleName || !sourceType) return null;
  return <TagsSection sourceModule={moduleName} sourceType={sourceType} sourceId={ctx.entityId} />;
}
