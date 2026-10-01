// Where a photo came from, in the two words the scan inbox uses: "Your
// photo" or "Catalog photo", with AI Pick's small mark on a picture the AI
// chose. One badge for the scan inbox and every record's photos, so the
// words cannot drift apart. A photo with no stored source gets nothing,
// rather than a guess (platform-contract/photo-source).
import { Sparkles } from "lucide-react";
import { photoSourceLabel, type PhotoSource } from "@cobblr/platform-contract/photo-source";

/** AI Pick's mark: the AI chose this one. */
export function AiMark() {
  return (
    <span data-testid="ai-mark" className="inline-flex items-center gap-0.5 rounded bg-accent text-white text-[9px] font-semibold px-1 py-0.5 shadow" title="Chosen by AI Pick">
      <Sparkles size={9} /> AI
    </span>
  );
}

/** "Your photo" or "Catalog photo". `kind` alone is enough where the source
 *  is known by role (the scan inbox's own photo), not by a stored file. */
export function PhotoSourceBadge({ source, kind }: { source?: PhotoSource | null; kind?: PhotoSource["kind"] }) {
  const k = source?.kind ?? kind;
  if (!k) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      <span data-testid="photo-source" className="rounded bg-black/60 px-1 py-0.5 text-[9px] font-medium leading-none text-white">
        {photoSourceLabel(k)}
      </span>
      {k === "ai_pick" && <AiMark />}
    </span>
  );
}
