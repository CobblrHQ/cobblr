// How a collection presents its native fields (relabels and hides), read once
// for every surface, and the gate an item's fields wait behind.
//
// There were three copies of this hook: the web app's, inventory's and
// projects'. Two turned a failed read into "nothing configured" and cached it
// for a minute, so an item opened while the read failed drew the generic
// part (Min qty, Cost, Category, Manufacturer, Supplier URL) where its
// collection says Paid and Make / brand, and the same item looked different
// depending on the way in (#3645). A failure is now a failure: the hook says
// `failed`, the gate shows a sentence and Retry, and nothing generic is drawn
// in the collection's place. capabilities.ts holds this as the one owner.
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";

export interface FieldPresentation {
  /** The collection's label for a native field, or the fallback. */
  label: (name: string, fallback: string) => string;
  /** Whether the collection hides this native field. */
  hidden: (name: string) => boolean;
  /** Whether the collection says anything about this field (a bundle opting
   *  an optional section in by listing it). */
  configured: (name: string) => boolean;
  /** The presentation is known; drawing fields now draws the collection's. */
  ready: boolean;
  isLoading: boolean;
  /** The read failed; nothing is known, which is not the same as nothing set. */
  failed: boolean;
  retry: () => void;
}

export function useFieldPresentation(kind: string): FieldPresentation {
  const { api, orgSlug } = usePlatformWeb();
  const q = useQuery({
    queryKey: ["native-field-overrides", orgSlug, kind],
    queryFn: async () => {
      if (!api.listNativeFieldOverrides) throw new Error("This page cannot read how the collection shows its fields.");
      return api.listNativeFieldOverrides(orgSlug, kind);
    },
    enabled: !!orgSlug && !!kind,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const byName = new Map((q.data?.items ?? []).map((o) => [o.name, o]));
    return {
      label: (name, fallback) => byName.get(name)?.display_label || fallback,
      hidden: (name) => byName.get(name)?.hidden ?? false,
      configured: (name) => byName.has(name),
      ready: q.isSuccess,
      isLoading: q.isLoading,
      failed: q.isError,
      retry: () => void q.refetch(),
    };
  }, [q.data, q.isSuccess, q.isLoading, q.isError]);
}

/** An item's fields, drawn only once what governs them is known. Waiting is a
 *  quiet line; a failed read is a sentence and Retry, never the generic
 *  fields in the collection's place. */
export function PresentationGate({
  ready,
  failed,
  retry,
  children,
}: {
  ready: boolean;
  failed: boolean;
  retry: () => void;
  children: ReactNode;
}) {
  if (failed) {
    return (
      <div className="rounded-md border border-line dark:border-slate-700 p-3 text-sm text-muted dark:text-slate-400" data-testid="presentation-failed">
        Couldn't read how this collection shows its fields.{" "}
        <button type="button" onClick={retry} className="text-accent hover:underline">
          Try again
        </button>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="p-3 text-sm text-muted dark:text-slate-400" data-testid="presentation-loading">
        Loading…
      </div>
    );
  }
  return <>{children}</>;
}
