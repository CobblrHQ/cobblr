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
import { FACE_LABELS, FACE_NAMES, type FaceName } from "@cobblr/platform-contract";
import { usePlatformWeb } from "./context";

export interface FacesVerdict {
  kind: string;
  /** The trait VALUES the collection wears, one per axis (real and trial). */
  traits: Record<string, string>;
  faces: FaceName[];
  explicit: FaceName[];
}

/** The faces a kind wears in this workspace. Bias: until the answer arrives,
 *  every face is on, so a real inventory item never flashes lean and nothing
 *  a person is about to press disappears under them. */
export function useFaces(kind: string): { on: ReadonlySet<FaceName>; worn: ReadonlySet<string>; isLoading: boolean; verdict: FacesVerdict | null } {
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
    const verdict: FacesVerdict | null = q.data ? { kind: q.data.kind, traits: q.data.traits ?? {}, faces: known(q.data.faces), explicit: known(q.data.explicit) } : null;
    return {
      on: new Set<FaceName>(verdict ? verdict.faces : FACE_NAMES),
      // Unknown until the answer arrives: treat every trait as worn, so
      // nothing a person is about to press disappears under them.
      worn: new Set<string>(verdict ? Object.values(verdict.traits) : ["*"]),
      isLoading: q.isLoading,
      verdict,
    };
  }, [q.data, q.isLoading]);
}

/** Faces a person opened on THIS screen before the collection's verdict
 *  caught up, so the section appears the moment they tap. */
const Opened = createContext<{ opened: ReadonlySet<FaceName>; open: (f: FaceName) => void } | null>(null);

/** Wrap a record's detail body. Sections ask `useFaceOn(face)`; the row at
 *  the bottom offers whatever is dormant. */
export function RecordFaces({
  kind,
  /** The override target the collection's config lives under: an instance's
   *  `<module>:<instance>`, or a base kind's own id. */
  target,
  children,
}: {
  kind: string;
  target: { target_kind: "instance" | "entity_kind"; target_id: string };
  children: ReactNode;
}) {
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const { on, verdict } = useFaces(kind);
  const [opened, setOpened] = useState<Set<FaceName>>(new Set());
  const turnOn = useMutation({
    mutationFn: (face: FaceName) =>
      api.upsertOverride!(orgSlug, { ...target, config: { faces: { ...(verdict ? Object.fromEntries(verdict.explicit.map((f) => [f, verdict.faces.includes(f)])) : {}), [face]: true } } }),
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
  const dormant = FACE_NAMES.filter((f) => !on.has(f) && !opened.has(f));
  return (
    <Opened.Provider value={ctx}>
      {children}
      {dormant.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line dark:border-slate-700">
          <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">More about this item</span>
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

/** Wrap one section: rendered only while its face is on. */
export function FaceSection({ face, kind, children }: { face: FaceName; kind: string; children: ReactNode }) {
  return useFaceOn(face, kind) ? <>{children}</> : null;
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
