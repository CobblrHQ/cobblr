// A new thing at a Station (#4640): the record card's scale, not the scan
// inbox's whole triage surface. The photo, the name as read, how many and one
// big Add; "Not this?" opens the one input that fixes the name, and More opens
// the full card for everything else. InboxCard renders this with its own
// state, so Add here is the same Add the inbox's row runs.
import type { ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { EntityPhoto } from "@cobblr/platform-web";

/** A station's photo: the whole product on a light tile, as a catalog shows
 *  it. Cover cropped a bottle's top and sides at arm's length. */
export function StationPhoto({ src, alt }: { src: string | null; alt: string }) {
  const photo = <EntityPhoto src={src} alt={alt} aspect="square" eager fit="contain" className={src ? "!bg-transparent" : "rounded-2xl"} data-testid="station-photo" />;
  return src ? (
    <div className="rounded-2xl bg-white p-2 ring-1 ring-black/5 dark:bg-white dark:ring-white/10" data-tile="light">
      {photo}
    </div>
  ) : (
    photo
  );
}

export interface StationNewFaceProps {
  photo: string | null;
  name: string;
  /** Said under the name while the identify is still working. */
  working: string | null;
  quantity: { value: number; busy: boolean; onChange: (n: number) => void } | null;
  /** Null when this capture cannot be filed from here (More can). */
  commit: { label: string; destination: string; busy: boolean; onAdd: () => void } | null;
  /** Why it cannot be filed in one tap, when it cannot. */
  reason: string | null;
  fixing: boolean;
  onFix: () => void;
  fixName: ReactNode;
  onMore: () => void;
}

export function StationNewFace(p: StationNewFaceProps) {
  return (
    <div className="w-full" data-testid="station-new-face">
      <div className="flex gap-5 max-sm:flex-col">
        <div className="w-40 shrink-0 max-sm:w-28">
          <StationPhoto src={p.photo} alt={p.name} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="text-3xl font-semibold leading-tight max-sm:text-2xl">{p.name || "Looking it up…"}</h1>
          <div className="text-lg text-muted">Not something you have yet</div>
          {p.working && <div className="text-base text-muted" role="status">{p.working}</div>}
        </div>
      </div>
      {p.fixing ? (
        <div className="mt-5 text-lg">{p.fixName}</div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-stretch gap-3">
            {p.quantity && (
              <div className="inline-flex min-h-[64px] items-center rounded-2xl border border-line bg-surface dark:border-slate-600 dark:bg-slate-800" data-testid="station-new-qty">
                <button
                  type="button"
                  aria-label="One fewer"
                  disabled={p.quantity.busy || p.quantity.value <= 1}
                  onClick={() => p.quantity && p.quantity.onChange(p.quantity.value - 1)}
                  className="h-full px-4 text-content disabled:opacity-40"
                >
                  <Minus size={24} />
                </button>
                <span className="min-w-[3ch] text-center text-2xl font-semibold" aria-live="polite">×{p.quantity.value}</span>
                <button
                  type="button"
                  aria-label="One more"
                  disabled={p.quantity.busy}
                  onClick={() => p.quantity && p.quantity.onChange(p.quantity.value + 1)}
                  className="h-full px-4 text-content disabled:opacity-40"
                >
                  <Plus size={24} />
                </button>
              </div>
            )}
            {p.commit && (
              <button
                type="button"
                onClick={p.commit.onAdd}
                disabled={p.commit.busy}
                className="inline-flex min-h-[64px] flex-1 items-center justify-center gap-2 rounded-2xl bg-cobble-600 px-5 text-xl font-semibold text-white transition hover:bg-cobble-700 disabled:opacity-40"
              >
                <Plus size={26} /> {p.commit.label}
                <span className="truncate text-base font-normal opacity-80">· {p.commit.destination}</span>
              </button>
            )}
          </div>
          {!p.commit && p.reason && <p className="mt-3 text-lg text-muted">{p.reason}</p>}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={p.onFix} className="px-1 py-2 text-lg text-content underline underline-offset-4">
              Not this? Fix the name
            </button>
            <button
              type="button"
              onClick={p.onMore}
              className="inline-flex min-h-[48px] items-center rounded-xl border border-line px-4 text-lg text-content hover:border-cobble-400 dark:border-slate-600"
            >
              More
            </button>
          </div>
        </>
      )}
    </div>
  );
}
