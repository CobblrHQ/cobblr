// Cobb's head on its own, for the header and every other small mark. Its art
// is generated apart from the full-body poses (CobbHeadArt.tsx) so code that
// draws only the head never loads them (#4945). Import it from here, not from
// ./Cobb, wherever the head is all that is drawn.
import { COBB_HEAD_ART, COBB_HEAD_VIEWBOX } from "./CobbHeadArt";

/** Head-only cobblestone mark — avatars, inline chips, the AI-face. The crop is square
 *  and tight to the head, so it still reads at ~20px. */
export function CobbHead({
  size = 22,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox={COBB_HEAD_VIEWBOX}
      width={size}
      height={size}
      role="img"
      aria-label={title ?? "Cobb"}
      className={className}
    >
      {COBB_HEAD_ART}
    </svg>
  );
}
