// The featured bundles' manifests, for code that the app shell runs on every
// page (the nav). The table is large (about 60 KB gzipped with the apps it
// embeds), so the shell reads it through this hook, which loads it once after
// the page has drawn, instead of importing it (#4945). Null until it arrives.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FeaturedBundle } from "./featured-bundles";

/** `when: "idle"` waits for the page to settle before fetching (the nav,
 *  which only needs the table for a background tidy); the default fetches at
 *  once, for a screen that shows it. One fetch either way: they share a key. */
export function useFeaturedBundles({ when = "now" }: { when?: "now" | "idle" } = {}): readonly FeaturedBundle[] | null {
  const [settled, setSettled] = useState(when === "now");
  useEffect(() => {
    if (settled) return;
    const t = window.setTimeout(() => setSettled(true), 4000);
    return () => clearTimeout(t);
  }, [settled]);
  const q = useQuery({
    queryKey: ["featured-bundles"],
    queryFn: () => import("./featured-bundles").then((m) => m.FEATURED_BUNDLES),
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: settled,
  });
  return q.data ?? null;
}

/** The current label a featured bundle declares for a next-step `path`, or
 *  undefined while the manifests load or when none does. Setup cards cache
 *  their label at install time; a renderer prefers this live one. */
export function useLiveNextStepLabel(): (path: string | undefined) => string | undefined {
  const featured = useFeaturedBundles();
  const byPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of featured ?? []) {
      for (const s of b.next_steps ?? []) if (s.path) m.set(s.path, s.label);
      for (const f of b.manifest.features ?? []) for (const s of f.next_steps ?? []) if (s.path) m.set(s.path, s.label);
    }
    return m;
  }, [featured]);
  return (path) => (path ? byPath.get(path) : undefined);
}
