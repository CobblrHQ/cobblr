// A small picture of the frame each desktop layout gives: where the bar is,
// where the column is, where the page goes. Drawn in currentColor so it reads
// in both themes and takes the selected colour with its label. Appearance and
// the tour's welcome step both draw the three from this, so a person sees the
// same picture wherever the choice is offered.

import type { NavLayout } from "../lib/nav-mode";

export function LayoutPreview({ layout, className = "" }: { layout: NavLayout; className?: string }) {
  const bar = layout !== "side-only";
  const column = layout !== "top";
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden className={"shrink-0 " + className}>
      <rect x="0.5" y="0.5" width="63" height="39" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.45" />
      {bar && <rect x="1" y="1" width="62" height="7" fill="currentColor" fillOpacity="0.35" />}
      {column && <rect x="1" y={bar ? 8 : 1} width="16" height={bar ? 31 : 38} fill="currentColor" fillOpacity="0.2" />}
      {column
        ? [0, 1, 2, 3].map((i) => (
            <rect key={i} x="4" y={(bar ? 12 : 5) + i * 6} width="10" height="2" rx="1" fill="currentColor" fillOpacity="0.7" />
          ))
        : [0, 1, 2, 3].map((i) => (
            <rect key={i} x={4 + i * 12} y="3.5" width="8" height="2" rx="1" fill="currentColor" fillOpacity="0.8" />
          ))}
      <rect x={column ? 22 : 6} y={bar ? 13 : 8} width={column ? 36 : 52} height="5" rx="1" fill="currentColor" fillOpacity="0.15" />
      <rect x={column ? 22 : 6} y={bar ? 21 : 16} width={column ? 28 : 40} height="3" rx="1" fill="currentColor" fillOpacity="0.1" />
    </svg>
  );
}
