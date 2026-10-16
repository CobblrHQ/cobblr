// Reading a connected mailbox: the pure walk (syncMailbox) and the wrapper
// that runs it for one connection with real tokens, archive and pipeline.
//
// The walk asks the source for matching ids since the cursor (with a day of
// overlap, because two clocks are involved), skips the ones the archive has
// seen, fetches the rest and hands each to the receipt pipeline. It knows
// nothing about Gmail, tokens or tables, which is what lets the guardrail
// tests run it against a fake with in-memory callbacks: the ids it fetches
// ARE the exposure, and a test can read that list.
//
// The wrapper owns the two outcomes that need a person: a grant that died
// (needs_reconnect, one card, then silence until reconnected) and a source
// that has failed for a day (one card; the next round still tries).

import { productName } from "../product-name.js";
import { platform } from "@cobblr/platform-contract";
import { archiveInboundEnvelope, inboundSourceSeen, recordInboundOutcome } from "../inbound-archive.js";
import { ingestReceiptEmail } from "../../routes/receipt-ingest.js";
import { allowedSenders } from "./allowlist.js";
import { GmailSource } from "./gmail.js";
import { refreshGoogleAccess } from "./google-oauth.js";
import { grantFor, mailSourceState, mailSourcesRoutedTo, myMailSources, orgsWithMailSources, writeMailSourceState } from "./store.js";
import { MailSourceGrantError, type MailMessage, type MailSource } from "./types.js";
import { BACKFILL_DAYS, planStopped, syncMailbox, type SyncResult } from "./walk.js";
import { notePassFailure } from "../pass-failures.js";

export { BACKFILL_DAYS, MAX_PER_ROUND, OVERLAP_MS, syncMailbox, type SyncDeps, type SyncResult } from "./walk.js";

export const MAIL_SOURCE_PASS = "mail-source.sync";
export const SYNC_EVERY_MS = 5 * 60_000;

/** A read message into the pipeline: envelope archived (no body), then the
 *  same ingest a forwarded copy gets, with the owner and workspace already
 *  known, then the outcome on the archive row. */
export async function deliverMailMessage(msg: MailMessage, who: { userId: string; orgId: string }, source = "gmail"): Promise<Record<string, unknown>> {
  const archiveId = await archiveInboundEnvelope({
    source,
    source_ref: msg.id,
    ...(msg.from_email ? { from_email: msg.from_email } : {}),
    ...(msg.subject ? { subject: msg.subject } : {}),
    ...(msg.message_id ? { message_id: msg.message_id } : {}),
    org_id: who.orgId,
    user_id: who.userId,
  });
  const out = await ingestReceiptEmail({
    resolved: who,
    source: "gmail",
    ...(msg.from_email ? { from_email: msg.from_email } : {}),
    ...(msg.subject ? { subject: msg.subject } : {}),
    ...(msg.message_id ? { message_id: msg.message_id } : {}),
    ...(msg.text ? { text: msg.text } : {}),
    ...(msg.html ? { html: msg.html } : {}),
    attachments: msg.attachments,
  });
  if (archiveId) {
    await recordInboundOutcome(archiveId, { handler: "receipt", org_id: out.orgId ?? who.orgId, user_id: out.userId ?? who.userId, outcome: out.body });
  }
  return out.body;
}

export interface SyncCredentialOpts {
  credentialId: string;
  ownerUserId: string;
  orgId: string;
  /** A person pressed Check now: a stopped source is tried again. */
  force?: boolean;
  now?: Date;
  /** Test seams. */
  sourceFor?: (accessToken: string) => MailSource;
  refresh?: (refreshToken: string) => Promise<string>;
}

export type SyncOutcome =
  | { ran: true; result: SyncResult }
  | { ran: false; reason: "no_grant" | "needs_reconnect" | "not_due" }
  | { ran: false; reason: "grant_died" | "error"; error: string };

/** One mailbox, for real: tokens, archive, pipeline, state. Never throws;
 *  the state row carries what happened. */
export async function syncCredential(opts: SyncCredentialOpts): Promise<SyncOutcome> {
  const now = opts.now ?? new Date();
  const grant = await grantFor(opts.ownerUserId, opts.credentialId);
  if (!grant) return { ran: false, reason: "no_grant" };
  const state = await mailSourceState(opts.credentialId);
  if (state.status === "needs_reconnect" && !opts.force) return { ran: false, reason: "needs_reconnect" };

  let access: string;
  try {
    access = await (opts.refresh ?? refreshGoogleAccess)(grant.refresh_token);
  // pass-catch: the failure stops the source and is shown on its connection (stopped)
  } catch (err) {
    return await stopped(opts, state, err as Error, now);
  }
  const source = (opts.sourceFor ?? ((t: string) => new GmailSource({ accessToken: t })))(access);
  try {
    const result = await syncMailbox({
      source,
      senders: allowedSenders(grant.extra_senders),
      cursorAt: state.cursor_at,
      now,
      seen: (id) => inboundSourceSeen("gmail", id),
      deliver: (msg) => deliverMailMessage(msg, { userId: opts.ownerUserId, orgId: opts.orgId }).then(() => undefined),
    });
    await writeMailSourceState(opts.credentialId, {
      // A capped round keeps its cursor so the rest is read next round.
      cursor_at: result.more ? state.cursor_at ?? new Date(now.getTime() - BACKFILL_DAYS * 24 * 60 * 60_000) : result.cursorAt,
      last_synced_at: now,
      last_error: null,
      status: "ok",
      messages_seen_delta: result.delivered,
    });
    return { ran: true, result };
  // pass-catch: the failure stops the source and is shown on its connection (stopped)
  } catch (err) {
    return await stopped(opts, state, err as Error, now);
  }
}

/** Record why a sync did not finish, and tell the person once when it is
 *  theirs to fix or has been failing for a day. */
async function stopped(opts: SyncCredentialOpts, state: Awaited<ReturnType<typeof mailSourceState>>, err: Error, now: Date): Promise<SyncOutcome> {
  const grantDied = err instanceof MailSourceGrantError;
  const message = (err.message || String(err)).slice(0, 300);
  const failingSince = state.last_synced_at ?? state.cursor_at ?? now;
  const { status, tell } = planStopped(state, grantDied, now);
  await writeMailSourceState(opts.credentialId, {
    last_error: message,
    status,
    ...(tell ? { stopped_notified_at: now } : {}),
  });
  if (tell) {
    try {
      await platform().notifications.dispatch({
        orgId: opts.orgId,
        userId: opts.ownerUserId,
        eventType: "platform.mail_source.stopped",
        message: grantDied
          ? "Gmail stopped: reconnect to keep your orders tracking themselves."
          : `Gmail has not answered since ${failingSince.toISOString().slice(0, 16).replace("T", " ")}. ${productName()} keeps trying.`,
        // PAGE-LINK: a mailbox connection has no record of its own; the card lives on /me/connections
        link_url: "/me/connections",
        card: {
          heading: grantDied ? "Gmail needs reconnecting" : "Gmail is not answering",
          body: grantDied ? "The grant ended on Google's side. One click on Connections puts it back." : message,
        },
        payload: { credential_id: opts.credentialId, reason: grantDied ? "grant" : "error" },
      });
    } catch (e) {
      notePassFailure("mail-source.stopped-card", opts.credentialId, e);
      console.error("[mail-source] stopped card failed:", (e as Error).message);
    }
  }
  return grantDied ? { ran: false, reason: "grant_died", error: message } : { ran: false, reason: "error", error: message };
}

/** Replay of an archived, body-less message: fetched again from the mailbox
 *  it was read from (it is still there) and run through the pipeline. The
 *  forwarding door replays from its raw copy; this door keeps none. */
export async function replayFromMailbox(archive: { source: string; source_ref: string; user_id: string | null; org_id: string | null }): Promise<Record<string, unknown> | { error: string }> {
  if (archive.source !== "gmail") return { error: `no replay for source ${archive.source}` };
  if (!archive.user_id || !archive.org_id) return { error: "archived without an owner" };
  const mine = (await myMailSources(archive.user_id)).filter((m) => m.org_ids.includes(archive.org_id!));
  for (const m of mine) {
    const grant = await grantFor(archive.user_id, m.id);
    if (!grant) continue;
    try {
      const access = await refreshGoogleAccess(grant.refresh_token);
      const msg = await new GmailSource({ accessToken: access }).fetch(archive.source_ref);
      if (!msg) return { error: "the mailbox no longer has it" };
      return await deliverMailMessage(msg, { userId: archive.user_id, orgId: archive.org_id });
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  return { error: "no connected mailbox holds it" };
}

/** The workspace visit: every approved mailbox routed in, one after another. */
export async function visitWorkspaceMailSources(orgId: string, now: Date): Promise<{ synced: number; delivered: number; more: boolean }> {
  const routed = (await mailSourcesRoutedTo(orgId)).filter((r) => r.approved);
  let synced = 0;
  let delivered = 0;
  let more = false;
  for (const r of routed) {
    const out = await syncCredential({ credentialId: r.credentialId, ownerUserId: r.ownerUserId, orgId, now });
    if (out.ran) {
      synced += 1;
      delivered += out.result.delivered;
      more = more || out.result.more;
    }
  }
  return { synced, delivered, more };
}

/** The pass. Registered at boot beside every other cross-workspace pass, so
 *  it shares the walk and the connection budget (#3036) and owns no timer. */
export function registerMailSourceSweep(): void {
  platform().sweeps.register({
    name: MAIL_SOURCE_PASS,
    everyMs: SYNC_EVERY_MS,
    drainMs: 60_000,
    candidates: async (orgIds) => {
      const withSources = await orgsWithMailSources();
      return orgIds.filter((id) => withSources.has(id));
    },
    visit: async ({ orgId, now }) => {
      const out = await visitWorkspaceMailSources(orgId, now);
      return { backlog: out.more };
    },
  });
  console.log(`[mail-source] sweep registered — every ${SYNC_EVERY_MS / 60_000} min`);
}
