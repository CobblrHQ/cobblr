// "Suggested photo" as a universal record panel (#3818): every record page
// that hosts contributed panels offers the picture the platform found for a
// record made without one, including module-owned pages that cannot import
// the web app. A page that shows the offer beside the picture itself keeps
// this one quiet.

import { useQueryClient } from "@tanstack/react-query";
import type { EntityDetailPanelCtx } from "@cobblr/platform-web";
import { SuggestedPhoto } from "../../components/SuggestedPhoto";
import { useShownBeside } from "../../lib/photoSuggestions";

export function SuggestedPhotoPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const qc = useQueryClient();
  const kind = ctx.kind ?? "";
  const beside = useShownBeside(ctx.entityId);
  if (!kind || beside) return null;
  return (
    <SuggestedPhoto
      kind={kind}
      id={ctx.entityId}
      hasPicture={false}
      besidePicture={false}
      // The record's own page reads it from a query this panel cannot name:
      // refresh what is on screen.
      onApplied={() => void qc.invalidateQueries()}
    />
  );
}
