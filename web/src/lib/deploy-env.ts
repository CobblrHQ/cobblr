// Which deploy environment is this instance? Staging and prod run the
// SAME web image, so the env can't be baked in at build time — it comes
// from the API's public /healthz (`deploy_env`, driven by COBBLR_ENV per
// stack). Testers (and us) need an unmistakable visual cue so nobody
// confuses staging with prod. Prod's cue is the ABSENCE of a badge.

import { useQuery } from "@tanstack/react-query";

export interface EnvBadge {
  label: string;
  /** Header bg + border classes — replace the neutral header chrome. */
  header: string;
  /** The chip (solid, high-contrast). */
  chip: string;
}

// Only non-prod environments get a badge. Anything not listed here
// (production, or an unknown value) renders no badge at all.
export const ENV_BADGES: Record<string, EnvBadge> = {
  staging: {
    label: "Staging",
    header:
      "bg-violet-100 border-violet-300 dark:bg-violet-900/85 dark:border-violet-700",
    chip: "bg-violet-600 text-white",
  },
  // Canary runs main against REAL production data, so its cue says "newer code",
  // not "fake data" — hence the stock mark plus a dot rather than staging's full
  // recolour. `yellow`, not `amber`: amber is already the dev/test look below,
  // and a hosted canary must not read as somebody's localhost.
  canary: {
    label: "Canary",
    header:
      "bg-yellow-100 border-yellow-300 dark:bg-yellow-900/85 dark:border-yellow-700",
    chip: "bg-yellow-400 text-yellow-950",
  },
  development: {
    label: "Dev",
    header:
      "bg-amber-100 border-amber-300 dark:bg-amber-900/85 dark:border-amber-700",
    chip: "bg-amber-500 text-amber-950",
  },
  // `test` reuses the dev look — same "not real" signal.
  test: {
    label: "Test",
    header:
      "bg-amber-100 border-amber-300 dark:bg-amber-900/85 dark:border-amber-700",
    chip: "bg-amber-500 text-amber-950",
  },
};

/** Default header chrome when there's no env badge (production / unknown). */
export const DEFAULT_HEADER =
  "border-line dark:border-slate-700 bg-surface dark:bg-slate-900/80";

/**
 * Reads the instance's deploy env from /healthz once (cached forever).
 * Unauthenticated, so it works on the login screen too. Falls back to
 * production (no badge) on any error — fail safe, never cry-wolf a badge.
 */
export function useDeployEnv(): { env: string; badge: EnvBadge | null } {
  const q = useQuery({
    queryKey: ["deploy-env"],
    queryFn: async (): Promise<string> => {
      try {
        const res = await fetch("/api/v1/healthz");
        if (!res.ok) return "production";
        const j = (await res.json()) as { deploy_env?: string };
        return j.deploy_env || "production";
      } catch {
        return "production";
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const env = q.data ?? "production";
  return { env, badge: ENV_BADGES[env] ?? null };
}
