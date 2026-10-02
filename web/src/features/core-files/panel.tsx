// A record's files, as a contributed panel, for the pages a module draws
// itself (a part's): the same Files section the other record pages show, so
// a document can be dropped or pasted there and read onto the record (#4523).
import type { EntityDetailPanelCtx } from "@cobblr/platform-web";
import { FilesSection } from "../../components/EntityAttachments";

export function FilesPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const [moduleName, sourceType] = (ctx.kind ?? "").split(":");
  if (!moduleName || !sourceType) return null;
  return <FilesSection sourceModule={moduleName} sourceType={sourceType} sourceId={ctx.entityId} />;
}
