// Brand mark — 4 irregular polygons fitting together like cobblestones
// on a path. See docs/BRAND.md §5: "different sizes, slight
// imperfection, visible gaps." This is the v0 sketch; an actual
// designer's mark would replace it.

export function CobblestoneMark({ size = 64 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="cobblr logo"
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
    </svg>
  );
}
