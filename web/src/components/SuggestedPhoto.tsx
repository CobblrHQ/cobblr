// "Suggested photo" as a card of its own (#3818), for a record page that has
// no photo box to show it in: the universal panel. A page with a photo box
// shows the suggestion IN it (RecordPhoto); both answer it the same way, from
// the same hooks. Nothing shows once the record has a picture of its own.

import { EntityPhoto } from "@cobblr/platform-web";
import { SuggestionAnswer, useSuggestionAnswers, WebPhotoSearch } from "./RecordPhoto";

export function SuggestedPhoto({
  kind,
  id,
  hasPicture,
  brand,
  onApplied,
  instance,
}: {
  kind: string;
  id: string;
  /** The record has a picture of its own: say nothing. */
  hasPicture: boolean;
  brand?: string | null;
  /** The record changed: refetch it. */
  onApplied: () => void;
  /** The instance the record lives in, for the platform's own save. */
  instance?: string | null;
}) {
  const answers = useSuggestionAnswers({ kind, id, onApplied });
  const { suggestion, savedKind } = answers;
  const recordInstance = instance ?? (savedKind.endsWith(":item") ? savedKind.split(":")[0] ?? null : null);
  if (hasPicture || !suggestion) return null;
  if (suggestion.status !== "suggested") return <SuggestionAnswer answers={answers} />;
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-accent/60 bg-cobble-50/50 p-2.5 dark:bg-cobble-900/20">
      <div className="flex items-start gap-2.5">
        <EntityPhoto src={suggestion.image_path} alt="Suggested photo" size={72} className="shrink-0 rounded" />
        <div className="min-w-0 space-y-1.5">
          <div className="text-sm font-medium text-content dark:text-mortar-100">Suggested photo</div>
          <SuggestionAnswer answers={answers} />
        </div>
      </div>
      <WebPhotoSearch kind={savedKind} id={id} instance={recordInstance} brand={brand} onSaved={onApplied} />
    </div>
  );
}
