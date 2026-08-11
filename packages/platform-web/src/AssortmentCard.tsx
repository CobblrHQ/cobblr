// A record that stands for "roughly this many of these, jumbled together".
//
// The reason this is a card and not a row: a bin holding fifty things rendered
// as one thin list row READS AS AN EMPTY BIN. The visual weight was lying about
// the physical fact. So the rule here is that the precision of the rendering
// matches the precision of the knowledge:
//
//   dashed + large + photo-led  = estimated
//   solid rows                  = counted
//
// The border is the honesty signal and is the first thing read. See
// docs/design-decisions/assorted-contents.md.

import { useEffect, useState, type ReactNode } from "react";
import { useImageSrc } from "./useImageSrc";
import { scrimAlphaFor } from "./photo-scrim";

export interface AssortmentKind {
  id: string;
  name: string;
  approximate_qty?: number | null;
  qty?: number | null;
}

export interface AssortmentCardProps {
  title: string;
  /** The estimate. Its presence is what makes this an assortment at all. */
  approximateQty: number;
  /** Free-text description of the jumble, optional. */
  note?: string | null;
  /** Workspace file path or URL. The best description a bin of tangled cables
   *  has, so it is not a thumbnail. */
  imagePath?: string | null;
  /** Kinds live INSIDE the card, so the enclosure says "these are the fifty". */
  kinds?: AssortmentKind[];
  /** Rendered under the estimate: the actions this card offers. */
  actions?: ReactNode;
  /** Photo treatment. `behind` is the default; `beside` suits a narrow column. */
  layout?: "behind" | "beside";
  onKindClick?: (kind: AssortmentKind) => void;
}

const qtyText = (k: AssortmentKind) =>
  k.qty != null && k.approximate_qty == null ? `${k.qty}` : `~${k.approximate_qty ?? "?"}`;

export function AssortmentCard({
  title,
  approximateQty,
  note,
  imagePath,
  kinds = [],
  actions,
  layout = "behind",
  onKindClick,
}: AssortmentCardProps) {
  const src = useImageSrc(imagePath ?? null);
  const [scrim, setScrim] = useState(0.75);

  // The scrim cannot be a constant: a dark photo needs almost none, a bright one
  // needs a lot. Measure the image and solve for the alpha that lands the
  // composite where light text is readable. See photo-scrim.ts.
  useEffect(() => {
    let alive = true;
    if (!src) return;
    scrimAlphaFor(src).then((a) => alive && setScrim(a));
    return () => {
      alive = false;
    };
  }, [src]);

  const hasPhoto = Boolean(src);
  const behind = layout === "behind" && hasPhoto;

  // Over a photo the card is a DARK panel whatever the page theme is, the same
  // way the camera capture sheet is over a live viewfinder. Dark text on a
  // photograph is unsolved; light text on a scrimmed photo is not.
  const onPhoto = behind ? "text-mortar-100" : "text-content";

  return (
    <div
      className={[
        "relative overflow-hidden rounded-2xl border-2 border-dashed border-cobble-400/70",
        behind ? "min-h-[19rem]" : "bg-subtle dark:bg-slate-800",
        layout === "beside" && hasPhoto ? "grid grid-cols-[minmax(0,14rem)_1fr]" : "",
      ].join(" ")}
      data-assortment="true"
    >
      {hasPhoto && (
        <>
          <div
            aria-hidden
            className={behind ? "absolute inset-0 bg-cover bg-center" : "bg-cover bg-center"}
            style={{ backgroundImage: `url(${JSON.stringify(src)})` }}
          />
          {behind && (
            <div
              aria-hidden
              className="absolute inset-0"
              style={{ background: `rgba(30,41,59,${scrim.toFixed(2)})` }}
            />
          )}
        </>
      )}

      <div className={behind ? "relative" : ""}>
        <div className="p-4 sm:p-5">
          <div className={`text-lg font-semibold ${onPhoto}`}>{title}</div>
          <div className={`text-3xl font-light ${behind ? "text-cobble-200" : "text-accent"}`}>
            ~{approximateQty}{" "}
            <span className={`text-[13px] font-normal ${behind ? "text-slate-200" : "text-muted"}`}>
              estimated, not counted
            </span>
          </div>
          {note && (
            <p className={`mt-1 max-w-[54ch] text-sm ${behind ? "text-slate-200" : "text-muted"}`}>
              {note}
            </p>
          )}
          {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
        </div>

        {kinds.length > 0 && (
          <div className="px-4 pb-4 sm:px-5 sm:pb-5">
            <div
              className={`mb-2 text-[11px] uppercase tracking-wider ${
                behind ? "text-slate-300" : "text-faint"
              }`}
            >
              {kinds.length} {kinds.length === 1 ? "kind" : "kinds"}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] gap-2">
              {kinds.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={onKindClick ? () => onKindClick(k) : undefined}
                  className={[
                    "rounded-xl border px-3 py-2 text-left transition",
                    // A counted kind has earned a solid border; an estimated one
                    // keeps the dashed one. Same honesty signal, one level down.
                    k.approximate_qty == null
                      ? "border-solid border-line"
                      : "border-dashed border-cobble-400/60",
                    behind
                      ? "border-mortar-100/25 bg-slate-700/30 backdrop-blur-md"
                      : "bg-surface dark:bg-slate-900",
                    onKindClick ? "hover:border-accent cursor-pointer" : "cursor-default",
                  ].join(" ")}
                >
                  <div className={`text-sm font-semibold ${onPhoto}`}>{k.name}</div>
                  <div className={behind ? "text-cobble-200" : "text-accent"}>
                    {qtyText(k)}{" "}
                    <span
                      className={`text-[11px] ${behind ? "text-slate-300" : "text-muted"}`}
                    >
                      {k.approximate_qty == null ? "counted" : "est."}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
