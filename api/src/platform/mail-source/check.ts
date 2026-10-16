// "Check my mailbox" (#5462): the order-email classifier run over a person's
// whole mailbox, filing nothing, so they can see what it would do before any
// live filing turns on.
//
// The walk is pure (checkPage): ask the source for one page of the candidate
// query, read each message, decide it, and hand back the decisions. It has no
// door to the receipt pipeline and none to a model: an email nothing decides
// is reported "ask-ai" ("would ask AI") and left there (check-walk.ts). The runner
// keeps the page token on the check, so a restart resumes where it was, and
// stores per message only the id, when, the sender, the subject and the
// decision. No body leaves memory.

import { productName } from "../product-name.js";
import { meta } from "../../db/meta.js";
import { runExclusive } from "../exclusive.js";
import { notePassFailure } from "../pass-failures.js";
import { checkPage, type CheckSource } from "./check-walk.js";
import { GmailSource } from "./gmail.js";
import { refreshGoogleAccess } from "./google-oauth.js";
import { grantFor } from "./store.js";
import { MailSourceGrantError } from "./types.js";

/** Pages one check reads per round: 100 messages a page, five quota units a
 *  message, so a round stays well under Gmail's per-user rate. */
export const PAGES_PER_ROUND = 2;
const TICK_MS = 20_000;

export interface CheckRoundDeps {
  sourceFor?: (accessToken: string) => CheckSource;
  refresh?: (refreshToken: string) => Promise<string>;
  now?: Date;
}

/** Advance one running check by up to PAGES_PER_ROUND pages. */
export async function runCheckRound(checkId: string, deps: CheckRoundDeps = {}): Promise<{ status: string; added: number }> {
  const check = await meta.selectFrom("mailbox_checks").selectAll().where("id", "=", checkId).executeTakeFirst();
  if (!check || check.status !== "running") return { status: check?.status ?? "missing", added: 0 };
  const fail = async (status: "failed", message: string) => {
    await meta.updateTable("mailbox_checks").set({ status, last_error: message.slice(0, 300), updated_at: new Date(), finished_at: new Date() }).where("id", "=", checkId).execute();
    return { status, added: 0 };
  };
  const grant = await grantFor(check.user_id, check.credential_id);
  if (!grant) return fail("failed", "The Gmail connection is gone. Connect Gmail again, then check again.");
  let access: string;
  try {
    access = await (deps.refresh ?? refreshGoogleAccess)(grant.refresh_token);
  } catch (err) {
    notePassFailure("mail-source.check", checkId, err);
    return fail("failed", `Gmail would not let ${productName()} in. Reconnect Gmail, then check again.`);
  }
  const source = (deps.sourceFor ?? ((t: string) => new GmailSource({ accessToken: t, attachments: false })))(access);
  const verdicts = new Map(
    (await meta.selectFrom("mailbox_sender_verdicts").select(["sender_domain", "verdict"]).where("user_id", "=", check.user_id).execute()).map((r) => [r.sender_domain, r.verdict]),
  );
  let token = check.page_token;
  let added = 0;
  for (let i = 0; i < PAGES_PER_ROUND; i++) {
    let page: Awaited<ReturnType<typeof checkPage>>;
    try {
      page = await checkPage({ source, query: check.query, pageToken: token, remembered: (d) => verdicts.get(d) ?? null, ...(deps.now ? { now: deps.now } : {}) });
    } catch (err) {
      notePassFailure("mail-source.check", checkId, err);
      if (err instanceof MailSourceGrantError) return fail("failed", `Gmail would not let ${productName()} in. Reconnect Gmail, then check again.`);
      // A quota answer or a network blip: keep the page token and let the next round try.
      await meta.updateTable("mailbox_checks").set({ last_error: (err as Error).message.slice(0, 300), updated_at: new Date() }).where("id", "=", checkId).execute();
      return { status: "running", added };
    }
    if (page.messages.length) {
      await meta
        .insertInto("mailbox_check_items")
        .values(page.messages.map((m) => ({
          check_id: checkId,
          gmail_id: m.gmail_id,
          received_at: m.received_at,
          sender: m.sender,
          sender_domain: m.sender_domain,
          subject: m.subject,
          purchases_label: m.purchases_label,
          verdict: m.decision.verdict,
          decided_by: m.decision.by,
          strength: m.decision.strength,
          platform: m.decision.signals.platform,
          found: JSON.stringify({ ...m.decision.found, signals: m.decision.signals }),
        })))
        .onConflict((oc) => oc.columns(["check_id", "gmail_id"]).doNothing())
        .execute();
      added += page.messages.length;
    }
    token = page.nextPageToken;
    const done = !token;
    await meta
      .updateTable("mailbox_checks")
      .set((eb) => ({
        page_token: token,
        pages: eb("pages", "+", 1),
        seen: eb("seen", "+", page.messages.length),
        last_error: null,
        updated_at: new Date(),
        ...(done ? { status: "done" as const, finished_at: new Date() } : {}),
      }))
      .where("id", "=", checkId)
      .execute();
    if (done) return { status: "done", added };
  }
  return { status: "running", added };
}

let handle: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Every 20 s, the running checks move on a few pages each. One process at a
 *  time: the page token is the shared cursor, and two processes reading the
 *  same page would only double the quota spent. */
export function startMailboxCheckRunner(): void {
  if (handle) clearInterval(handle);
  handle = setInterval(() => void tick(), TICK_MS);
  console.log("[mail-source] mailbox check runner started");
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // SKIP-IF-BUSY OK: a timer tick; the holder advances the checks, the next tick takes what is left
    await runExclusive("mail-source.check", async () => {
      const running = await meta.selectFrom("mailbox_checks").select("id").where("status", "=", "running").orderBy("updated_at").limit(3).execute();
      for (const r of running) {
        try {
          await runCheckRound(r.id);
        } catch (err) {
          notePassFailure("mail-source.check", r.id, err);
        }
      }
    });
  } catch (err) {
    notePassFailure("mail-source.check", null, err);
  } finally {
    ticking = false;
  }
}
