// Faces, on the client: which ones a collection wears, and the row that
// offers the dormant ones.
//
// A record shows the base plus the faces that are on. Everything else folds
// into ONE row, "More about this item", listing the dormant faces as chips. A
// tap opens that section and turns the face on for the collection - the
// one-tap sticky override one-record-substrate.md requires, in the place a
// person would look for it. Nothing is deleted or filled in either way; a face
// only decides what is on screen.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FACE_LABELS, FACE_NAMES, type FaceName } from "@cobblr/platform-contract/field-vocabulary";
import { usePlatformWeb } from "./context";
import { MutationError } from "./MutationError";
import { useRunAction } from "./run-action";

export interface FacesVerdict {
  kind: string;
  /** The trait VALUES the collection wears, one per axis (real and trial). */
  traits: Record<string, string>;
  faces: FaceName[];
  explicit: FaceName[];
  /** The faces a person may turn on here; absent from an older api, which
   *  offered every face not worn. */
  offers?: FaceName[];
}

/** The faces a kind wears in this workspace. Bias: until the answer arrives,
 *  every face is on, so a real inventory item never flashes lean and nothing
 *  a person is about to press disappears under them. A FAILED read is not
 *  that: it wears no optional face, since "every face" is what put Use one
 *  and Used up on a lamp (#3646); an item's detail waits for `ready` behind
 *  PresentationGate and offers Retry on `failed`. */
export function useFaces(kind: string): {
  on: ReadonlySet<FaceName>;
  worn: ReadonlySet<string>;
  isLoading: boolean;
  verdict: FacesVerdict | null;
  ready: boolean;
  failed: boolean;
  retry: () => void;
} {
  const { api, orgSlug } = usePlatformWeb();
  const q = useQuery({
    queryKey: ["faces", orgSlug, kind],
    queryFn: () => api.listFaces!(orgSlug, kind),
    enabled: !!api.listFaces,
    staleTime: 30_000,
  });
  return useMemo(() => {
    // The wire carries strings; keep only names this build knows, so a newer
    // server's face never widens the set on an older client.
    const known = (xs: string[]): FaceName[] => xs.filter((x): x is FaceName => (FACE_NAMES as readonly string[]).includes(x));
    const verdict: FacesVerdict | null = q.data
      ? { kind: q.data.kind, traits: q.data.traits ?? {}, faces: known(q.data.faces), explicit: known(q.data.explicit), ...(Array.isArray(q.data.offers) ? { offers: known(q.data.offers) } : {}) }
      : null;
    return {
      on: new Set<FaceName>(verdict ? verdict.faces : q.isError ? [] : FACE_NAMES),
      // Unknown until the answer arrives: treat every trait as worn, so
      // nothing a person is about to press disappears under them.
      worn: new Set<string>(verdict ? Object.values(verdict.traits) : q.isError ? [] : ["*"]),
      isLoading: q.isLoading,
      verdict,
      // A host without the faces read shows every face, as it always has.
      ready: !api.listFaces || q.isSuccess,
      failed: q.isError,
      retry: () => void q.refetch(),
    };
  }, [q.data, q.isLoading, q.isError, q.isSuccess, api.listFaces]);
}

/** Faces a person opened on THIS screen before the collection's verdict
 *  caught up, so the section appears the moment they tap. */
const Opened = createContext<{ opened: ReadonlySet<FaceName>; open: (f: FaceName) => void } | null>(null);

/** Wrap a record's detail body. Sections ask `useFaceOn(face)`; the row at
 *  the bottom offers whatever is dormant. */
export function RecordFaces({ kind, children }: { kind: string; children: ReactNode }) {
  const { orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const { on, verdict } = useFaces(kind);
  const [opened, setOpened] = useState<Set<FaceName>>(new Set());
  // The assistant's door too (platform:set-faces), so "+ Lending" is
  // something Cobb and the MCP server can do, and it offers its Undo.
  // PRESS-ARGS: the chip is the face it turns on and the kind is this record's; nothing is left to ask.
  const runAction = useRunAction();
  const turnOn = useMutation({
    mutationFn: async (face: FaceName) => {
      const run = await runAction({ actionId: "platform:set-faces", args: { entity_kind: kind, on: [face] } });
      const res = run.result as { ok?: boolean; error?: string } | null;
      if (!res?.ok) throw new Error(res?.error ?? "That did not go through.");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["faces", orgSlug, kind] }),
  });
  const ctx = useMemo(
    () => ({
      opened,
      open: (f: FaceName) => {
        setOpened((s) => new Set(s).add(f));
        turnOn.mutate(f);
      },
    }),
    [opened, turnOn],
  );
  const dormant = (verdict?.offers ?? FACE_NAMES).filter((f) => !on.has(f) && !opened.has(f));
  return (
    <Opened.Provider value={ctx}>
      {children}
      {dormant.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line dark:border-slate-700">
          <span className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">More about this item</span>
          {dormant.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => ctx.open(f)}
              title={`Turn on ${FACE_LABELS[f].toLowerCase()} for this collection`}
              className="rounded border border-dashed border-line dark:border-slate-600 px-2 py-0.5 text-[11px] text-muted dark:text-slate-400 hover:text-accent hover:border-accent transition"
            >
              + {FACE_LABELS[f]}
            </button>
          ))}
        </div>
      )}
      <MutationError mutation={turnOn} className="block pt-1">Shown here for now, but not kept on for this collection:</MutationError>
    </Opened.Provider>
  );
}

/** Is this face on, here and now? True when the collection wears it or the
 *  person just opened it on this screen. Outside RecordFaces: always true,
 *  so a page that has not adopted faces shows everything it always did.
 *
 *  That default is a trap in the component that RENDERS RecordFaces: a hook
 *  in its body runs outside the provider it is about to mount, reads "no
 *  faces here" and answers true for every face, so a field it gates never
 *  folds (Assets' warranty fields, 2026-09-17, caught by a rendered test).
 *  Inside that component, read faces with <FacesOn>, which asks from within. */
export function useFaceOn(face: FaceName | undefined, kind: string): boolean {
  const opened = useContext(Opened);
  const { on } = useFaces(kind);
  if (!face) return true;
  if (!opened) return true;
  return on.has(face) || opened.opened.has(face);
}

/** Does a field a face governs belong on this record? When the face is on,
 *  yes. When it is off, only while the field is empty or at its default: a
 *  face folds what a record does not use, and never hides a value the record
 *  holds. A machine imported as "5 of these" in a collection that does not
 *  wear the stock face showed no quantity at all, and nothing on the record
 *  could see or change it. lint:folded-faces-keep-values refuses a face gate
 *  that does not come through here. */
export function faceShows(on: boolean, value: unknown, fallback: unknown = null): boolean {
  if (on) return true;
  if (value === null || value === undefined || value === "") return false;
  if (typeof fallback === "number" || typeof value === "number") return Number(value) !== Number(fallback);
  return value !== fallback;
}

/** Wrap one section: rendered while its face is on, or while the record
 *  holds something the section shows (`holds`), so a folded face never
 *  hides what is there. */
export function FaceSection({ face, kind, holds = false, children }: { face: FaceName; kind: string; holds?: boolean; children: ReactNode }) {
  return useFaceOn(face, kind) || holds ? <>{children}</> : null;
}

/** Read several faces from INSIDE the record's faces and hand the answers to
 *  what renders them: for a list of pack items where a face decides whether
 *  a field is present at all (no cell), which a wrapper around the item
 *  cannot express. Rendered under RecordFaces; the component that mounts
 *  RecordFaces cannot call useFaceOn itself (see it). */
export function FacesOn<F extends FaceName>({ kind, faces, children }: { kind: string; faces: readonly F[]; children: (on: Record<F, boolean>) => ReactNode }) {
  const opened = useContext(Opened);
  const { on } = useFaces(kind);
  const answer = {} as Record<F, boolean>;
  for (const f of faces) answer[f] = !opened ? true : on.has(f) || opened.opened.has(f);
  return <>{children(answer)}</>;
}
