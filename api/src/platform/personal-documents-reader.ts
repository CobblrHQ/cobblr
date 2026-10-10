// Who reads a workspace's personal documents (#5621): on this machine only
// (the default, the owner's rule from #5243), or one cloud connection the
// workspace already uses, named, after its owner consents in words that name
// the company the documents go to. Read by the router (ai.ts), the AI page
// and the assistant (get_workspace_setup, part "ai"); changed only by a
// workspace owner on the AI page. The assistant may read it and never turn
// the cloud on: consent is a person's click.

import { AI_JOBS, aiCapabilityChain } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import * as aiImpl from "./ai.js";
import * as activity from "./activity.js";
import { namable } from "./workspace-ai-defaults.js";
import { personalDocumentsReader } from "./personal-documents-reader-store.js";

export { personalDocumentsReader, type PersonalDocumentsReader } from "./personal-documents-reader-store.js";

const PERSONAL = AI_JOBS.find((j) => j.id === "personal")!;

/** The sentence a person agrees to, naming where the documents go. */
export function consentSentence(company: string): string {
  return `Personal documents (IDs, bills, registrations) from this workspace will be sent to ${company} to be read.`;
}

const companyOf = (providerId: string): string => {
  const def = aiImpl.getProvider(providerId);
  return def?.company ?? def?.label ?? providerId;
};
const readsDocuments = (providerId: string): boolean => {
  const def = aiImpl.getProvider(providerId);
  return !!def && aiCapabilityChain(PERSONAL.shows).some((cap) => !!def.capabilities[cap]);
};

export interface PersonalDocumentsReaderView {
  reader: { kind: "local" } | { kind: "cloud"; connection: string; label: string; company: string; consented_by: string | null; consented_at: string; consent: string };
  /** A local model this workspace can use to read what code could not. */
  local_ai: boolean;
  /** Only a workspace owner changes who reads personal documents. */
  can_change: boolean;
  /** The cloud connections an owner may choose, each with the sentence to
   *  agree to. Background work must be able to use it too, so a "Just me"
   *  connection is not offered. */
  choices: Array<{ connection: string; label: string; company: string; consent: string }>;
}

export async function personalDocumentsReaderView(orgId: string, userId: string | null, role: string | null): Promise<PersonalDocumentsReaderView> {
  const [row, conns] = await Promise.all([
    meta
      .selectFrom("org_personal_documents_reader as r")
      .leftJoin("users as u", "u.id", "r.consented_by")
      .select(["r.connection", "r.provider_id", "r.consented_at", "r.consent_text", "u.display_name"])
      .where("r.org_id", "=", orgId)
      .executeTakeFirst()
      .catch(() => undefined),
    namable(orgId, userId).catch(() => []),
  ]);
  const local_ai = conns.some((c) => aiImpl.getProvider(c.providerId)?.locality === "local" && readsDocuments(c.providerId));
  const choices = conns
    .filter((c) => !c.justYou && aiImpl.getProvider(c.providerId)?.locality !== "local" && readsDocuments(c.providerId))
    .map((c) => ({ connection: c.key, label: c.label, company: companyOf(c.providerId), consent: consentSentence(companyOf(c.providerId)) }));
  const reader: PersonalDocumentsReaderView["reader"] = row
    ? {
        kind: "cloud",
        connection: row.connection,
        label: conns.find((c) => c.key === row.connection)?.label ?? aiImpl.getProvider(row.provider_id)?.label ?? row.provider_id,
        company: companyOf(row.provider_id),
        consented_by: row.display_name ?? null,
        consented_at: new Date(row.consented_at).toISOString(),
        consent: row.consent_text,
      }
    : { kind: "local" };
  const can_change = role === "owner";
  return { reader, local_ai, can_change, choices: can_change ? choices : [] };
}

/** Back to this machine only, or one consented cloud connection. The
 *  consent must be the sentence the page showed, word for word: a client
 *  that never showed it cannot turn the cloud on. Said in the activity feed. */
export async function setPersonalDocumentsReader(
  orgId: string,
  userId: string,
  choice: { connection: "local" } | { connection: string; consent: string },
): Promise<{ ok: false; refusal: string } | { ok: true }> {
  const before = await personalDocumentsReader(orgId);
  const beforeLabel = before ? await labelOf(orgId, userId, before.connection, before.providerId) : "this machine only";
  if (choice.connection === "local") {
    await meta.deleteFrom("org_personal_documents_reader").where("org_id", "=", orgId).execute();
    await logChange(orgId, userId, beforeLabel, "this machine only");
    return { ok: true };
  }
  const view = await personalDocumentsReaderView(orgId, userId, "owner");
  const offered = view.choices.find((c) => c.connection === choice.connection);
  if (!offered) return { ok: false, refusal: "That connection can't read personal documents for this workspace. Choose a cloud connection the workspace shares, or this machine only." };
  if (!("consent" in choice) || choice.consent !== offered.consent) {
    return { ok: false, refusal: `To send personal documents to ${offered.company}, agree to: "${offered.consent}"` };
  }
  const providerId = (await namable(orgId, userId)).find((c) => c.key === choice.connection)!.providerId;
  await meta
    .insertInto("org_personal_documents_reader")
    .values({ org_id: orgId, connection: choice.connection, provider_id: providerId, consented_by: userId, consent_text: offered.consent })
    .onConflict((oc) => oc.column("org_id").doUpdateSet({ connection: choice.connection, provider_id: providerId, consented_by: userId, consented_at: new Date(), consent_text: offered.consent }))
    .execute();
  await logChange(orgId, userId, beforeLabel, `${offered.label} (${offered.company})`);
  return { ok: true };
}

async function labelOf(orgId: string, userId: string, connection: string, providerId: string): Promise<string> {
  const hit = (await namable(orgId, userId).catch(() => [])).find((c) => c.key === connection);
  return `${hit?.label ?? aiImpl.getProvider(providerId)?.label ?? providerId} (${companyOf(providerId)})`;
}

async function logChange(orgId: string, userId: string, from: string, to: string): Promise<void> {
  try {
    await activity.log({
      orgId,
      userId,
      action: "personal_documents_reader_changed",
      ref: { module: null, entityType: "personal_documents_reader", entityId: orgId },
      diff: { name: "who reads personal documents", from, to },
    });
  } catch (err) {
    console.error("[personal-documents-reader] activity log failed:", (err as Error).message);
  }
}
