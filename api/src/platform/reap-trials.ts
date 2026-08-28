// Reap expired trial / demo workspaces — the HUMANE path.
//
// provisionOrgForUser stamps `orgs.trial_expires_at` on the trial tier (and, later, on
// pushed demo workspaces) — but nothing sweeps it, so abandoned trials pile up. This is
// the sweep. It is DESTRUCTIVE (drops the tenant DB via hardDeleteOrg), so it is gated
// hard AND never deletes without first warning the owner:
//
//   Lifecycle:  warn  ->  grace  ->  delete   (never a silent delete)
//     1. WARN  — a trial within COBBLR_TRIAL_REAP_WARN_DAYS (default 7) of expiry and
//                not yet warned gets one plain, friendly email: your trial ends on
//                <date>, export your data first (Configuration -> Backup & Export). We stamp
//                `trial_expiry_warned_at` so it is sent exactly once.
//     2. GRACE — the workspace lives on. It is only ever eligible for deletion once it is
//                past (trial_expires_at + grace) AND was warned at least (grace) days ago.
//     3. DELETE — hardDeleteOrg drops the tenant DB.
//
//   • COBBLR_TRIAL_REAP = off (default) | dry | live
//       off  — never runs.
//       dry  — logs exactly what WOULD be warned and what WOULD be deleted; sends and
//              deletes NOTHING (run this first).
//       live — sends warnings + (after grace) deletes.
//   • COBBLR_TRIAL_REAP_WARN_DAYS  (default 7) — how early to warn before expiry.
//   • COBBLR_TRIAL_REAP_GRACE_DAYS (default 3) — extra days past expiry AND minimum age
//                                                of the warning before a delete.
//   • ONLY orgs with `trial_expires_at IS NOT NULL` are ever candidates — prod /
//     staging / self-host leave it NULL everywhere, so they can't be touched even in
//     `live` (belt: the pure filters re-check null).
//   • If NO auth-email sender is configured, warnings are SKIPPED (logged, never a
//     crash) — and because nothing can be warned, nothing is deleted. We do not delete
//     what we could not warn.
//
// Slice 1 of the central-identity / demo-workspaces work (see
// _tmp/central-identity-and-demo-workspaces.md); the demo feature reuses this same
// stamp + sweep.

// meta + hardDeleteOrg + the auth-email seam are imported LAZILY inside the real code
// paths — importing ../db/meta.js validates env and process.exit(1)s when it's absent,
// which would take down any unit test (or test:unit) that merely imports this module. The
// pure helpers + the injected-deps orchestration stay import-clean.

import type { AuthEmailMessage } from "@cobblr/platform-contract";
import { runExclusive } from "./exclusive.js";

export type ReapMode = "off" | "dry" | "live";

/** off | dry | live from COBBLR_TRIAL_REAP (default off; unknown → off). Pure. */
export function reapMode(env: NodeJS.ProcessEnv = process.env): ReapMode {
  const v = String(env.COBBLR_TRIAL_REAP ?? "off").trim().toLowerCase();
  return v === "live" ? "live" : v === "dry" ? "dry" : "off";
}

/** Days of grace from env, fail-safe: a non-numeric value falls back to 3 (never NaN, which
 *  would make the reap cutoff NaN and silently reap nothing). Pure. */
export function reapGraceDays(env: NodeJS.ProcessEnv = process.env): number {
  const g = Number(env.COBBLR_TRIAL_REAP_GRACE_DAYS);
  return Number.isFinite(g) && g >= 0 ? g : 3;
}

/** How many days before expiry to send the warning, fail-safe: a non-numeric value falls
 *  back to 7 (never NaN, which would make the warn horizon NaN and warn nothing). Pure. */
export function reapWarnDays(env: NodeJS.ProcessEnv = process.env): number {
  const w = Number(env.COBBLR_TRIAL_REAP_WARN_DAYS);
  return Number.isFinite(w) && w >= 0 ? w : 7;
}

/** Sweep interval from env, fail-safe: a non-numeric or sub-60s value falls back to 6h.
 *  CRITICAL — a NaN here would make setInterval fire at ~0ms and hot-loop the DESTRUCTIVE
 *  sweep against cobblr_meta. Pure. */
export function reapIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const i = Number(env.COBBLR_TRIAL_REAP_INTERVAL_MS);
  return Number.isFinite(i) && i >= 60_000 ? i : 6 * 3_600_000;
}

/** Max workspaces one LIVE sweep may reap. A blast-radius cap: if a bug/clock-skew/bad
 *  migration back-dates many stamps at once, refuse the whole sweep and force a human `dry`
 *  review rather than irreversibly dropping N tenant DBs. Fail-safe to 25; 0 disables the
 *  cap (unbounded — opt-in). Pure. */
export function reapMaxPerSweep(env: NodeJS.ProcessEnv = process.env): number {
  const m = Number(env.COBBLR_TRIAL_REAP_MAX_PER_SWEEP);
  return Number.isFinite(m) && m >= 0 ? m : 25;
}

export interface TrialOrg {
  id: string;
  slug: string;
  trial_expires_at: Date | string | null;
  /** When the warning email was sent (NULL = never). Gates deletion. */
  trial_expiry_warned_at: Date | string | null;
  /** The workspace owner's email — where the warning is sent. NULL = no
   *  resolvable owner (then it can't be warned, so it can't be reaped). */
  owner_email: string | null;
}

/** A human-friendly, unambiguous date (YYYY-MM-DD, UTC) for the email + logs. Pure. */
function isoDate(d: Date | string | null): string {
  if (d == null) return "an upcoming date";
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "an upcoming date";
}

/** The trials that should get a warning now: a live trial stamp, not yet warned, whose
 *  expiry is within `warnDays` (or already past — an expired-but-unwarned trial must be
 *  warned before it can ever be reaped). Pure. */
export function warnableOrgs(orgs: TrialOrg[], warnDays: number, nowMs: number): TrialOrg[] {
  const horizon = nowMs + Math.max(warnDays, 0) * 86_400_000;
  return orgs.filter((o) => {
    if (o.trial_expires_at == null) return false; // not a trial — never touch
    if (o.trial_expiry_warned_at != null) return false; // already warned exactly once
    const t = new Date(o.trial_expires_at).getTime();
    return Number.isFinite(t) && t <= horizon;
  });
}

/** The orgs safe to reap: past (expiry + grace) AND warned at least `grace` days ago. Pure
 *  + the safety gate — a NULL stamp OR an un-warned/too-recently-warned trial is NEVER
 *  reapable, whatever the query returned (warn -> grace -> delete, never a silent delete). */
export function reapableOrgs(orgs: TrialOrg[], graceDays: number, nowMs: number): TrialOrg[] {
  const cutoff = nowMs - Math.max(graceDays, 0) * 86_400_000;
  return orgs.filter((o) => {
    if (o.trial_expires_at == null) return false;
    // Never delete a trial we haven't warned, and only once the warning itself is at
    // least `grace` days old.
    if (o.trial_expiry_warned_at == null) return false;
    const warned = new Date(o.trial_expiry_warned_at).getTime();
    if (!Number.isFinite(warned) || warned >= cutoff) return false;
    const t = new Date(o.trial_expires_at).getTime();
    return Number.isFinite(t) && t < cutoff;
  });
}

/** The warning email: plain, friendly, no product names beyond Cobblr, no real names, no
 *  internal infra names. Points the owner at Configuration -> Backup & Export. Pure. */
export function buildTrialWarningEmail(to: string, o: TrialOrg): AuthEmailMessage {
  const ends = isoDate(o.trial_expires_at);
  const text =
    `Hi,\n\n` +
    `Your Cobblr trial workspace "${o.slug}" is scheduled to end on ${ends}. ` +
    `After that date the workspace and everything in it will be removed.\n\n` +
    `If you want to keep a copy, please export your data before then. In the app, open ` +
    `Configuration and use the Backup & Export feature to download your whole workspace.\n\n` +
    `If you would like to keep using Cobblr, just reply to this email and we will help you ` +
    `carry on.\n\n` +
    `Thanks for trying Cobblr.`;
  return { to, subject: "Your Cobblr trial ends soon", text, kind: "notification" };
}

async function defaultListTrialOrgs(): Promise<TrialOrg[]> {
  const { meta } = await import("../db/meta.js");
  return meta
    .selectFrom("orgs as o")
    .leftJoin("org_memberships as m", (join) =>
      join.onRef("m.org_id", "=", "o.id").on("m.role", "=", "owner"),
    )
    .leftJoin("users as u", "u.id", "m.user_id")
    .select(["o.id", "o.slug", "o.trial_expires_at", "o.trial_expiry_warned_at", "u.email as owner_email"])
    .where("o.trial_expires_at", "is not", null)
    .execute() as Promise<TrialOrg[]>;
}

async function defaultMarkWarned(orgId: string, at: Date): Promise<void> {
  const { meta } = await import("../db/meta.js");
  await meta.updateTable("orgs").set({ trial_expiry_warned_at: at }).where("id", "=", orgId).execute();
}

export interface ReapDeps {
  listTrialOrgs?: () => Promise<TrialOrg[]>;
  deleteOrg?: (orgId: string) => Promise<void>;
  /** Persist the warned-at stamp so a warning is sent exactly once. */
  markWarned?: (orgId: string, at: Date) => Promise<void>;
  /** Is an auth-email sender configured? No sender → skip warnings AND deletions. */
  hasEmailSender?: () => boolean;
  /** Send one email; resolves true iff delivered. */
  sendEmail?: (msg: AuthEmailMessage) => Promise<boolean>;
  now?: number;
  graceDays?: number;
  warnDays?: number;
  maxPerSweep?: number;
}

/** Resolve the auth-email seam + warned-stamp writer, lazily importing the seam module
 *  only when a dep is not injected (keeps unit tests import-clean of ../db/meta). */
async function resolveSeams(deps: ReapDeps): Promise<{
  hasEmailSender: () => boolean;
  sendEmail: (msg: AuthEmailMessage) => Promise<boolean>;
  markWarned: (orgId: string, at: Date) => Promise<void>;
}> {
  const needSeam = !deps.hasEmailSender || !deps.sendEmail;
  const seam = needSeam ? await import("./hosted-seams.js") : null;
  return {
    hasEmailSender: deps.hasEmailSender ?? seam!.hasAuthEmailSender,
    sendEmail: deps.sendEmail ?? seam!.sendAuthEmail,
    markWarned: deps.markWarned ?? defaultMarkWarned,
  };
}

export interface ReapResult {
  mode: ReapMode;
  /** Workspaces eligible for deletion this sweep (past warn + grace). */
  found: number;
  reaped: number;
  /** Warning emails sent this sweep. */
  warned: number;
}

/** One sweep: warn the soon-to-expire, then reap the long-since-expired-and-warned.
 *  Returns what it saw + did. Never throws for a single org — a failed send/teardown is
 *  logged and the sweep continues (resilient, like the boot reconciles). Idempotent: safe
 *  to run every interval (warnings are one-shot via the warned stamp). */
export async function reapExpiredTrials(deps: ReapDeps = {}): Promise<ReapResult> {
  const mode = reapMode();
  if (mode === "off") return { mode, found: 0, reaped: 0, warned: 0 };

  const listTrialOrgs = deps.listTrialOrgs ?? defaultListTrialOrgs;
  const now = deps.now ?? Date.now();
  const graceDays = deps.graceDays ?? reapGraceDays();
  const warnDays = deps.warnDays ?? reapWarnDays();

  const orgs = await listTrialOrgs();
  const seams = await resolveSeams(deps);
  const senderPresent = seams.hasEmailSender();

  // ── WARN PASS — a humane heads-up before anything is ever deleted ──────────────────
  const toWarn = warnableOrgs(orgs, warnDays, now);
  let warned = 0;
  if (toWarn.length > 0) {
    if (mode === "dry") {
      for (const o of toWarn)
        console.log(`[reap-trials] DRY-RUN would warn ${o.slug} (${o.id}) — trial ends ${isoDate(o.trial_expires_at)}`);
      console.log(
        `[reap-trials] DRY-RUN: ${toWarn.length} trial(s) within ${warnDays}d of expiry would be warned` +
          (senderPresent ? "" : " (but NO auth-email sender is configured, so live would send nothing)"),
      );
    } else if (!senderPresent) {
      console.warn(
        `[reap-trials] no auth-email sender configured — cannot warn ${toWarn.length} expiring trial(s); ` +
          `skipping (nothing is deleted until warnings can be sent).`,
      );
    } else {
      for (const o of toWarn) {
        try {
          if (!o.owner_email) {
            console.warn(`[reap-trials] no owner email for ${o.slug} (${o.id}); cannot warn — it will not be reaped`);
            continue;
          }
          const delivered = await seams.sendEmail(buildTrialWarningEmail(o.owner_email, o));
          if (delivered) {
            await seams.markWarned(o.id, new Date(now));
            warned++;
            console.log(`[reap-trials] warned ${o.slug} (${o.id}) — trial ends ${isoDate(o.trial_expires_at)}`);
          } else {
            console.warn(`[reap-trials] warning NOT delivered for ${o.slug} (${o.id}); will retry next sweep`);
          }
        } catch (err) {
          console.error(`[reap-trials] FAILED to warn ${o.slug} (${o.id}):`, (err as Error).message);
        }
      }
    }
  }

  // ── DELETE PASS — only orgs warned ≥ grace ago AND past (expiry + grace) ────────────
  const reapable = reapableOrgs(orgs, graceDays, now);
  if (reapable.length === 0) return { mode, found: 0, reaped: 0, warned };

  if (mode === "dry") {
    for (const o of reapable)
      console.log(
        `[reap-trials] DRY-RUN would reap ${o.slug} (${o.id}) — expired ${isoDate(o.trial_expires_at)}, ` +
          `warned ${isoDate(o.trial_expiry_warned_at)}`,
      );
    console.log(`[reap-trials] DRY-RUN: ${reapable.length} workspace(s) past warn+grace — set COBBLR_TRIAL_REAP=live to enact`);
    return { mode, found: reapable.length, reaped: 0, warned };
  }

  // Humane floor: never delete while we cannot send warnings. (Belt on top of the
  // warned-stamp gate — if the sender was removed after some were warned, still refuse.)
  if (!senderPresent) {
    console.warn(
      `[reap-trials] no auth-email sender configured — refusing to delete ${reapable.length} workspace(s) ` +
        `(humane: don't delete what you couldn't warn).`,
    );
    return { mode, found: reapable.length, reaped: 0, warned };
  }

  // Blast-radius cap: an abnormally large reapable set (a stamp-writing bug, clock skew, a
  // bad backfill) is far more likely a mistake than a real mass expiry. Refuse the whole
  // destructive sweep and force a human `dry` review rather than dropping them all.
  const maxPerSweep = deps.maxPerSweep ?? reapMaxPerSweep();
  if (maxPerSweep > 0 && reapable.length > maxPerSweep) {
    console.error(
      `[reap-trials] REFUSING live sweep: ${reapable.length} workspaces are reapable, over the ` +
        `${maxPerSweep} cap. This is almost certainly a mistake. Review with COBBLR_TRIAL_REAP=dry, ` +
        `then raise COBBLR_TRIAL_REAP_MAX_PER_SWEEP if it's genuinely intended.`,
    );
    return { mode, found: reapable.length, reaped: 0, warned };
  }

  const deleteOrg = deps.deleteOrg ?? (await import("./delete-org.js")).hardDeleteOrg;
  let reaped = 0;
  for (const o of reapable) {
    try {
      await deleteOrg(o.id);
      reaped++;
      console.log(`[reap-trials] reaped expired workspace ${o.slug} (${o.id})`);
    } catch (err) {
      console.error(`[reap-trials] FAILED to reap ${o.slug} (${o.id}):`, (err as Error).message);
    }
  }
  console.log(`[reap-trials] reaped ${reaped}/${reapable.length} expired workspace(s)`);
  return { mode, found: reapable.length, reaped, warned };
}

let timer: NodeJS.Timeout | null = null;

/** Start the periodic sweep. No-op unless COBBLR_TRIAL_REAP is dry|live. Runs one pass
 *  on boot, then every COBBLR_TRIAL_REAP_INTERVAL_MS (default 6h). */
export function startTrialReaper(): void {
  const mode = reapMode();
  if (mode === "off") return;
  if (timer) return; // already running — a second call must not orphan the first interval
  const intervalMs = reapIntervalMs();
  const graceDays = reapGraceDays();
  const warnDays = reapWarnDays();
  // One process only. This one DELETES workspaces, and it emails the warning
  // that precedes the delete; two apis against one database (the canary
  // channel; a rolling deploy) would race the reap and could send the warning
  // twice. The per-org `trial_expiry_warned_at` guard makes the email
  // idempotent even so, but a destructive sweep should not be racing at all.
  const run = () =>
    runExclusive("platform.reap-trials", async () => {
      await reapExpiredTrials();
    }).catch((err) => console.error("[reap-trials] sweep failed:", (err as Error).message));
  void run(); // initial pass at boot
  timer = setInterval(run, intervalMs);
  console.log(
    `[reap-trials] started — mode=${mode}, warn=${warnDays}d before expiry, grace=${graceDays}d, every ${Math.round(intervalMs / 3_600_000)}h`,
  );
}

export function stopTrialReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
