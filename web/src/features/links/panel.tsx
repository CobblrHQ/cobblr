// A record's links, as the universal panel: module-owned pages (a part, a
// project, a list) cannot import the web app's EntityAttachments, so this is
// how they get Links at all (#3875). The page's table, when it has one,
// arrives as the `collection` hint so the links it declares are offered.
import type { EntityDetailPanelCtx } from "@cobblr/platform-web";
import { LinksSection } from "./LinksSection";

export function LinksPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  if (!ctx.kind) return null;
  return <LinksSection kind={ctx.kind} entityId={ctx.entityId} collection={ctx.hints?.collection} compact />;
}
