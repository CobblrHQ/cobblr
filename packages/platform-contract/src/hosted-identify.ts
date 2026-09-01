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
export const HOSTED_IDENTIFY_URL_VAR = "COBBLR_IDENTIFY_URL";

export function hostedIdentifyEnabled(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): boolean {
  return Boolean(env[HOSTED_IDENTIFY_URL_VAR]?.trim());
}
