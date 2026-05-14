// Cobb the Cobbler — Cobblr's assistant mascot, the friendly face of the AI /
// "just describe it" surfaces. A little craftsman whose head is a cobblestone
// (the logo stone). Lore: the Elves and the Shoemaker — describe what you need,
// Cobb cobbles it together and leaves a finished, VERIFIED thing on the bench.
// He OFFERS, never nags; optional + dismissible everywhere.
//
// The art is the designer's, used VERBATIM — do NOT redraw or "refine" it here.
// It is GENERATED into CobbArt.tsx from web/src/components/cobb-art/*.svg by
// scripts/build-cobb-art.mjs; to change the art, replace those SVGs and re-run
// the script. Four full-body poses map to assistant STATES, plus a head-only
// mark for avatars / chips:
//   idle    → default / greeting (waving)
//   idea    → the SUGGEST moment (finger up + an ember spark)
//   working → the LOADING / building state (shaping a stone on his stump)
//   tada    → the DONE moment ("built it, verified it" — arms up)
import type { CSSProperties } from "react";
import { COBB_ART, COBB_BUST_VIEWBOX, COBB_VIEWBOX } from "./CobbArt";

export type CobbPose = "idle" | "idea" | "tada" | "working";

/** Every pose, in the order a real build walks them: greet, suggest, build,
 *  present. The dev pose-cycler in the chat panel steps through this. */
export const COBB_POSES: CobbPose[] = ["idle", "idea", "working", "tada"];

const POSE_ART: Record<CobbPose, keyof typeof COBB_VIEWBOX> = {
  idle: "Wave",
  idea: "Idea",
  tada: "Tada",
  working: "Working",
};

/** Pixel width for a given rendered height, from the crop's aspect ratio — so
 *  callers keep sizing Cobb by height and never have to know the art's shape. */
function widthFor(viewBox: string, height: number): number {
  const [, , w, h] = viewBox.split(" ").map(Number);
  return Math.round(height * ((w ?? 1) / (h ?? 1)));
}

/** Full-body Cobb in one of four poses. `size` is the rendered height in px. */
export function Cobb({
  pose = "idle",
  size = 88,
  className,
  style,
  title,
}: {
  pose?: CobbPose;
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const art = POSE_ART[pose];
  const viewBox = COBB_VIEWBOX[art];
  return (
    <svg
      viewBox={viewBox}
      width={widthFor(viewBox, size)}
      height={size}
      role="img"
      aria-label={title ?? "Cobb"}
      className={className}
      style={style}
    >
      {COBB_ART[art]}
    </svg>
  );
}

/** Head + shoulders + the raised hand, for cramped chrome (the chat header, at
 *  42px) where a full body renders the face too small to read. Deliberately not
 *  a bare floating head — the apron top and arm keep it reading as the little
 *  guy.
 *
 *  Takes no `pose` ON PURPOSE. The crop is cut to the WAVE silhouette; the other
 *  poses put their business outside that window (working's stump and chips sit
 *  off to the right, tada's arms go wide) and come out cut off. Making it a
 *  parameter is how a caller ends up with a beheaded Cobb, so there isn't one.
 *  Want another pose somewhere tight? Render <Cobb> full-body smaller, or use
 *  <CobbHead>. */
export function CobbBust({
  size = 42,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox={COBB_BUST_VIEWBOX}
      width={widthFor(COBB_BUST_VIEWBOX, size)}
      height={size}
      role="img"
      aria-label={title ?? "Cobb"}
      className={className}
    >
      {COBB_ART.Wave}
    </svg>
  );
}

/** Head-only cobblestone mark — avatars, inline chips, the AI-face. `sleeping`
 *  greys him out (Cobb's off the clock → AI not connected). The crop is square
 *  and tight to the head, so it still reads at ~20px. */
export function CobbHead({
  size = 22,
  sleeping = false,
  className,
  title,
}: {
  size?: number;
  sleeping?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox={COBB_VIEWBOX.Head}
      width={size}
      height={size}
      role="img"
      aria-label={title ?? (sleeping ? "Cobb (resting)" : "Cobb")}
      className={className}
      style={sleeping ? { opacity: 0.55, filter: "grayscale(0.5)" } : undefined}
    >
      {COBB_ART.Head}
    </svg>
  );
}
