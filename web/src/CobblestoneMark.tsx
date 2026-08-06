// Brand mark — 4 irregular polygons fitting together like cobblestones
// on a path. See docs/product/BRAND.md §5: "different sizes, slight
// imperfection, visible gaps." This is the v0 sketch; an actual
// designer's mark would replace it.

/**
 * `dot` tints a disc in the middle of the mark — the CANARY cue. It is the whole
 * environment signal for that channel: canary runs real production data and is
 * meant to look like production, so it gets no header tint and no chip, only
 * this. Keep it in step with web/public/favicon-canary.svg (same #FACC15, same
 * r=19 at this viewBox), or the tab and the nav disagree about where you are.
 */
export function CobblestoneMark({ size = 64, dot }: { size?: number; dot?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={dot ? "cobblr logo (canary)" : "cobblr logo"}
    >
      {/* top-left — slate */}
      <polygon
        points="8,12 38,8 44,38 30,46 10,40"
        fill="#3D4451"
      />
      {/* top-right — cobble */}
      <polygon
        points="52,10 88,16 92,40 70,46 50,32"
        fill="#8B7355"
      />
      {/* bottom-left — moss */}
      <polygon
        points="10,52 32,50 36,82 18,90 6,76"
        fill="#6B8E4E"
      />
      {/* bottom-right — cobble-light */}
      <polygon
        points="46,56 78,52 92,72 84,90 54,86"
        fill="#A48663"
      />
      {dot && <circle cx="49" cy="49" r="19" fill={dot} />}
    </svg>
  );
}
