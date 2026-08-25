// Pure, side-effect-free secret-strength predicate, shared by two callers:
//   • env.ts, which refuses to boot in production on a dev/placeholder secret;
//   • scripts/lint-selfhost-secrets.ts, which refuses to SHIP a self-host
//     .env template carrying a value that guard would reject.
//
// Keeping the rule in one place is the point: the guard and the templates
// cannot drift into disagreement (the exact defect behind
// docs/history/2026-08-25-prerelease-audit.md B1 — the code claimed a
// dev-sentinel check that never existed, and the shipped .env.example carried
// `dev-only-...` values that passed the length check).
//
// This module must stay import-side-effect-free so the lint can load it
// without env.ts's boot-time loadEnv() firing.

/** A secret starting with one of these is a template placeholder, never a real
 *  generated value. */
export const DEV_SECRET_PREFIXES = ["dev-only"];

/** Database passwords the templates and dev compose ship as defaults. */
export const WEAK_DB_PASSWORDS = new Set(["change-me", "cobblr", "postgres"]);

/** Extract the password from a `postgres://user:PASSWORD@host` URL, decoded so
 *  an encoded weak value is still caught. Returns null when there is no
 *  password component to judge. */
export function passwordFromPgUrl(url: string): string | null {
  const m = /^[a-z]+:\/\/[^:/@]+:([^@]*)@/i.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

export interface SecretEnv {
  JWT_SECRET: string;
  TENANT_CREDS_ENCRYPTION_KEY: string;
  DATABASE_URL: string;
  SUPERUSER_DATABASE_URL: string;
}

/** Every reason the given secrets are unfit for production, as human-readable
 *  lines. Empty array = fit. Does NOT decide whether the caller is in
 *  production — env.ts gates on NODE_ENV, the lint gates on "is a shipped
 *  self-host template" (which is production by construction). */
export function weakSecretReasons(env: SecretEnv): string[] {
  const errs: string[] = [];
  for (const key of ["JWT_SECRET", "TENANT_CREDS_ENCRYPTION_KEY"] as const) {
    const v = env[key];
    if (DEV_SECRET_PREFIXES.some((p) => v.startsWith(p))) {
      errs.push(
        `${key}: is a dev placeholder — generate a real secret (openssl rand -hex 32)`,
      );
    }
  }
  for (const key of ["DATABASE_URL", "SUPERUSER_DATABASE_URL"] as const) {
    const pw = passwordFromPgUrl(env[key]);
    if (pw !== null && WEAK_DB_PASSWORDS.has(pw)) {
      errs.push(
        `${key}: uses a placeholder database password ("${pw}") — set a real POSTGRES_PASSWORD`,
      );
    }
  }
  return errs;
}
