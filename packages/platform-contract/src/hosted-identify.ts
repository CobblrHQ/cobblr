// Does this deployment have a hosted identification service wired?
//
// Two places need the same answer and would otherwise each read the env var
// themselves: core-scan, which CALLS the service, and the kernel's AI-status
// route, which decides whether to tell somebody "AI isn't connected". Those two
// answers disagreeing is exactly the bug it caused — a sandbox that identifies
// things from a photo perfectly well still told every visitor that scanning was
// running in basic mode, because the kernel only knew about chat providers.
//
// Server-side only: deliberately NOT re-exported from index.ts, because the web
// bundle imports that and has no `process`.
//
// The same holds for WHO it serves. The scope check lived beside the call in
// core-scan while the status route read only "is the service on", so a hosted
// deployment scoped to one app told every other workspace that its photos
// would be read, and the scan then declined (#3867). hostedIdentifyReach is
// the one answer both read.
import { platform } from "@cobblr/platform-contract/platform-runtime";

export const HOSTED_IDENTIFY_URL_VAR = "COBBLR_IDENTIFY_URL";

export function hostedIdentifyEnabled(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): boolean {
  return Boolean(env[HOSTED_IDENTIFY_URL_VAR]?.trim());
}

/** Which workspaces get hosted identification at all.
 *
 *  `COBBLR_IDENTIFY_APPS` unset or `*` = every workspace on this deployment
 *  (the try box: every sandbox). A comma list of managed-app ids (`yarn`, or
 *  `yarn,lego`) = only workspaces locked into one of those apps; a platform
 *  workspace on the same box gets nothing and degrades to its own AI path.
 *
 *  An entry may also name ONE workspace by slug, written `@slug`
 *  (`@e2e-scan-walk`, or `yarn,@e2e-scan-walk`). Managed apps are a closed
 *  registry, so an app id alone cannot admit a workspace that is not one of
 *  them - and "turn this on for that workspace and nothing else" is a real
 *  need: a deployment with one workspace doing the exercising, and a mirror of
 *  somebody's real scans sitting beside it that must not spend the key
 *  (2026-09-03). One knob still answers one question, and it still fails
 *  closed.
 *  That is what lets the hosted product hand a free daily allowance to the
 *  yarn app without handing it to everyone who signs up for anything.
 *
 *  Per USER, in practice: a managed-app workspace is one person, so the
 *  per-workspace counter below is a per-person counter for exactly the
 *  workspaces this scope admits. */
export function identifyAppsAllowed(): "*" | Set<string> {
  const raw = (process.env.COBBLR_IDENTIFY_APPS ?? "*").trim();
  if (!raw || raw === "*") return "*";
  // `@slug` entries are lowercased so the comparison above can be too.
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("@") ? s.toLowerCase() : s)),
  );
}

type OrgLookup = (orgId: string) => Promise<{ slug?: string; app_mode: { app: string } | null } | null>;
const platformOrgLookup: OrgLookup = (orgId) => platform().orgs.get(orgId);
let orgLookup: OrgLookup = platformOrgLookup;
/** Swap the workspace lookup (tests). `null` restores the platform one. */
export function setIdentifyOrgLookup(fn: OrgLookup | null): void {
  orgLookup = fn ?? platformOrgLookup;
}

/** Fails CLOSED. This is entitlement, not accounting: a workspace we cannot
 *  place must not spend the shared key. (The allowance counter below fails
 *  open, because there the edge's own cap still bounds the spend; here nothing
 *  would.) */
export async function workspaceInIdentifyScope(orgId: string): Promise<boolean> {
  const allowed = identifyAppsAllowed();
  if (allowed === "*") return true;
  try {
    const org = await orgLookup(orgId);
    const app = org?.app_mode?.app;
    if (app && allowed.has(app)) return true;
    // Named outright, by slug. Kept case-insensitive because a slug is a URL
    // word and an operator writing one into an env file is not typing it twice.
    const slug = org?.slug?.trim().toLowerCase();
    return !!slug && allowed.has(`@${slug}`);
  } catch (err) {
    console.error(`[hosted-identify] could not place workspace ${orgId} - refusing:`, (err as Error).message);
    return false;
  }
}

/** Can hosted identification serve this workspace, before any per-call
 *  question (the plan, today's allowance) is asked? The scan asks it before
 *  every call and /ai-status asks it before promising a photo read, so the
 *  two cannot disagree. `off`: no service configured here. `scope`: the
 *  service serves other workspaces, not this one. */
export async function hostedIdentifyReach(
  orgId: string,
): Promise<{ available: true } | { available: false; why: "off" | "scope" }> {
  if (!hostedIdentifyEnabled()) return { available: false, why: "off" };
  if (!(await workspaceInIdentifyScope(orgId))) return { available: false, why: "scope" };
  return { available: true };
}
