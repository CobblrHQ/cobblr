// Sign-ups by the door that sent them.
//
// A sign-up link or a booth's QR carries `?source=` (3dp2026), and every new
// account's first workspace gets a `signed_up { via, source }` event
// (signup-source.ts). That answered "did the show bring anyone" in the database
// and nowhere else: no operator surface read it, so the one question the source
// exists for could only be asked with a psql. This is that read, in one place,
// for both doors that show it: the admin console / ops token
// (GET /super-admin/signups) and the on-box operator CLI (view-as.sh --signups).
//
// A sandbox carried into an account (try -> app, `sandbox_carried_in`) is its
// own source, "carry": the account was made to keep a sandbox, and counting it
// under whatever link the sign-up page happened to carry would hide the one
// path the sandbox exists to feed. The sandbox's own origin (the booth's QR
// that opened it) rides along on the account row as `carried_origin`.
import { meta } from "../db/meta.js";

/** The bucket an account is counted under. */
export const CARRY = "carry";
/** An account that arrived with no source at all. */
export const NO_SOURCE = "(none)";

export interface SignupFact {
  orgId: string;
  userId: string | null;
  at: Date;
  via: string | null;
  source: string | null;
  /** The sandbox it was made to keep, when one was carried in. */
  carried: { origin: string | null; from: string | null } | null;
}

export function sourceOf(f: Pick<SignupFact, "source" | "carried">): string {
  if (f.carried) return CARRY;
  return f.source?.trim() ? f.source.trim().toLowerCase() : NO_SOURCE;
}

export interface SignupReport {
  since: string;
  days: number;
  /** Per source, most first. */
  totals: Array<{ source: string; count: number }>;
  /** Per UTC day and source, newest day first. */
  by_day: Array<{ day: string; source: string; count: number }>;
  /** One row per account, newest first. Only for a caller allowed to see who. */
  accounts?: Array<{
    at: string;
    email: string | null;
    workspace: string | null;
    via: string | null;
    source: string;
    carried_origin: string | null;
  }>;
}

/** Fold the facts into the report. Pure, so the counting is testable alone. */
export function summarize(facts: SignupFact[], since: Date, days: number): Omit<SignupReport, "accounts"> {
  const totals = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const f of facts) {
    const s = sourceOf(f);
    totals.set(s, (totals.get(s) ?? 0) + 1);
    const key = `${f.at.toISOString().slice(0, 10)}\u0000${s}`;
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  return {
    since: since.toISOString(),
    days,
    totals: [...totals].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    by_day: [...byDay]
      .map(([k, count]) => {
        const [day, source] = k.split("\u0000") as [string, string];
        return { day, source, count };
      })
      .sort((a, b) => b.day.localeCompare(a.day) || b.count - a.count || a.source.localeCompare(b.source)),
  };
}

/** Sign-ups in the last `days` (product events are kept 180), per source. With
 *  `accounts`, one row per account as well: who, which workspace, from where. */
export async function signupsBySource(opts: { days: number; accounts: boolean }): Promise<SignupReport> {
  const days = Math.max(1, Math.min(180, Math.floor(opts.days)));
  const since = new Date(Date.now() - days * 86_400_000);
  const signed = await meta
    .selectFrom("product_events")
    .select(["org_id", "user_id", "created_at", "detail"])
    .where("event", "=", "signed_up")
    .where("created_at", ">=", since)
    .execute();
  const orgIds = [...new Set(signed.map((r) => r.org_id))];
  const carried = orgIds.length
    ? await meta
        .selectFrom("product_events")
        .select(["org_id", "detail"])
        .where("event", "=", "sandbox_carried_in")
        .where("org_id", "in", orgIds)
        .execute()
    : [];
  const carriedByOrg = new Map(carried.map((c) => [c.org_id, c.detail as { source?: string | null; from?: string | null } | null]));
  const facts: SignupFact[] = signed.map((r) => {
    const d = (r.detail ?? {}) as { via?: string | null; source?: string | null };
    const c = carriedByOrg.has(r.org_id) ? carriedByOrg.get(r.org_id) ?? {} : null;
    return {
      orgId: r.org_id,
      userId: r.user_id,
      at: new Date(r.created_at as unknown as string),
      via: d.via ?? null,
      source: d.source ?? null,
      carried: c ? { origin: c.source ?? null, from: c.from ?? null } : null,
    };
  });
  const report: SignupReport = summarize(facts, since, days);
  if (!opts.accounts) return report;

  const userIds = [...new Set(facts.map((f) => f.userId).filter((u): u is string => !!u))];
  const users = userIds.length ? await meta.selectFrom("users").select(["id", "email"]).where("id", "in", userIds).execute() : [];
  const orgs = orgIds.length ? await meta.selectFrom("orgs").select(["id", "slug"]).where("id", "in", orgIds).execute() : [];
  const email = new Map(users.map((u) => [u.id, u.email]));
  const slug = new Map(orgs.map((o) => [o.id, o.slug]));
  report.accounts = facts
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map((f) => ({
      at: f.at.toISOString(),
      email: f.userId ? email.get(f.userId) ?? null : null,
      workspace: slug.get(f.orgId) ?? null,
      via: f.via,
      source: sourceOf(f),
      carried_origin: f.carried?.origin ?? null,
    }));
  return report;
}
